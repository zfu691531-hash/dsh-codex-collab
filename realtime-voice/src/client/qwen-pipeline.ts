import type { VoicePrefs } from './prefs.ts'
import type { RealtimeCallbacks } from './realtime.ts'
import type { TurnPhase } from './turn-coordinator.ts'

export class QwenPipelineConnection {
  private asr?: WebSocket
  private tts?: WebSocket
  private microphone?: MediaStream
  private captureContext?: AudioContext
  private captureSource?: MediaStreamAudioSourceNode
  private processor?: ScriptProcessorNode
  private silentGain?: GainNode
  private readonly player = new PcmPlayer()
  private ttsReady?: Promise<void>
  private resolveTtsReady?: () => void
  private rejectTtsReady?: (error: Error) => void
  private speechResolve?: () => void
  private speechReject?: (error: Error) => void
  private disposed = false
  private speechAudible = false
  private currentSpeechText = ''
  private inputPhase: TurnPhase = 'listening'
  private readonly bargeInGate = new LocalBargeInGate()
  private bargeInCandidate = false
  private bargeInTimer?: ReturnType<typeof setTimeout>
  private ttsStartedAt = 0
  private ttsInterruptedForBargeIn = false
  private asrEventTail = Promise.resolve()
  private readonly quarantinedItems = new Set<string>()
  private readonly ignoredItems = new Set<string>()
  private readonly utteranceBusy = new Map<string, boolean>()
  private asrRestarting = false
  private asrContaminated = false

  constructor(private readonly prefs: VoicePrefs, private readonly callbacks: RealtimeCallbacks) {}

  async connect(): Promise<void> {
    this.callbacks.onState('connecting')
    if (this.prefs.qwenWorkspaceId.trim() === '') throw new Error('请先在插件设置中填写阿里云百炼 Workspace ID')
    if (navigator.mediaDevices?.getUserMedia === undefined) throw new Error('当前页面无法访问麦克风，请用 Chrome 打开此 Harness 地址')
    this.microphone = await navigator.mediaDevices.getUserMedia({
      // AGC makes distant people louder and caused false turns in a shared
      // room. Keep AEC/NS but prefer a near-field speaker by leaving gain
      // unamplified; users can lower the VAD threshold for quiet microphones.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
    })
    await this.openTts()
    await this.openAsr()
    this.startCapture()
  }

  async speak(text: string): Promise<void> {
    const chunks = splitForTts(text)
    if (chunks.length === 0 || this.disposed) return
    if (this.tts?.readyState !== WebSocket.OPEN) await this.openTts()
    await this.ttsReady
    if (this.disposed || this.tts?.readyState !== WebSocket.OPEN) throw new Error('千问 TTS 连接已关闭')
    this.currentSpeechText = joinSpeechText(this.currentSpeechText, text)
    for (const chunk of chunks) {
      await new Promise<void>((resolve, reject) => {
        this.speechResolve = resolve
        this.speechReject = reject
        this.sendTts({ type: 'input_text_buffer.append', event_id: eventId(), text: chunk })
        this.sendTts({ type: 'input_text_buffer.commit', event_id: eventId() })
      })
    }
  }

  async waitForSpeechIdle(): Promise<void> {
    await this.player.waitUntilIdle()
    this.speechAudible = false
    this.currentSpeechText = ''
  }

  setInputPhase(phase: TurnPhase): void {
    if (this.inputPhase === phase) return
    this.inputPhase = phase
    if (phase === 'tts-speaking') {
      this.ttsStartedAt = Date.now()
      this.ttsInterruptedForBargeIn = false
      this.resetBargeIn(false)
      return
    }
    if (phase === 'post-playback') {
      if (this.bargeInCandidate) this.rejectFalseBargeIn()
      else {
        this.resetBargeIn(true)
        if (this.asrContaminated) this.restartAsr()
      }
      return
    }
    if (phase === 'listening' || phase === 'harness' || phase === 'tts-pending') this.resetBargeIn(false)
  }

