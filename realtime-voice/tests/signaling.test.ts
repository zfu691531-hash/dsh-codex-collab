import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpError } from '../src/host/security.ts'
import { normalizeSdp, parseSignalRequest, qwenEndpoint } from '../src/host/signaling.ts'

test('normalizes SDP and builds allowlisted Qwen endpoint', () => {
  const request = parseSignalRequest({
    sdp: 'v=0\no=- 1 1 IN IP4 127.0.0.1\n',
    workspaceId: 'ws_12345',
    region: 'cn-beijing',
  }, 'qwen')
  assert.equal(request.sdp, 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n')
  assert.equal(qwenEndpoint(request), 'https://ws_12345.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.5-omni-plus-realtime')
})

test('uses the official Singapore workspace domain', () => {
  const request = parseSignalRequest({ sdp: 'v=0\nlong-enough', workspaceId: 'ws_12345', region: 'ap-southeast-1' }, 'qwen')
  assert.equal(qwenEndpoint(request), 'https://ws_12345.ap-southeast-1.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.5-omni-plus-realtime')
})

test('rejects endpoint injection and oversized provider fields', () => {
  assert.throws(() => parseSignalRequest({ sdp: 'v=0\nlong-enough', workspaceId: 'bad.example.com/' }, 'qwen'), HttpError)
  assert.throws(() => parseSignalRequest({ sdp: 'v=0\nlong-enough', workspaceId: 'valid_id', region: 'evil' }, 'qwen'), HttpError)
  assert.throws(() => parseSignalRequest({ sdp: 'v=0\nlong-enough', model: 'x'.repeat(129) }, 'openai'), HttpError)
})

test('normalizeSdp is idempotent', () => {
  const once = normalizeSdp('v=0\r\na=1\r\n')
  assert.equal(normalizeSdp(once), once)
})
