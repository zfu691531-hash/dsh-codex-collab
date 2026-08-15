import assert from 'node:assert/strict'
import test from 'node:test'
import { extractVoiceSummary, VoiceSummaryStream } from '../src/client/voice-summary.ts'
import { VOICE_OUTPUT_CONTEXT } from '../src/voice-contract.ts'

test('streams complete summary sentences across arbitrarily split markers', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  for (const delta of ['工具前置文字', '<!--voice-', 'summary-->', '天气晴朗。', '出门不用带伞', '。<!--/voice-sum', 'mary-->', '详细结果不会播']) {
    stream.push(delta)
  }
  stream.finish('')
  assert.deepEqual(spoken, ['天气晴朗。', '出门不用带伞。'])
})

test('reasoning and detail outside summary markers are never spoken', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  stream.push('私有推理和工具过程。<!--voice-summary-->结论已经完成。<!--/voice-summary-->完整代码与长说明。')
  stream.finish('')
  assert.deepEqual(spoken, ['结论已经完成。'])
})

test('accepts spaced summary comments emitted by Harness', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  stream.push('<!-- voice-')
  stream.push('summary -->已经调试成功。<!-- /voice-summary -->详细内容')
  stream.finish('')
  assert.deepEqual(spoken, ['已经调试成功。'])
})

test('final fallback is bounded to the first visible sentence', () => {
  assert.equal(extractVoiceSummary('第一句可播。第二句不应播。\n\n很长的详细结果'), '第一句可播。')
})

test('hidden voice context requires summary before detail', () => {
  assert.match(VOICE_OUTPUT_CONTEXT, /内容严格为 voice-summary 的 HTML 注释/)
  assert.match(VOICE_OUTPUT_CONTEXT, /随后输出完整结果/)
})
