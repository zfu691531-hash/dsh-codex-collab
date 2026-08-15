import assert from 'node:assert/strict'
import test from 'node:test'
import { parseToolCall, sessionUpdate, toolOutput } from '../src/client/protocol.ts'
import type { VoicePrefs } from '../src/client/prefs.ts'

const base: VoicePrefs = {
  provider: 'openai',
  qwenWorkspaceId: 'ws_123',
  qwenRegion: 'cn-beijing',
  qwenModel: 'qwen3.5-omni-plus-realtime',
  qwenVoice: 'Tina',
  qwenAsrModel: 'qwen3-asr-flash-realtime',
  qwenTtsModel: 'qwen3-tts-flash-realtime',
  qwenTtsVoice: 'Chelsie',
  qwenVadThreshold: 0.85,
  qwenSilenceMs: 700,
  qwenMergeMs: 900,
  openaiModel: 'gpt-realtime-2.1',
  openaiVoice: 'marin',
  instructions: 'test',
}

test('OpenAI and Qwen expose only the mandatory Harness delegate', () => {
  const openai = sessionUpdate(base) as { session: { tools: Array<{ name: string }> } }
  const qwen = sessionUpdate({ ...base, provider: 'qwen' }) as { session: { tools: Array<{ function: { name: string } }> } }
  assert.deepEqual(openai.session.tools.map(tool => tool.name), ['delegate_to_harness'])
  assert.deepEqual(qwen.session.tools.map(tool => tool.function.name), ['delegate_to_harness'])
})

test('OpenAI forces the only Harness tool instead of relying on model choice', () => {
  const openai = sessionUpdate(base) as { session: { tool_choice: string } }
  assert.equal(openai.session.tool_choice, 'required')
})

test('both providers receive the Harness-first policy', () => {
  const openai = sessionUpdate(base) as { session: { instructions: string } }
  const qwen = sessionUpdate({ ...base, provider: 'qwen' }) as { session: { instructions: string; input_audio_transcription: { model: string; language: string } } }
  assert.match(openai.session.instructions, /每一次有效发言/)
  assert.match(qwen.session.instructions, /唯一允许的处理方式都是调用 delegate_to_harness/)
  assert.deepEqual(qwen.session.input_audio_transcription, { model: 'qwen3-asr-flash-realtime', language: 'zh' })
})

test('parses function calls from both supported event envelopes', () => {
  const item = { type: 'function_call', call_id: 'call-1', name: 'delegate_to_harness', arguments: '{"task":"x"}' }
  assert.deepEqual(parseToolCall({ type: 'response.output_item.done', item }), {
    callId: 'call-1', name: 'delegate_to_harness', arguments: '{"task":"x"}',
  })
  assert.equal(parseToolCall({ type: 'conversation.item.created', item: { ...item, name: 'unknown' } }), undefined)
  assert.deepEqual(parseToolCall({ type: 'response.function_call_arguments.done', call_id: 'call-2', name: 'cancel_harness_task', arguments: '{}' }), {
    callId: 'call-2', name: 'cancel_harness_task', arguments: '{}',
  })
})

test('tool output always creates output then explicitly resumes response', () => {
  const events = toolOutput('call-1', { ok: true, text: 'done' })
  assert.equal(events[0]?.type, 'conversation.item.create')
  assert.equal((events[0]?.item as { output?: string }).output, 'done')
  assert.equal(events[1]?.type, 'response.create')
})

test('tool output turns Harness failures into speakable text', () => {
  const events = toolOutput('call-1', { ok: false, error: 'offline' })
  assert.equal((events[0]?.item as { output?: string }).output, 'Harness 执行失败：offline')
})