  disconnect(): void {
    this.disposed = true
    this.player.dispose()
    this.processor?.disconnect()
    this.captureSource?.disconnect()
    this.silentGain?.disconnect()
    void this.captureContext?.close()
    this.microphone?.getTracks().forEach(track => track.stop())
    finishAndClose(this.asr)
    finishAndClose(this.tts)
    this.asr = undefined
    this.tts = undefined
    this.speechReject?.(new Error('语音连接已关闭'))
    this.speechResolve = undefined
    this.speechReject = undefined
    this.speechAudible = false
    this.currentSpeechText = ''
    this.resetBargeIn(false)
    this.quarantinedItems.clear()
    this.ignoredItems.clear()
    this.utteranceBusy.clear()
  }

  private async openAsr(): Promise<void> {
    const socket = new WebSocket(proxyUrl('asr', this.prefs.qwenWorkspaceId, this.prefs.qwenRegion, this.prefs.qwenAsrModel))
    this.asr = socket
    await opened(socket)
    socket.onmessage = event => {
      this.asrEventTail = this.asrEventTail.then(() => this.handleAsr(event.data), () => this.handleAsr(event.data))
    }
    socket.onerror = () => this.callbacks.onState('error', '千问专用 ASR 连接失败')
    socket.onclose = () => {
      if (this.asr !== socket) return
      this.asr = undefined
      if (!this.disposed) this.callbacks.onState('error', '千问专用 ASR 已断开')
    }
    this.sendAsr({
      type: 'session.update',
      event_id: eventId(),
      session: {
        input_audio_format: 'pcm',
        sample_rate: 16000,
        input_audio_transcription: { language: 'zh' },
        turn_detection: {
          type: 'server_vad',
          threshold: this.prefs.qwenVadThreshold,
          silence_duration_ms: this.prefs.qwenSilenceMs,
        },
      },
    })
  }

  private async openTts(): Promise<void> {
    if (this.tts?.readyState === WebSocket.OPEN || this.tts?.readyState === WebSocket.CONNECTING) return await this.ttsReady
    this.ttsReady = new Promise<void>((resolve, reject) => {
      this.resolveTtsReady = resolve
      this.rejectTtsReady = reject
    })
    const socket = new WebSocket(proxyUrl('tts', this.prefs.qwenWorkspaceId, this.prefs.qwenRegion, this.prefs.qwenTtsModel))
    this.tts = socket
    // Qwen may emit session.created immediately after the WebSocket opens.
    // Install handlers first or a fast connection can miss that first event
    // and leave the UI stuck in "connecting" forever.
    socket.onmessage = event => this.handleTts(event.data)
    socket.onerror = () => this.rejectTtsReady?.(new Error('千问专用 TTS 连接失败'))
    socket.onclose = () => {
      if (this.tts !== socket) return
      this.tts = undefined
      this.speechReject?.(new Error('千问专用 TTS 已断开'))
      this.speechResolve = undefined
      this.speechReject = undefined
    }
    await opened(socket)
    await this.ttsReady
  }

