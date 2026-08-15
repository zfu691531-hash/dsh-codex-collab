import { HarnessBridge, type DelegateResult } from './harness-delegate.ts'
import { loadPrefs, type VoicePrefs } from './prefs.ts'
import { RealtimeConnection, type RealtimeCallbacks } from './realtime.ts'
import type { ToolCall } from './protocol.ts'
import { QwenPipelineConnection } from './qwen-pipeline.ts'
import { TurnCoordinator, type TurnPhase } from './turn-coordinator.ts'
import { VoiceSummaryStream } from './voice-summary.ts'

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'working' | 'error'
export interface VoiceSnapshot { state: VoiceState; detail: string; provider: 'qwen' | 'openai' }
export interface VoiceConnection {
  connect(): Promise<void>
  disconnect(): void
  speak?(text: string): Promise<void>
  waitForSpeechIdle?(): Promise<void>
  setInputPhase?(phase: TurnPhase): void
}
export type VoiceConnectionFactory = (prefs: VoicePrefs, callbacks: RealtimeCallbacks) => VoiceConnection
export interface VoiceDraftTarget { getDraft(): string; setDraft(text: string): void }

interface ObservedSpeech {
  harnessTurn: string
  turnId: number
  source: VoiceConnection
  summary: VoiceSummaryStream
  speechQueue: Promise<void>
  speechCancelled: boolean
  speechError?: unknown
}

export class VoiceController {
  private connection?: VoiceConnection
  private snapshot: VoiceSnapshot = { state: 'idle', detail: '', provider: loadPrefs().provider }
  private readonly listeners = new Set<() => void>()
  private taskAbort?: AbortController
  private connectionEpoch = 0
  private transcriptTimer?: ReturnType<typeof setTimeout>
  private transcriptSource?: VoiceConnection
  private transcriptSegments: string[] = []
  private transcriptWasBusy = false
  private draftTarget?: VoiceDraftTarget
  private boundDraft = ''
  private deferredDraft = ''
  private readonly turns = new TurnCoordinator()
  private composerOnly = false
  private stopObserving?: () => void
  private voiceContextTimer?: ReturnType<typeof setInterval>
  private observedSpeech?: ObservedSpeech

  constructor(
    readonly sessionId: string,
    private readonly bridge: HarnessBridge,
    private readonly createConnection: VoiceConnectionFactory = (prefs, callbacks) => prefs.provider === 'qwen'
      ? new QwenPipelineConnection(prefs, callbacks)
      : new RealtimeConnection(prefs, callbacks),
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): VoiceSnapshot => this.snapshot

  bindDraft(target: VoiceDraftTarget): () => void {
    this.draftTarget = target
    this.boundDraft = target.getDraft()
    if (this.deferredDraft !== '') {
      this.appendToDraft(this.deferredDraft)
      this.deferredDraft = ''
    }
    return () => { if (this.draftTarget === target) this.draftTarget = undefined }
  }

  async toggle(): Promise<void> {
    if (this.connection !== undefined) return this.stop()
    if (new URLSearchParams(location.search).has('dsh-desktop-platform')) {
      this.setState('error', '桌面壳暂不开放麦克风；正在用默认浏览器打开同一会话')
      window.open(location.href.replace(/([?&])dsh-desktop-platform=[^&]*&?/, '$1').replace(/[?&]$/, ''), '_blank', 'noopener')
      return
    }
    const prefs = loadPrefs()
    this.snapshot = { state: 'connecting', detail: '', provider: prefs.provider }
    this.emit()
    const epoch = ++this.connectionEpoch
    let connection!: VoiceConnection
    connection = this.createConnection(prefs, {
      onState: (state, detail) => {
        if (this.connection !== connection) return
        if (state === 'speaking' && this.turns.phase === 'tts-pending') this.setTurnPhase(this.turns.turnId, 'tts-speaking')
        if (state === 'listening' && this.turns.phase !== 'listening' && this.turns.phase !== 'endpoint-candidate') return
        if (this.taskAbort === undefined) this.setState(state, detail ?? '')
      },
      onToolCall: call => this.handleToolCall(connection, call),
      onTranscript: (text, meta) => this.turns.enqueue(() => this.bufferTranscript(connection, text, meta?.capturedWhileBusy === true)),
    })
    this.connection = connection
    try {
      if (prefs.provider === 'qwen') {
        const enabled = this.enableNativeComposer(connection)
        this.composerOnly = typeof enabled === 'boolean' ? enabled : await enabled
      }
      await connection.connect()
    } catch (error) {
      this.disableNativeComposer()
      connection.disconnect()
      if (this.connectionEpoch !== epoch || this.connection !== connection) return
      this.connection = undefined
      this.setState('error', error instanceof Error ? error.message : String(error))
    }
  }

