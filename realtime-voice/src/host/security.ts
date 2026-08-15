import type { IncomingMessage } from 'node:http'

const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote !== undefined && !LOOPBACKS.has(remote)) return false
  const host = req.headers.host
  if (host === undefined) return false
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') return false

  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const parsed = new URL(origin)
    return parsed.protocol === 'http:' && parsed.host === host
  } catch {
    return false
  }
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 131_072): Promise<unknown> {
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new HttpError(415, 'content-type must be application/json')
  const chunks: Buffer[] = []
  let total = 0
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    total += chunk.length
    if (total > maxBytes) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}
