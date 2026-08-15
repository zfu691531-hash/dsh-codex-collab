import assert from 'node:assert/strict'
import test from 'node:test'
import { isLikelyTtsEcho, LocalBargeInGate, splitForTts } from '../src/client/qwen-pipeline.ts'

test('TTS chunks remove code and remain below the weighted limit', () => {
  const chunks = splitForTts(`这是最终答案。\n\`\`\`json\n{"private":"tool payload"}\n\`\`\`\n更多说明：${'很长的中文句子。'.repeat(180)}`, 200)
  assert.equal(chunks.some(chunk => chunk.includes('tool payload')), false)
  assert.equal(chunks.every(chunk => weighted(chunk) <= 200), true)
  assert.match(chunks.join(''), /这是最终答案/)
})

function weighted(text: string): number {
  let value = 0
  for (const char of text) value += /[\u3400-\u9fff\uf900-\ufaff]/u.test(char) ? 2 : 1
  return value
}

test('TTS echo is rejected while distinct speech remains distinct', () => {
  const speech = '今天天气晴朗，最高温度二十八度，出门不用带伞。'
  assert.equal(isLikelyTtsEcho('今天天气晴朗，最高温度二十八度。', speech), true)
  assert.equal(isLikelyTtsEcho('天气晴朗最高温度二十八度', speech), true)
  assert.equal(isLikelyTtsEcho('帮我打开音乐播放器', speech), false)
  assert.equal(isLikelyTtsEcho('停止', speech), false)
})

test('local barge-in requires playback warmup and 500ms sustained near-field audio', () => {
  const gate = new LocalBargeInGate()
  const loud = pcm(2_000, 1_600) // 100ms at 16kHz
  const quiet = pcm(100, 1_600)
  assert.equal(gate.push(loud, 100).forward, false)
  assert.equal(gate.push(quiet, 400).forward, false)
  for (let elapsed = 400; elapsed < 800; elapsed += 100) assert.equal(gate.push(loud, elapsed).forward, false)
  const confirmed = gate.push(loud, 800)
  assert.equal(confirmed.forward, true)
  assert.equal(confirmed.preRoll.length > 1, true)
  assert.equal(gate.push(loud, 900).forward, true)
  gate.reset()
  assert.equal(gate.push(loud, 900).forward, false)
})

function pcm(amplitude: number, samples: number): Int16Array {
  const output = new Int16Array(samples)
  output.fill(amplitude)
  return output
}