  private startCapture(): void {
    if (this.microphone === undefined) return
    const context = new AudioContext()
    const source = context.createMediaStreamSource(this.microphone)
    const processor = context.createScriptProcessor(2048, 1, 1)
    const silent = context.createGain()
    silent.gain.value = 0
    processor.onaudioprocess = event => {
      if (this.asr?.readyState !== WebSocket.OPEN) return
      const pcm = downsampleToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate, 16000)
      if (pcm.byteLength === 0 || this.asr.bufferedAmount > 512 * 1024) return
      if (this.inputPhase === 'post-playback') return
      if (this.inputPhase === 'tts-speaking') {
        if (!this.speechAudible && !this.player.isPlaying) return
        const decision = this.bargeInGate.push(pcm, Date.now() - this.ttsStartedAt)
        if (!decision.forward) return
        if (!this.bargeInCandidate) {
          this.bargeInCandidate = true
          this.asrContaminated = true
          this.player.pause()
          this.bargeInTimer = setTimeout(() => this.rejectFalseBargeIn(), 2_200)
          for (const frame of decision.preRoll) this.appendAsr(frame)
          return
        }
      } else {
        this.bargeInGate.observe(pcm)
      }
      this.appendAsr(pcm)
    }
    source.connect(processor)
    processor.connect(silent)
    silent.connect(context.destination)
    this.captureContext = context
    this.captureSource = source
    this.processor = processor
    this.silentGain = silent
  }

  private async handleAsr(raw: unknown): Promise<void> {
    const event = jsonEvent(raw)
    if (event === undefined) return
    const type = event.type
    if (type === 'session.updated') this.callbacks.onState('listening')
    if (type === 'input_audio_buffer.speech_started') {
      const itemId = typeof event.item_id === 'string' ? event.item_id : ''
      if (itemId !== '') {
        this.utteranceBusy.set(itemId, this.inputPhase !== 'listening' && this.inputPhase !== 'endpoint-candidate')
        if (this.bargeInCandidate) this.quarantinedItems.add(itemId)
      }
    }
    if (type === 'conversation.item.input_audio_transcription.text' && this.bargeInCandidate) {
      const confirmed = typeof event.text === 'string' ? event.text : ''
      const stash = typeof event.stash === 'string' ? event.stash : ''
      const preview = `${confirmed}${stash}`.trim()
      if (isExplicitBargeIn(normalizeSpeech(preview)) && !isLikelyTtsEcho(preview, this.currentSpeechText)) this.interruptTts()
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : ''
      const itemId = typeof event.item_id === 'string' ? event.item_id : ''
      const capturedWhileBusy = itemId !== ''
        ? (this.utteranceBusy.get(itemId) ?? (this.inputPhase !== 'listening' && this.inputPhase !== 'endpoint-candidate'))
        : (this.inputPhase !== 'listening' && this.inputPhase !== 'endpoint-candidate')
      if (itemId !== '') this.utteranceBusy.delete(itemId)
      if (itemId !== '' && this.ignoredItems.delete(itemId)) return
      const quarantined = this.bargeInCandidate || (itemId !== '' && this.quarantinedItems.delete(itemId))
      if (quarantined && (!isActionableTranscript(transcript) || isLikelyTtsEcho(transcript, this.currentSpeechText))) {
        this.rejectFalseBargeIn()
        return
      }
      if (!isActionableTranscript(transcript)) return
      if (quarantined) this.interruptTts()
      if (this.inputPhase === 'post-playback' && !quarantined) return
      await this.callbacks.onTranscript?.(transcript, { capturedWhileBusy })
    }
    if (type === 'error') this.callbacks.onState('error', safeError(event))
  }

  private handleTts(raw: unknown): void {
    const event = jsonEvent(raw)
    if (event === undefined) return
    if (event.type === 'session.created') {
      this.sendTts({
        type: 'session.update',
        event_id: eventId(),
        session: {
          voice: this.prefs.qwenTtsVoice,
          mode: 'commit',
          language_type: 'Chinese',
          response_format: 'pcm',
          sample_rate: 24000,
        },
      })
    }
    if (event.type === 'session.updated') {
      this.resolveTtsReady?.()
      this.resolveTtsReady = undefined
      this.rejectTtsReady = undefined
    }
    if (event.type === 'response.audio.delta' && typeof event.delta === 'string') {
      if (!this.speechAudible) {
        this.speechAudible = true
        this.callbacks.onState('speaking')
      }
      this.player.enqueue(event.delta, 24000)
    }
    if (event.type === 'response.done') {
      this.speechResolve?.()
      this.speechResolve = undefined
      this.speechReject = undefined
    }
    if (event.type === 'error') {
      const error = new Error(safeError(event))
      this.rejectTtsReady?.(error)
      this.speechReject?.(error)
      this.speechResolve = undefined
      this.speechReject = undefined
    }
  }

  private isTtsActive(): boolean {
    return this.speechAudible || this.player.isPlaying
  }

  private interruptTts(): void {
    if (this.ttsInterruptedForBargeIn) return
    this.ttsInterruptedForBargeIn = true
    this.player.stop()
    const rejectSpeech = this.speechReject
    this.speechResolve = undefined
    this.speechReject = undefined
    rejectSpeech?.(new Error('语音播放已被用户打断'))
    const socket = this.tts
    if (socket !== undefined) socket.close(1000, 'barge-in')
    this.tts = undefined
    this.ttsReady = undefined
    this.speechAudible = false
    this.currentSpeechText = ''
    this.resetBargeIn(false)
    if (!this.disposed) void this.openTts().catch(error => this.callbacks.onState('error', error instanceof Error ? error.message : String(error)))
  }

  private rejectFalseBargeIn(): void {
    if (!this.bargeInCandidate) return
    for (const itemId of this.quarantinedItems) this.ignoredItems.add(itemId)
    this.quarantinedItems.clear()
    this.resetBargeIn(true)
    this.restartAsr()
  }

  private resetBargeIn(resume: boolean): void {
    if (this.bargeInTimer !== undefined) clearTimeout(this.bargeInTimer)
    this.bargeInTimer = undefined
    this.bargeInCandidate = false
    this.bargeInGate.reset()
    if (resume) this.player.resume()
  }

  private appendAsr(pcm: Int16Array): void {
    this.sendAsr({ type: 'input_audio_buffer.append', event_id: eventId(), audio: base64(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)) })
  }

  private restartAsr(): void {
    if (this.disposed || this.asrRestarting) return
    this.asrRestarting = true
    this.asrContaminated = false
    const socket = this.asr
    this.asr = undefined
    socket?.close(1000, 'reset contaminated input')
    void this.openAsr().catch(error => {
      if (!this.disposed) this.callbacks.onState('error', error instanceof Error ? error.message : String(error))
    }).finally(() => { this.asrRestarting = false })
  }

  private sendAsr(event: unknown): void { this.asr?.send(JSON.stringify(event)) }
  private sendTts(event: unknown): void { this.tts?.send(JSON.stringify(event)) }
}