  stop(): void {
    this.connectionEpoch++
    this.turns.invalidate()
    this.flushBufferedTranscriptToDraft()
    this.taskAbort?.abort()
    this.taskAbort = undefined
    this.disableNativeComposer()
    this.observedSpeech = undefined
    const connection = this.connection
    this.connection = undefined
    connection?.disconnect()
    this.setState('idle', '')
  }

  dispose(): void { this.stop(); this.listeners.clear() }

  private async bufferTranscript(source: VoiceConnection, transcript: string, capturedWhileBusy = false): Promise<void> {
    if (this.connection !== source) return
    const segment = transcript.trim()
    if (segment === '') return
    if (this.transcriptSource !== undefined && this.transcriptSource !== source) this.flushBufferedTranscriptToDraft()
    this.transcriptSource = source
    this.transcriptSegments.push(segment)
    const wasBusy = capturedWhileBusy
      || this.hasPendingDraft()
      || this.taskAbort !== undefined
      || (this.turns.phase !== 'listening' && this.turns.phase !== 'endpoint-candidate')
    this.transcriptWasBusy ||= wasBusy
    if (!wasBusy && this.turns.phase === 'listening') this.setTurnPhase(this.turns.turnId, 'endpoint-candidate')
    if (this.transcriptTimer !== undefined) clearTimeout(this.transcriptTimer)
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = undefined
      const wasBusy = this.transcriptWasBusy
      const combined = this.takeBufferedTranscript()
      if (combined !== '') void this.turns.enqueue(() => this.composerOnly
        ? this.stageComposerTranscript(source, combined)
        : wasBusy ? this.handleBusyTranscript(source, combined) : this.handleTranscript(source, combined))
    }, loadPrefs().qwenMergeMs)
  }

  private async handleToolCall(source: VoiceConnection, call: ToolCall): Promise<unknown> {
    if (this.connection !== source) return { ok: false, error: '语音连接已关闭' }
    if (call.name === 'cancel_harness_task') {
      this.taskAbort?.abort()
      const cancelled = await this.bridge.cancel(this.sessionId)
      if (this.connection === source) {
        this.invalidateCurrentTurn(source)
        this.setState('listening', cancelled ? 'Harness 任务已取消' : '没有正在执行的 Harness 任务')
      }
      return { ok: true, cancelled }
    }
    let task = ''
    try {
      const args = JSON.parse(call.arguments) as { task?: unknown }
      if (typeof args.task === 'string') task = args.task.trim()
    } catch { /* validated below */ }
    if (task === '') return { ok: false, error: 'delegate_to_harness 缺少 task' }
    this.setState('working', task.slice(0, 100))
    const taskAbort = new AbortController()
    this.taskAbort = taskAbort
    const result = await this.bridge.delegate(this.sessionId, task, taskAbort.signal)
    if (this.taskAbort === taskAbort) this.taskAbort = undefined
    if (this.connection === source) this.setState('listening', result.ok ? 'Harness 已完成' : result.error)
    return result
  }

  private async handleTranscript(source: VoiceConnection, transcript: string): Promise<void> {
    if (this.connection !== source) return
    const task = transcript.trim()
    if (task === '') return
    // A background utterance must never kill a Harness turn that is already
    // using tools. Only an explicit spoken cancel command may do that. General
    // barge-in remains available while TTS is speaking, after the Harness turn
    // has completed.
    if (this.taskAbort !== undefined) {
      if (isExplicitCancel(task)) {
        const active = this.taskAbort
        active.abort()
        const cancelled = await this.bridge.cancel(this.sessionId)
        if (this.taskAbort === active) this.taskAbort = undefined
        if (this.connection === source) {
          this.invalidateCurrentTurn(source)
          this.setState('listening', cancelled ? 'Harness 任务已取消' : '没有正在执行的 Harness 任务')
        }
      } else {
        this.appendToDraft(task)
        this.setState('working', '继续任务：新语音已转成文字；发送后排队处理，也可以直接清空')
      }
      return
    }
    // ASR remains open while Harness/TTS works so genuine barge-in stays
    // possible. Before audio has actually started, however, a late/background
    // final must not preempt the answer that is about to play.
    if (this.turns.phase === 'tts-pending' || this.turns.phase === 'tts-speaking' || this.turns.phase === 'post-playback') {
      this.appendToDraft(task)
      this.setState(this.turns.phase === 'tts-speaking' ? 'speaking' : 'working', '继续任务：新语音已保留在输入框；发送后处理，或直接清空')
      return
    }
    const turnId = this.turns.begin()
    this.setTurnPhase(turnId, 'harness')
    this.setState('working', task.slice(0, 100))
    const taskAbort = new AbortController()
    this.taskAbort = taskAbort
    void this.runHarnessTurn(source, task, turnId, taskAbort).catch(error => {
      if (this.connection !== source || !this.turns.isCurrent(turnId)) return
      this.setTurnPhase(turnId, 'listening')
      this.setState('error', error instanceof Error ? error.message : String(error))
    })
  }

  private async handleBusyTranscript(source: VoiceConnection, transcript: string): Promise<void> {
    if (this.connection !== source) return
    const task = transcript.trim()
    if (task === '') return
    if (this.taskAbort !== undefined && isExplicitCancel(task)) {
      await this.handleTranscript(source, task)
      return
    }
    this.appendToDraft(task)
    const playback = this.turns.phase === 'tts-speaking' || this.turns.phase === 'post-playback'
    this.setState(playback ? 'speaking' : this.taskAbort !== undefined ? 'working' : 'listening', '继续任务：新语音已保留在输入框；发送后处理，或直接清空')
  }

  private stageComposerTranscript(source: VoiceConnection, transcript: string): void {
    if (this.connection !== source) return
    this.appendToDraft(transcript)
    if (this.turns.phase === 'endpoint-candidate') this.setTurnPhase(this.turns.turnId, 'listening')
    if (this.turns.phase === 'listening') this.setState('listening', '语音已写入输入框；继续说会合并，发送后由 Harness 处理')
  }

  private enableNativeComposer(source: VoiceConnection): boolean | Promise<boolean> {
    const bridge = this.bridge as HarnessBridge & Partial<Pick<HarnessBridge, 'observeSession' | 'setVoiceMode'>>
    if (typeof bridge.observeSession !== 'function' || typeof bridge.setVoiceMode !== 'function') return false
    this.stopObserving = bridge.observeSession(this.sessionId, {
      onTurnStart: harnessTurn => this.beginObservedTurn(source, harnessTurn),
      onTextDelta: (harnessTurn, delta) => this.pushObservedDelta(harnessTurn, delta),
      onTurnEnd: (harnessTurn, result) => { void this.finishObservedTurn(harnessTurn, result) },
    })
    return bridge.setVoiceMode(this.sessionId, true).then(() => {
      this.voiceContextTimer = setInterval(() => { void bridge.setVoiceMode?.(this.sessionId, true).catch(() => {}) }, 10 * 60_000)
      return true
    })
  }

  private disableNativeComposer(): void {
    this.stopObserving?.()
    this.stopObserving = undefined
    if (this.voiceContextTimer !== undefined) clearInterval(this.voiceContextTimer)
    this.voiceContextTimer = undefined
    if (this.composerOnly) void this.bridge.setVoiceMode?.(this.sessionId, false).catch(() => {})
    this.composerOnly = false
  }

  private beginObservedTurn(source: VoiceConnection, harnessTurn: string): void {
    if (this.connection !== source || !this.composerOnly) return
    const turnId = this.turns.begin()
    this.setTurnPhase(turnId, 'harness')
    this.setState('working', '输入已发送，Harness 正在处理')
    const observed = {} as ObservedSpeech
    observed.harnessTurn = harnessTurn
    observed.turnId = turnId
    observed.source = source
    observed.speechQueue = Promise.resolve()
    observed.speechCancelled = false
    observed.summary = new VoiceSummaryStream(sentence => {
      if (source.speak === undefined || observed.speechCancelled) return
      if (this.connection === source && this.turns.isCurrent(turnId)) this.setTurnPhase(turnId, 'tts-pending')
      observed.speechQueue = observed.speechQueue.then(async () => {
        if (observed.speechCancelled || this.connection !== source || !this.turns.isCurrent(turnId)) return
        await source.speak?.(sentence)
      }).catch(error => {
        observed.speechError = error
        observed.speechCancelled = true
      })
    })
    this.observedSpeech = observed
  }

  private pushObservedDelta(harnessTurn: string, delta: string): void {
    const observed = this.observedSpeech
    if (observed?.harnessTurn === harnessTurn) observed.summary.push(delta)
  }

  private async finishObservedTurn(harnessTurn: string, result: DelegateResult): Promise<void> {
    const observed = this.observedSpeech
    if (observed?.harnessTurn !== harnessTurn) return
    this.observedSpeech = undefined
    const { source, turnId } = observed
    if (this.connection !== source || !this.turns.isCurrent(turnId)) return
    if (!result.ok) {
      this.setTurnPhase(turnId, 'listening')
      this.setState(result.cancelled === true ? 'listening' : 'error', result.error)
      return
    }
    try {
      observed.summary.finish(result.text)
      await observed.speechQueue
      await source.waitForSpeechIdle?.()
      if (observed.speechError !== undefined && !isBargeInError(observed.speechError)) throw observed.speechError
      if (this.connection !== source || !this.turns.isCurrent(turnId)) return
      this.setTurnPhase(turnId, 'post-playback')
      await delay(400)
      if (this.connection !== source || !this.turns.isCurrent(turnId)) return
      this.setTurnPhase(turnId, 'listening')
      this.setState('listening', isBargeInError(observed.speechError)
        ? '播报已打断；识别文字保留在输入框'
        : 'Harness 已完成；继续说会写入输入框')
    } catch (error) {
      if (this.connection === source && this.turns.isCurrent(turnId)) {
        this.setTurnPhase(turnId, 'listening')
        this.setState('error', error instanceof Error ? error.message : String(error))
      }
    }
  }

  private async runHarnessTurn(source: VoiceConnection, task: string, turnId: number, taskAbort: AbortController): Promise<void> {
    let speechError: unknown
    let speechCancelled = false
    let speechQueue = Promise.resolve()
    const enqueueSpeech = (sentence: string) => {
      if (source.speak === undefined) return
      if (this.connection === source && this.turns.isCurrent(turnId)) this.setTurnPhase(turnId, 'tts-pending')
      speechQueue = speechQueue.then(async () => {
        if (speechCancelled || this.connection !== source || !this.turns.isCurrent(turnId)) return
        await source.speak?.(sentence)
      }).catch(error => {
        speechError = error
        speechCancelled = true
      })
    }
    const summary = new VoiceSummaryStream(enqueueSpeech)
    const result = await this.bridge.delegate(
      this.sessionId,
      task,
      taskAbort.signal,
      { voiceOutputContract: true, onTextDelta: delta => summary.push(delta) },
    )
    if (this.taskAbort === taskAbort) this.taskAbort = undefined
    if (this.connection !== source || !this.turns.isCurrent(turnId)) return
    if (!result.ok) {
      this.setTurnPhase(turnId, 'listening')
      this.setState('error', result.error)
      return
    }
    if (source.speak === undefined) {
      this.setTurnPhase(turnId, 'listening')
      this.setState('error', '当前语音连接没有独立 TTS')
      return
    }
    try {
      summary.finish(result.text)
      await speechQueue
      await source.waitForSpeechIdle?.()
      if (speechError !== undefined && !isBargeInError(speechError)) throw speechError
      if (this.connection === source && this.turns.isCurrent(turnId)) {
        this.setTurnPhase(turnId, 'post-playback')
        await delay(400)
        if (this.connection !== source || !this.turns.isCurrent(turnId)) return
        this.setTurnPhase(turnId, 'listening')
        this.setState('listening', isBargeInError(speechError)
          ? '播报已打断；新语音已保留在输入框，可发送或清空'
          : 'Harness 已完成')
      }
    } catch (error) {
      if (this.connection === source && this.turns.isCurrent(turnId)) {
        this.setTurnPhase(turnId, 'listening')
        this.setState('error', error instanceof Error ? error.message : String(error))
      }
    }
  }

  private setState(state: VoiceState, detail: string): void {
    this.snapshot = { state, detail, provider: loadPrefs().provider }
    this.emit()
  }

  private emit(): void { this.listeners.forEach(listener => listener()) }

  private setTurnPhase(turnId: number, phase: TurnPhase): void {
    if (!this.turns.transition(turnId, phase)) return
    this.connection?.setInputPhase?.(phase)
  }

  private invalidateCurrentTurn(source: VoiceConnection): void {
    this.turns.invalidate()
    source.setInputPhase?.('listening')
  }

  private takeBufferedTranscript(): string {
    const combined = this.transcriptSegments.splice(0).join('\n').trim()
    this.transcriptSource = undefined
    this.transcriptWasBusy = false
    return combined
  }

  private flushBufferedTranscriptToDraft(): void {
    if (this.transcriptTimer !== undefined) clearTimeout(this.transcriptTimer)
    this.transcriptTimer = undefined
    const combined = this.takeBufferedTranscript()
    if (combined !== '') this.appendToDraft(combined)
  }

  private appendToDraft(text: string): void {
    const addition = text.trim()
    if (addition === '') return
    const target = this.draftTarget
    if (target === undefined) {
      this.deferredDraft = joinDraft(this.deferredDraft, addition)
      return
    }
    const next = joinDraft(this.boundDraft || target.getDraft(), addition)
    this.boundDraft = next
    target.setDraft(next)
  }

  private hasPendingDraft(): boolean {
    if (this.deferredDraft.trim() !== '') return true
    const target = this.draftTarget
    return (target?.getDraft() ?? this.boundDraft).trim() !== ''
  }
}

function isExplicitCancel(text: string): boolean {
  const normalized = text.replace(/[\s，。！？,.!?、]/g, '')
  return /^(停|停止|停下|别说了|取消|取消任务|不要了|算了)$/.test(normalized)
}

function isBargeInError(error: unknown): boolean {
  return error instanceof Error && error.message === '语音播放已被用户打断'
}

function joinDraft(existing: string, addition: string): string {
  const before = existing.trimEnd()
  return before === '' ? addition : `${before}\n${addition}`
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
