import assert from 'node:assert/strict'
import test from 'node:test'
import { VoiceController, type VoiceConnection, type VoiceConnectionFactory } from '../src/client/controller.ts'
import type { HarnessBridge } from '../src/client/harness-delegate.ts'
import type { RealtimeCallbacks } from '../src/client/realtime.ts'
import { updatePrefs } from '../src/client/prefs.ts'

function installBrowserStubs(): void {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '', href: 'http://127.0.0.1/' } })
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
}

test('stop during connection prevents a late failure from replacing idle state', async () => {
  installBrowserStubs()
  let rejectConnect!: (error: Error) => void
  let disconnects = 0
  const connection: VoiceConnection = {
    connect: async () => await new Promise<void>((_resolve, reject) => { rejectConnect = reject }),
    disconnect: () => { disconnects++ },
  }
  const factory: VoiceConnectionFactory = () => connection
  const bridge = {} as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  const connecting = controller.toggle()
  controller.stop()
  rejectConnect(new Error('late failure'))
  await connecting
  assert.equal(controller.getSnapshot().state, 'idle')
  assert.equal(disconnects >= 1, true)
})

test('background transcript does not abort an active Harness turn', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let resolveDelegate!: (value: { ok: true; text: string }) => void
  let delegated = 0
  let activeSignal!: AbortSignal
  let draft = ''
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async () => {},
  }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async (_sessionId: string, _task: string, signal: AbortSignal) => {
      delegated++
      activeSignal = signal
      return await new Promise<{ ok: true; text: string }>(resolve => { resolveDelegate = resolve })
    },
    cancel: async () => false,
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('查询上海天气')
  await delay(130)
  await callbacks.onTranscript?.('旁边的人在说话')
  await delay(130)
  assert.equal(delegated, 1)
  assert.equal(activeSignal.aborted, false)
  assert.equal(draft, '旁边的人在说话')
  resolveDelegate({ ok: true, text: '天气晴朗' })
  await delay(450)
  assert.equal(controller.getSnapshot().state, 'listening')
  await callbacks.onTranscript?.('今晚就这样吧')
  await delay(130)
  assert.equal(delegated, 1)
  assert.equal(draft, '旁边的人在说话\n今晚就这样吧')
})

test('an existing native draft absorbs later listening transcripts until the user clears it', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let delegated = 0
  let draft = '或者说明天能去哪里玩呢？'
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {} }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async () => {
      delegated++
      return { ok: true as const, text: '不应该执行' }
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('可以了，今晚就这样')
  await delay(130)
  assert.equal(delegated, 0)
  assert.equal(draft, '或者说明天能去哪里玩呢？\n可以了，今晚就这样')
  draft = ''
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await callbacks.onTranscript?.('这是清空后的新问题')
  await delay(130)
  assert.equal(delegated, 1)
})

test('Qwen composer mode never auto-submits ASR and speaks the manually submitted Harness turn', async () => {
  installBrowserStubs()
  updatePrefs({ provider: 'qwen', qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let observer!: {
    onTurnStart(turn: string): void
    onTextDelta(turn: string, delta: string): void
    onTurnEnd(turn: string, result: { ok: true; text: string }): void
  }
  let draft = ''
  let delegates = 0
  const spoken: string[] = []
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async text => { spoken.push(text) },
  }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async () => { delegates++; return { ok: true as const, text: '不应执行' } },
    setVoiceMode: async () => {},
    observeSession: (_sessionId: string, value: typeof observer) => { observer = value; return () => {} },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('太好了。')
  await delay(130)
  await callbacks.onTranscript?.('已经调试成功了。')
  await delay(130)
  assert.equal(delegates, 0)
  assert.equal(draft, '太好了。\n已经调试成功了。')

  draft = '' // native input submitted and cleared by Harness UI
  observer.onTurnStart('native-turn')
  observer.onTextDelta('native-turn', '<!-- voice-summary -->已经成功了。<!-- /voice-summary -->')
  observer.onTurnEnd('native-turn', { ok: true, text: '<!-- voice-summary -->已经成功了。<!-- /voice-summary -->详细结果' })
  await delay(450)
  assert.deepEqual(spoken, ['已经成功了。'])
  controller.stop()
})

test('a busy transcript stays in the draft even when Harness completes before endpoint grace', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let resolveDelegate!: (value: { ok: true; text: string }) => void
  let delegates = 0
  let draft = ''
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {} }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async () => {
      delegates++
      return await new Promise<{ ok: true; text: string }>(resolve => { resolveDelegate = resolve })
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('第一轮')
  await delay(130)
  await callbacks.onTranscript?.('完成后继续检查测试')
  resolveDelegate({ ok: true, text: '完成' })
  await delay(550)
  assert.equal(delegates, 1)
  assert.equal(draft, '完成后继续检查测试')
})

test('a late ASR final keeps the busy provenance from its speech-start event', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let delegates = 0
  let draft = ''
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {} }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async () => {
      delegates++
      return { ok: true as const, text: '已完成' }
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('第一轮')
  await delay(550)
  assert.equal(controller.getSnapshot().state, 'listening')
  await callbacks.onTranscript?.('语音开始时其实仍在忙', { capturedWhileBusy: true })
  await delay(130)
  assert.equal(delegates, 1)
  assert.equal(draft, '语音开始时其实仍在忙')
})

test('speech captured during TTS is staged and never starts a second Harness turn', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let rejectSpeech!: (error: Error) => void
  let delegates = 0
  let draft = ''
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async () => await new Promise<void>((_resolve, reject) => { rejectSpeech = reject }),
  }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async () => {
      delegates++
      return { ok: true as const, text: '<!--voice-summary-->第一轮回答。<!--/voice-summary-->详细内容' }
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('第一轮问题')
  await delay(130)
  callbacks.onState('speaking')
  await callbacks.onTranscript?.('这是打断后准备发送的话')
  rejectSpeech(new Error('语音播放已被用户打断'))
  await delay(550)
  assert.equal(delegates, 1)
  assert.equal(draft, '这是打断后准备发送的话')
  assert.equal(controller.getSnapshot().state, 'listening')
})

test('short ASR finals merge into one Harness paragraph', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  const tasks: string[] = []
  const voiceContextFlags: boolean[] = []
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {} }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async (_sessionId: string, task: string, _signal: AbortSignal, options: { voiceOutputContract?: boolean }) => {
      tasks.push(task)
      voiceContextFlags.push(options.voiceOutputContract === true)
      return { ok: true as const, text: '收到' }
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  await controller.toggle()
  await callbacks.onTranscript?.('这是第一小句')
  await delay(35)
  await callbacks.onTranscript?.('这是接着说的第二小句')
  await delay(130)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0], '这是第一小句\n这是接着说的第二小句')
  assert.doesNotMatch(tasks[0] ?? '', /voice-summary|dsh-realtime-voice/)
  assert.deepEqual(voiceContextFlags, [true])
})

test('a transcript arriving before TTS starts cannot preempt the pending reply', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let resolveSpeech!: () => void
  let delegates = 0
  let draft = ''
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async () => await new Promise<void>(resolve => { resolveSpeech = resolve }),
  }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async () => {
      delegates++
      return { ok: true as const, text: '<!--voice-summary-->第一轮结果。<!--/voice-summary-->详细结果' }
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('第一轮')
  await delay(130)
  await callbacks.onTranscript?.('播放前的背景短句')
  await delay(130)
  assert.equal(delegates, 1)
  assert.equal(draft, '播放前的背景短句')
  resolveSpeech()
  await delay(0)
})

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