export function isLikelyTtsEcho(transcript: string, speech: string): boolean {
  const heard = normalizeSpeech(transcript)
  const spoken = normalizeSpeech(speech)
  if (heard.length < 3 || spoken.length < 3 || isExplicitBargeIn(heard)) return false
  if (spoken.includes(heard)) return true
  if (heard.length >= 6 && heard.includes(spoken)) return true
  const shorter = Math.min(heard.length, spoken.length)
  const longer = Math.max(heard.length, spoken.length)
  if (shorter / longer < 0.25) return false
  if (longestCommonSubstring(heard, spoken) / shorter >= 0.72) return true
  return bigramDice(heard, spoken) >= 0.62
}

function isExplicitBargeIn(normalized: string): boolean {
  return /^(停|停止|停下|打住|别说了|等一下|等等|不对|取消|取消任务|不要了|算了)$/.test(normalized)
}

function normalizeSpeech(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function joinSpeechText(existing: string, addition: string): string {
  const clean = addition.trim()
  return existing === '' ? clean : clean === '' ? existing : `${existing} ${clean}`
}

function longestCommonSubstring(left: string, right: string): number {
  const row = new Uint16Array(right.length + 1)
  let longest = 0
  for (let i = 1; i <= left.length; i++) {
    for (let j = right.length; j >= 1; j--) {
      const value = left.charAt(i - 1) === right.charAt(j - 1) ? (row[j - 1] ?? 0) + 1 : 0
      row[j] = value
      if (value > longest) longest = value
    }
  }
  return longest
}

function bigramDice(left: string, right: string): number {
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0
  const counts = new Map<string, number>()
  for (let index = 0; index < left.length - 1; index++) {
    const gram = left.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  let overlap = 0
  for (let index = 0; index < right.length - 1; index++) {
    const gram = right.slice(index, index + 2)
    const count = counts.get(gram) ?? 0
    if (count <= 0) continue
    overlap++
    counts.set(gram, count - 1)
  }
  return (2 * overlap) / (left.length + right.length - 2)
}

export class LocalBargeInGate {
  private noiseFloor = 0.006
  private activeMs = 0
  private candidate = false
  private bufferedMs = 0
  private frames: Array<{ pcm: Int16Array; durationMs: number }> = []

  observe(pcm: Int16Array): void {
    const level = pcmRms(pcm)
    if (level < 0.05) this.noiseFloor = (this.noiseFloor * 0.98) + (level * 0.02)
  }

  push(pcm: Int16Array, playbackElapsedMs: number): { forward: boolean; preRoll: Int16Array[] } {
    const durationMs = (pcm.length / 16_000) * 1_000
    this.frames.push({ pcm: pcm.slice(), durationMs })
    this.bufferedMs += durationMs
    while (this.bufferedMs > 850 && this.frames.length > 1) {
      const removed = this.frames.shift()
      if (removed !== undefined) this.bufferedMs -= removed.durationMs
    }
    if (this.candidate) return { forward: true, preRoll: [] }
    // The first playback frames are the most likely to leak through AEC. This
    // mirrors mature realtime stacks that require some audible output before
    // accepting barge-in.
    if (playbackElapsedMs < 350) return { forward: false, preRoll: [] }
    const threshold = Math.max(0.018, this.noiseFloor * 3.2)
    const level = pcmRms(pcm)
    this.activeMs = level >= threshold ? this.activeMs + durationMs : Math.max(0, this.activeMs - (durationMs * 1.5))
    if (this.activeMs < 500) return { forward: false, preRoll: [] }
    this.candidate = true
    return { forward: true, preRoll: this.frames.map(frame => frame.pcm) }
  }

  reset(): void {
    this.activeMs = 0
    this.candidate = false
    this.bufferedMs = 0
    this.frames = []
  }
}

function pcmRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (let index = 0; index < pcm.length; index++) {
    const value = (pcm[index] ?? 0) / 32768
    sum += value * value
  }
  return Math.sqrt(sum / pcm.length)
}

class PcmPlayer {
  private context?: AudioContext
  private gain?: GainNode
  private nextStart = 0
  private sources = new Set<AudioBufferSourceNode>()
  private idleWaiters: Array<() => void> = []
  private paused = false

  get isPlaying(): boolean { return this.sources.size > 0 }

  enqueue(encoded: string, sampleRate: number): void {
    const bytes = fromBase64(encoded)
    if (bytes.byteLength < 2) return
    const context = this.context ??= new AudioContext()
    if (this.gain === undefined) {
      this.gain = context.createGain()
      this.gain.connect(context.destination)
    }
    const samples = new Float32Array(Math.floor(bytes.byteLength / 2))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768
    const buffer = context.createBuffer(1, samples.length, sampleRate)
    buffer.copyToChannel(samples, 0)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)
    const start = Math.max(context.currentTime + 0.02, this.nextStart)
    source.start(start)
    this.nextStart = start + buffer.duration
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      this.resolveIdle()
    }
  }

  duck(enabled: boolean): void {
    if (this.gain !== undefined && this.context !== undefined) {
      this.gain.gain.setTargetAtTime(enabled ? 0.25 : 1, this.context.currentTime, 0.03)
    }
  }

  pause(): void {
    if (this.context === undefined || this.paused) return
    this.paused = true
    void this.context.suspend()
  }

  resume(): void {
    if (this.context === undefined || !this.paused) return
    this.paused = false
    void this.context.resume()
  }

  stop(): void {
    this.resume()
    for (const source of this.sources) { try { source.stop() } catch { /* already stopped */ } }
    this.sources.clear()
    this.nextStart = 0
    this.duck(false)
    this.resolveIdle()
  }

  async waitUntilIdle(): Promise<void> {
    if (this.sources.size === 0) return
    await new Promise<void>(resolve => this.idleWaiters.push(resolve))
  }

  private resolveIdle(): void {
    if (this.sources.size !== 0) return
    this.idleWaiters.splice(0).forEach(resolve => resolve())
  }

  dispose(): void { this.stop(); void this.context?.close(); this.context = undefined; this.gain = undefined; this.paused = false }
}

