import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { isLoopbackRequest } from './security.ts'

export type QwenSpeechKind = 'asr' | 'tts'

const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/

export class QwenSpeechProxy {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
  private readonly sockets = new Set<WebSocket>()

  constructor(private readonly resolveKey: () => Promise<string | undefined>) {}

  handle = async (kind: QwenSpeechKind, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    if (!isLoopbackRequest(req)) return rejectUpgrade(socket, 403, 'Forbidden')
    let endpoint: string
    let workspaceId: string
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      workspaceId = url.searchParams.get('workspaceId') ?? ''
      const region = url.searchParams.get('region') === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing'
      const model = url.searchParams.get('model') ?? (kind === 'asr' ? 'qwen3-asr-flash-realtime' : 'qwen3-tts-flash-realtime')
      if (!WORKSPACE_RE.test(workspaceId) || !MODEL_RE.test(model)) throw new Error('invalid speech proxy parameters')
      endpoint = kind === 'asr'
        ? `wss://${workspaceId}.${region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`
        : `${region === 'ap-southeast-1' ? 'wss://dashscope-intl.aliyuncs.com' : 'wss://dashscope.aliyuncs.com'}/api-ws/v1/realtime?model=${encodeURIComponent(model)}`
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request')
    }
    const key = await this.resolveKey()
    if (key === undefined || key.trim() === '') return rejectUpgrade(socket, 502, 'Speech credential unavailable')

    this.server.handleUpgrade(req, socket, head, local => {
      this.sockets.add(local)
      const upstream = new WebSocket(endpoint, {
        headers: {
          Authorization: `Bearer ${key}`,
          'X-DashScope-WorkSpace': workspaceId,
          'User-Agent': 'dsh-realtime-voice/0.3',
        },
        maxPayload: 4 * 1024 * 1024,
      })
      this.sockets.add(upstream)
      const pending: Array<{ data: RawData; binary: boolean }> = []

      local.on('message', (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
        else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 256) pending.push({ data, binary })
      })
      upstream.on('open', () => {
        for (const item of pending.splice(0)) upstream.send(item.data, { binary: item.binary })
      })
      upstream.on('message', (data, binary) => {
        if (local.readyState === WebSocket.OPEN) local.send(data, { binary })
      })
      upstream.on('unexpected-response', (_request, response) => {
        sendSafeError(local, `Qwen ${kind.toUpperCase()} connection rejected (${response.statusCode})`)
        local.close(1011, 'upstream rejected')
      })
      upstream.on('error', error => {
        sendSafeError(local, `Qwen ${kind.toUpperCase()} unavailable: ${error.message.slice(0, 180)}`)
      })
      local.on('error', () => upstream.close())
      local.on('close', () => {
        this.sockets.delete(local)
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close()
      })
      upstream.on('close', () => {
        this.sockets.delete(upstream)
        if (local.readyState === WebSocket.OPEN) local.close(1000, 'upstream closed')
      })
    })
  }

  close(): void {
    for (const socket of this.sockets) socket.close(1001, 'plugin disposed')
    this.sockets.clear()
  }
}

function sendSafeError(socket: WebSocket, message: string): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', error: { message } }))
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
