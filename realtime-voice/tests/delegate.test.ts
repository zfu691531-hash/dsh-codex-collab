import assert from 'node:assert/strict'
import test from 'node:test'
import { extractAssistantText, HarnessBridge } from '../src/client/harness-delegate.ts'
import type { MuxFrame, RpcApi } from '../src/client/context-types.ts'

class FrameQueue {
  private values: MuxFrame[] = []
  private waiters: Array<(value: IteratorResult<{ payload: MuxFrame }>) => void> = []
  private ended = false
  push(frame: MuxFrame): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ done: false, value: { payload: frame } })
    else this.values.push(frame)
  }
  end(): void {
    this.ended = true
    this.waiters.splice(0).forEach(resolve => resolve({ done: true, value: undefined }))
  }
  async *iterate(signal: AbortSignal): AsyncIterable<{ payload: MuxFrame }> {
    while (!signal.aborted) {
      const frame = this.values.shift()
      if (frame !== undefined) { yield { payload: frame }; continue }
      if (this.ended) return
      const next = await new Promise<IteratorResult<{ payload: MuxFrame }>>(resolve => {
        this.waiters.push(resolve)
        signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true })
      })
      if (next.done) return
      yield next.value
    }
  }
}

function fixture() {
  const frames = new FrameQueue()
  const calls = { prompts: 0, removes: 0, cancels: 0 }
  const api: RpcApi = {
    sessions: {
      prompt: async payload => {
        calls.prompts++
        assert.equal(payload.mode, 'queue')
        return { rpcId: 'rpc-voice', result: { ok: true, value: { accepted: true } } }
      },
      updateQueue: async () => { calls.removes++; return { rpcId: 'remove', result: { ok: true, value: { accepted: true } } } },
      cancel: async () => { calls.cancels++; return { rpcId: 'cancel', result: { ok: true, value: { accepted: true } } } },
    },
    events: { mux: (_payload, signal) => frames.iterate(signal) },
  }
  return { frames, calls, bridge: new HarnessBridge(api) }
}

test('correlates rpcId to turn and returns the final assistant message', async () => {
  const { frames, bridge } = fixture()
  const pending = bridge.delegate('s1', 'do work')
  frames.push({ type: 'session/subscribed', sessionId: 's1', lastSeq: 0 })
  await new Promise(resolve => setTimeout(resolve, 0))
  frames.push({ type: 'session/queue', sessionId: 's1', items: [{ id: 'item-1', placement: 'queued', message: { source: { kind: 'user', rpcId: 'rpc-voice' } } }] })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'turn/start', data: { turn: 'turn-7' } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: 'rpc-voice' } } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'assistant/message', data: { turn: 'turn-7', message: { content: [{ type: 'text', text: 'done' }] } } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'turn/end', data: { turn: 'turn-7', reason: { kind: 'completed' } } } })
  assert.deepEqual(await pending, { ok: true, text: 'done' })
  bridge.dispose()
})

test('final speech extraction excludes reasoning and tool blocks', () => {
  const text = extractAssistantText({ content: [
    { type: 'reasoning', text: 'This private chain of thought must never be spoken.' },
    { type: 'tool-call', name: 'weather', text: 'tool internals' },
    { type: 'text', text: '今天有小雨，记得带伞。' },
  ] })
  assert.equal(text, '今天有小雨，记得带伞。')
})

test('streams text deltas but never reasoning deltas', async () => {
  const { frames, bridge } = fixture()
  const deltas: string[] = []
  const pending = bridge.delegate('s1', 'voice work', undefined, { onTextDelta: delta => deltas.push(delta) })
  frames.push({ type: 'session/subscribed', sessionId: 's1', lastSeq: 0 })
  await new Promise(resolve => setTimeout(resolve, 0))
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'turn/start', data: { turn: 't-stream' } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'user/message', data: { source: { rpcId: 'rpc-voice' } } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'assistant/chunk', data: { turn: 't-stream', step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'private' } } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'assistant/chunk', data: { turn: 't-stream', step: 1, chunk: { type: 'text-delta', index: 1, text: 'visible' } } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'assistant/message', data: { turn: 't-stream', message: { content: [{ type: 'text', text: 'visible' }] } } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'turn/end', data: { turn: 't-stream', reason: { kind: 'completed' } } } })
  assert.deepEqual(await pending, { ok: true, text: 'visible' })
  assert.deepEqual(deltas, ['visible'])
  bridge.dispose()
})

