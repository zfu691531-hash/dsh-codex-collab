import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

export type Context = ClientContext

export interface RpcResult<T> {
  rpcId: string
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
}

export interface RpcApi {
  sessions: {
    prompt(payload: {
      sessionId: string
      mode: 'queue' | 'steer'
      content: Array<{ type: 'text'; text: string }>
      clientTimeZone?: string
    }, signal?: AbortSignal): Promise<RpcResult<{ accepted: true }>>
    updateQueue(payload: {
      sessionId: string
      itemId: string
      action: { kind: 'remove' }
    }, signal?: AbortSignal): Promise<RpcResult<{ accepted: true }>>
    cancel(payload: { sessionId: string }, signal?: AbortSignal): Promise<RpcResult<{ accepted: true }>>
  }
  events: {
    mux(payload: { since?: Record<string, number> }, signal: AbortSignal): AsyncIterable<{
      payload: MuxFrame
    }>
  }
}

export type MuxFrame =
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  | { type: 'session/queue'; sessionId: string; items: QueueItem[] }
  | { type: 'session/event'; sessionId: string; event: SessionEvent }
  | { type: 'stream/error'; error: { code: string; message: string } }

export interface QueueItem {
  id: string
  placement: 'queued' | 'steering' | 'context'
  message: { source?: { kind?: string; rpcId?: string } }
}

export interface SessionEvent {
  seq?: number
  type: string
  data?: Record<string, unknown>
}