function proxyUrl(kind: 'asr' | 'tts', workspaceId: string, region: string, model: string): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const query = new URLSearchParams({ workspaceId, region, model })
  return `${protocol}//${location.host}/dsh-realtime-voice/${kind}/qwen?${query}`
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('本地语音代理连接失败')), { once: true })
  })
}

function finishAndClose(socket?: WebSocket): void {
  if (socket?.readyState !== WebSocket.OPEN) return socket?.close()
  socket.send(JSON.stringify({ type: 'session.finish', event_id: eventId() }))
  setTimeout(() => socket.close(1000, 'finished'), 200)
}

function jsonEvent(raw: unknown): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as unknown
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

function safeError(event: Record<string, unknown>): string {
  const error = typeof event.error === 'object' && event.error !== null ? event.error as Record<string, unknown> : event
  return typeof error.message === 'string' ? error.message.slice(0, 300) : '语音服务错误'
}

function eventId(): string { return `event_${crypto.randomUUID()}` }

function isActionableTranscript(text: string): boolean {
  const normalized = text.replace(/[\s，。！？,.!?、]/g, '')
  return normalized !== '' && !/^(嗯+|啊+|呃+|额+|唔+|哦+|哈+)$/.test(normalized)
}

/** Keep only speakable prose and stay below Qwen's weighted text limit. */
export function splitForTts(text: string, maxWeight = 1000): string[] {
  const spoken = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`*_#>|]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (spoken === '') return []
  const units = spoken.split(/(?<=[。！？!?；;：:\n])/u).map(value => value.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const unit of units) {
    for (const part of splitWeighted(unit, maxWeight)) {
      const candidate = current === '' ? part : `${current}${needsSpace(current, part) ? ' ' : ''}${part}`
      if (ttsWeight(candidate) <= maxWeight) current = candidate
      else {
        if (current !== '') chunks.push(current)
        current = part
      }
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

function splitWeighted(text: string, maxWeight: number): string[] {
  const output: string[] = []
  let current = ''
  let weight = 0
  for (const char of text) {
    const charWeight = isCjk(char) ? 2 : 1
    if (current !== '' && weight + charWeight > maxWeight) {
      output.push(current)
      current = ''
      weight = 0
    }
    current += char
    weight += charWeight
  }
  if (current !== '') output.push(current)
  return output
}

function ttsWeight(text: string): number {
  let weight = 0
  for (const char of text) weight += isCjk(char) ? 2 : 1
  return weight
}

function isCjk(char: string): boolean { return /[\u3400-\u9fff\uf900-\ufaff]/u.test(char) }
function needsSpace(left: string, right: string): boolean { return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) }

function downsampleToPcm16(input: Float32Array, inputRate: number, outputRate: number): Int16Array {
  const ratio = inputRate / outputRate
  const length = Math.floor(input.length / ratio)
  const output = new Int16Array(length)
  for (let index = 0; index < length; index++) {
    const start = Math.floor(index * ratio)
    const end = Math.max(start + 1, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let at = start; at < end && at < input.length; at++) sum += input[at] ?? 0
    const sample = Math.max(-1, Math.min(1, sum / (end - start)))
    output[index] = sample < 0 ? sample * 32768 : sample * 32767
  }
  return output
}

function base64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer as ArrayBuffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