test('observes a native Harness turn without submitting a second prompt', async () => {
  const { frames, calls, bridge } = fixture()
  const events: string[] = []
  const stop = bridge.observeSession('s1', {
    onTurnStart: turn => events.push(`start:${turn}`),
    onTextDelta: (turn, delta) => events.push(`delta:${turn}:${delta}`),
    onTurnEnd: (turn, result) => events.push(`end:${turn}:${result.ok ? result.text : result.error}`),
  })
  frames.push({ type: 'session/subscribed', sessionId: 's1', lastSeq: 0 })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'turn/start', data: { turn: 'native-1' } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'user/message', data: { source: { kind: 'user' } } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'assistant/chunk', data: { turn: 'native-1', chunk: { type: 'text-delta', text: '摘要。' } } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'assistant/message', data: { turn: 'native-1', message: { text: '最终回答' } } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'turn/end', data: { turn: 'native-1', reason: { kind: 'completed' } } } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(calls.prompts, 0)
  assert.deepEqual(events, ['start:native-1', 'delta:native-1:摘要。', 'end:native-1:最终回答'])
  stop()
  bridge.dispose()
})

test('voice contract is activated out-of-band while the visible prompt stays verbatim', async () => {
  const frames = new FrameQueue()
  const contexts: Array<{ sessionId: string; active: boolean }> = []
  let visiblePrompt = ''
  const api: RpcApi = {
    sessions: {
      prompt: async payload => {
        visiblePrompt = payload.content[0]?.text ?? ''
        return { rpcId: 'rpc-hidden-context', result: { ok: true, value: { accepted: true } } }
      },
      updateQueue: async () => ({ rpcId: 'remove', result: { ok: true, value: { accepted: true } } }),
      cancel: async () => ({ rpcId: 'cancel', result: { ok: true, value: { accepted: true } } }),
    },
    events: { mux: (_payload, signal) => frames.iterate(signal) },
  }
  const bridge = new HarnessBridge(api, 30_000, async (sessionId, active) => { contexts.push({ sessionId, active }) })
  const pending = bridge.delegate('voice-session', '那你的被子？', undefined, { voiceOutputContract: true })
  frames.push({ type: 'session/subscribed', sessionId: 'voice-session', lastSeq: 0 })
  await new Promise(resolve => setTimeout(resolve, 0))
  frames.push({ type: 'session/event', sessionId: 'voice-session', event: { type: 'turn/start', data: { turn: 'voice-turn' } } })
  frames.push({ type: 'session/event', sessionId: 'voice-session', event: { type: 'user/message', data: { source: { rpcId: 'rpc-hidden-context' } } } })
  frames.push({ type: 'session/event', sessionId: 'voice-session', event: { type: 'assistant/message', data: { turn: 'voice-turn', message: { text: '回答' } } } })
  frames.push({ type: 'session/event', sessionId: 'voice-session', event: { type: 'turn/end', data: { turn: 'voice-turn', reason: { kind: 'completed' } } } })

  assert.deepEqual(await pending, { ok: true, text: '回答' })
  assert.equal(visiblePrompt, '那你的被子？')
  assert.doesNotMatch(visiblePrompt, /dsh-realtime-voice|voice-summary/)
  assert.deepEqual(contexts, [
    { sessionId: 'voice-session', active: true },
    { sessionId: 'voice-session', active: false },
  ])
  bridge.dispose()
})

test('pending cancel removes only the matching queue item', async () => {
  const { frames, calls, bridge } = fixture()
  const pending = bridge.delegate('s1', 'do work')
  frames.push({ type: 'session/subscribed', sessionId: 's1', lastSeq: 0 })
  await new Promise(resolve => setTimeout(resolve, 0))
  frames.push({ type: 'session/queue', sessionId: 's1', items: [{ id: 'item-1', placement: 'queued', message: { source: { rpcId: 'rpc-voice' } } }] })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(await bridge.cancel('s1'), true)
  assert.deepEqual(await pending, { ok: false, cancelled: true, error: '已取消' })
  assert.equal(calls.removes, 1)
  assert.equal(calls.cancels, 0)
  bridge.dispose()
})

test('active cancel uses session.cancel and a second delegate is rejected', async () => {
  const { frames, calls, bridge } = fixture()
  const first = bridge.delegate('s1', 'first')
  frames.push({ type: 'session/subscribed', sessionId: 's1', lastSeq: 0 })
  await new Promise(resolve => setTimeout(resolve, 0))
  const second = await bridge.delegate('s1', 'second')
  assert.equal(second.ok, false)
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'turn/start', data: { turn: 't' } } })
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'user/message', data: { source: { rpcId: 'rpc-voice' } } } })
  await new Promise(resolve => setTimeout(resolve, 0))
  await bridge.cancel('s1')
  assert.equal(calls.cancels, 1)
  frames.push({ type: 'session/event', sessionId: 's1', event: { type: 'turn/end', data: { turn: 't', reason: { kind: 'aborted' } } } })
  assert.equal((await first).cancelled, true)
  bridge.dispose()
})

