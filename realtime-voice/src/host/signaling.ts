import { HttpError } from './security.ts'

export type Provider = 'openai' | 'qwen'
export type QwenRegion = 'cn-beijing' | 'ap-southeast-1'

export interface SignalRequest {
  sdp: string
  provider: Provider
  model?: string
  voice?: string
  instructions?: string
  workspaceId?: string
  region?: QwenRegion
}

const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/

export function parseSignalRequest(value: unknown, provider: Provider): SignalRequest {
  if (typeof value !== 'object' || value === null) throw new HttpError(400, 'body must be an object')
  const body = value as Record<string, unknown>
  if (typeof body.sdp !== 'string' || body.sdp.length < 8 || body.sdp.length > 120_000) {
    throw new HttpError(400, 'invalid SDP')
  }
  const request: SignalRequest = {
    provider,
    sdp: normalizeSdp(body.sdp),
    model: optionalText(body.model, 128),
    voice: optionalText(body.voice, 128),
    instructions: optionalText(body.instructions, 12_000),
  }
  if (provider === 'qwen') {
    if (typeof body.workspaceId !== 'string' || !WORKSPACE_RE.test(body.workspaceId)) {
      throw new HttpError(400, 'invalid or missing Qwen workspaceId')
    }
    request.workspaceId = body.workspaceId
    if (body.region !== undefined && body.region !== 'cn-beijing' && body.region !== 'ap-southeast-1') {
      throw new HttpError(400, 'unsupported Qwen region')
    }
    request.region = (body.region as QwenRegion | undefined) ?? 'cn-beijing'
  }
  return request
}

export function qwenEndpoint(request: SignalRequest): string {
  if (request.provider !== 'qwen' || request.workspaceId === undefined) throw new Error('Qwen request required')
  const region = request.region ?? 'cn-beijing'
  const domain = 'maas.aliyuncs.com'
  const model = encodeURIComponent(request.model ?? 'qwen3.5-omni-plus-realtime')
  return `https://${request.workspaceId}.${region}.${domain}/api/v1/webrtc/realtime?model=${model}`
}

export function normalizeSdp(sdp: string): string {
  return sdp.replace(/\r?\n/g, '\r\n').replace(/(?:\r\n)*$/, '\r\n')
}

export async function exchangeQwenSdp(request: SignalRequest, apiKey: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(qwenEndpoint(request), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/sdp' },
    body: request.sdp,
    signal,
  })
  return responseSdp(response)
}

export async function exchangeOpenAiSdp(request: SignalRequest, apiKey: string, signal: AbortSignal): Promise<string> {
  const session = {
    type: 'realtime',
    model: request.model ?? 'gpt-realtime-2.1',
    instructions: request.instructions,
    audio: { output: { voice: request.voice ?? 'marin' } },
  }
  const form = new FormData()
  form.set('sdp', request.sdp)
  form.set('session', JSON.stringify(session))
  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  })
  return responseSdp(response)
}

async function responseSdp(response: Response): Promise<string> {
  const text = await response.text()
  if (!response.ok) {
    const safe = text.replace(/[\r\n]+/g, ' ').slice(0, 400)
    throw new HttpError(502, `provider signaling failed (${response.status}): ${safe}`)
  }
  if (text.length < 8 || text.length > 120_000) throw new HttpError(502, 'provider returned invalid SDP')
  return normalizeSdp(text)
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, 'invalid text field')
  return value
}