test('reopens a completed mux stream and converges from replayed history', async () => {
  const first = new FrameQueue()
  const second = new FrameQueue()
  let muxCalls = 0
  const api: RpcApi = {
    sessions: {
      prompt: async () => ({ rpcId: 'rpc-reconnect', result: { ok: true, value: { accepted: true } } }),
      updateQueue: async () => ({ rpcId: 'remove', result: { ok: true, value: { accepted: true } } }),
      cancel: async () => ({ rpcId: 'cancel', result: { ok: true, value: { accepted: true } } }),
    },
    events: { mux: (_payload, signal) => (muxCalls++ === 0 ? first : second).iterate(signal) },
  }
  const bridge = new HarnessBridge(api)
  const pending = bridge.delegate('s1', 'survive reconnect')
  first.push({ type: 'session/subscribed', sessionId: 's1', lastSeq: 0 })
  await new Promise(resolve => setTimeout(resolve, 0))
  first.end()
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(muxCalls >= 2, true)
  second.push({ type: 'session/subscribed', sessionId: 's1', lastSeq: 0 })
  second.push({ type: 'session/event', sessionId: 's1', event: { type: 'turn/start', data: { turn: 't2' } } })
  second.push({ type: 'session/event', sessionId: 's1', event: { type: 'user/message', data: { source: { rpcId: 'rpc-reconnect' } } } })
  second.push({ type: 'session/event', sessionId: 's1', event: { type: 'assistant/message', data: { turn: 't2', message: { text: 'recovered' } } } })
  second.push({ type: 'session/event', sessionId: 's1', event: { type: 'turn/end', data: { turn: 't2', reason: { kind: 'completed' } } } })
  assert.deepEqual(await pending, { ok: true, text: 'recovered' })
  bridge.dispose()
})

test('records cancellation during prompt admission and removes the admitted item', async () => {
  const frames = new FrameQueue()
  let resolvePrompt!: (value: Awaited<ReturnType<RpcApi['sessions']['prompt']>>) => void
  let removes = 0
  const api: RpcApi = {
    sessions: {
      prompt: async () => await new Promise(resolve => { resolvePrompt = resolve }),
      updateQueue: async () => { removes++; return { rpcId: 'remove', result: { ok: true, value: { accepted: true } } } },
      cancel: async () => ({ rpcId: 'cancel', result: { ok: true, value: { accepted: true } } }),
    },
    events: { mux: (_payload, signal) => frames.iterate(signal) },
  }
  const bridge = new HarnessBridge(api)
  const abort = new AbortController()
  const pending = bridge.delegate('s1', 'cancel during admission', abort.signal)
  frames.push({ type: 'session/subscribed', sessionId: 's1', lastSeq: 0 })
  await new Promise(resolve => setTimeout(resolve, 0))
  abort.abort()
  resolvePrompt({ rpcId: 'rpc-admitted', result: { ok: true, value: { accepted: true } } })
  await new Promise(resolve => setTimeout(resolve, 0))
  frames.push({ type: 'session/queue', sessionId: 's1', items: [{ id: 'admitted', placement: 'queued', message: { source: { rpcId: 'rpc-admitted' } } }] })
  assert.deepEqual(await pending, { ok: false, cancelled: true, error: '已取消' })
  assert.equal(removes, 1)
  bridge.dispose()
})

test('bounds prompt admission and normalizes timeout failures', async () => {
  const frames = new FrameQueue()
  const api: RpcApi = {
    sessions: {
      prompt: async (_payload, signal) => await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
      updateQueue: async () => ({ rpcId: 'remove', result: { ok: true, value: { accepted: true } } }),
      cancel: async () => ({ rpcId: 'cancel', result: { ok: true, value: { accepted: true } } }),
    },
    events: { mux: (_payload, signal) => frames.iterate(signal) },
  }
  const bridge = new HarnessBridge(api, 20)
  const pending = bridge.delegate('s1', 'bounded admission')
  frames.push({ type: 'session/subscribed', sessionId: 's1', lastSeq: 0 })
  assert.deepEqual(await pending, { ok: false, error: 'Harness prompt 准入超时' })
  bridge.dispose()
})
