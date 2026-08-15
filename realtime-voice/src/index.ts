import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { HttpError, isLoopbackRequest, readJsonBody } from './host/security.ts'
import {
  exchangeOpenAiSdp,
  exchangeQwenSdp,
  parseSignalRequest,
  type Provider,
  type SignalRequest,
} from './host/signaling.ts'
import { QwenSpeechProxy } from './host/qwen-speech-proxy.ts'
import { VOICE_OUTPUT_CONTEXT } from './voice-contract.ts'

export const name = 'dsh-realtime-voice'
export const inject = ['webServer', 'credentials', 'settings', 'systemPrompt']

const PREFS_NS = 'dsh-realtime-voice'

interface CredentialService {
  resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string; source: string } | undefined>
  describe(ref: ReturnType<typeof credentialRef>): Promise<{ configured: boolean; source?: string; writable: boolean }>
}

interface WebServerService {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }): () => void
}

interface SettingsService {
  register<T>(ns: string, schema: z<T>, options?: object): SettingsScope<T>
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; user?: unknown }>
}

interface SettingsScope<T> {
  get(): T
  update(patch: object): Promise<void>
}

interface PromptAssembleContext {
  agent?: { id: string }
}

interface SystemPromptService {
  context(input: {
    name: string
    order: number
    text: string | ((context: PromptAssembleContext) => string)
  }): () => void
}

interface HostContext {
  credentials: CredentialService
  webServer: WebServerService
  systemPrompt: SystemPromptService
  get(name: 'settings'): SettingsService | undefined
  get(name: string): unknown
  effect(callback: () => void | (() => void), label?: string): void
  logger: { info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void }
}

export interface HostDependencies {
  exchangeOpenAi(request: SignalRequest, key: string, signal: AbortSignal): Promise<string>
  exchangeQwen(request: SignalRequest, key: string, signal: AbortSignal): Promise<string>
}

const productionDependencies: HostDependencies = {
  exchangeOpenAi: exchangeOpenAiSdp,
  exchangeQwen: exchangeQwenSdp,
}

const DEFAULT_INSTRUCTIONS = '请用自然、简洁、适合口语播报的中文表达，并允许用户随时打断。'

const prefsSchema = z.object({
  provider: z.string().default('qwen'),
  qwenWorkspaceId: z.string().default(''),
  qwenRegion: z.string().default('cn-beijing'),
  qwenModel: z.string().default('qwen3.5-omni-plus-realtime'),
  qwenVoice: z.string().default('Tina'),
  qwenAsrModel: z.string().default('qwen3-asr-flash-realtime'),
  qwenTtsModel: z.string().default('qwen3-tts-flash-realtime'),
  qwenTtsVoice: z.string().default('Chelsie'),
  qwenVadThreshold: z.number().default(0.85),
  qwenSilenceMs: z.number().default(700),
  qwenMergeMs: z.number().default(1200),
  openaiModel: z.string().default('gpt-realtime-2.1'),
  openaiVoice: z.string().default('marin'),
  instructions: z.string().default(DEFAULT_INSTRUCTIONS),
})

export function apply(ctx: HostContext, dependencies: HostDependencies = productionDependencies): void {
  // cordis invokes apply(ctx, config) with the plugin's config as the second
  // argument — the installed `config: {}` would otherwise override the
  // production default and leave exchangeOpenAi/exchangeQwen undefined.
  const deps = isHostDependencies(dependencies) ? dependencies : productionDependencies
  const activeVoiceSessions = new Map<string, number>()
  const voiceContextTtlMs = 15 * 60_000
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'dsh-realtime-voice:output-contract',
    order: 900,
    text: context => {
      const sessionId = context.agent?.id
      if (sessionId === undefined) return ''
      const expiresAt = activeVoiceSessions.get(sessionId)
      if (expiresAt === undefined) return ''
      if (expiresAt <= Date.now()) {
        activeVoiceSessions.delete(sessionId)
        return ''
      }
      return VOICE_OUTPUT_CONTEXT
    },
  }), 'dsh-realtime-voice: hidden output context')
  const qwenSpeech = new QwenSpeechProxy(async () => {
    const credential = await ctx.credentials.resolve(credentialRef('DASHSCOPE_API_KEY'))
    return credential?.value
  })
  ctx.effect(() => () => qwenSpeech.close(), 'dsh-realtime-voice: close qwen speech proxy')
  // Persist user prefs (provider, Workspace ID, model, voice, instructions)
  // through the settings service into the harness settings document, so the
  // config survives browser switches and loopback port changes. This is the
  // same document as ~/.dsh/settings.yaml; the browser localStorage is only
  // a cache on the client side.
  const settings = ctx.get('settings')
  let prefsScope: SettingsScope<unknown> | undefined
  if (settings !== undefined) {
    ctx.effect(() => {
      try {
        prefsScope = settings.register(PREFS_NS, prefsSchema, {})
      } catch (error) {
        ctx.logger.warn(`dsh-realtime-voice: settings register failed: ${error instanceof Error ? error.message : String(error)}`)
        prefsScope = undefined
      }
    }, 'dsh-realtime-voice: settings namespace')
  }
  for (const provider of ['openai', 'qwen'] as const) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `/dsh-realtime-voice/signaling/${provider}`,
      handler: (req, res) => handleSignal(ctx, deps, provider, req, res),
    }), `dsh-realtime-voice: ${provider} signaling`)
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-realtime-voice/status',
    handler: (req, res) => handleStatus(ctx, req, res),
  }), 'dsh-realtime-voice: status')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-realtime-voice/prefs',
    handler: (req, res) => handlePrefs(ctx, () => prefsScope, req, res),
  }), 'dsh-realtime-voice: prefs')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-realtime-voice/context',
    handler: (req, res) => handleVoiceContext(activeVoiceSessions, voiceContextTtlMs, req, res),
  }), 'dsh-realtime-voice: per-session output context')
  for (const kind of ['asr', 'tts'] as const) {
    ctx.effect(() => ctx.webServer.registerUpgrade({
      path: `/dsh-realtime-voice/${kind}/qwen`,
      handler: (req, socket, head) => qwenSpeech.handle(kind, req, socket, head),
    }), `dsh-realtime-voice: qwen ${kind} websocket`)
  }
  ctx.logger.info('dsh-realtime-voice host bridge ready')
}

async function handleVoiceContext(
  activeVoiceSessions: Map<string, number>,
  ttlMs: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== 'PUT') throw new HttpError(405, 'method not allowed')
    if (!isLoopbackRequest(req)) throw new HttpError(403, 'loopback same-origin request required')
    const body = await readJsonBody(req)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'context body must be an object')
    const { sessionId, active } = body as Record<string, unknown>
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256) throw new HttpError(400, 'invalid sessionId')
    if (typeof active !== 'boolean') throw new HttpError(400, 'active must be boolean')
    if (active) activeVoiceSessions.set(sessionId, Date.now() + ttlMs)
    else activeVoiceSessions.delete(sessionId)
    sendJson(res, 200, { ok: true })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502
    const message = error instanceof Error ? error.message : 'voice context failed'
    sendJson(res, status, { error: message })
  }
}

export function isHostDependencies(value: unknown): value is HostDependencies {
  return typeof value === 'object' && value !== null
    && typeof (value as HostDependencies).exchangeOpenAi === 'function'
    && typeof (value as HostDependencies).exchangeQwen === 'function'
}

async function handleSignal(
  ctx: HostContext,
  dependencies: HostDependencies,
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
    if (!isLoopbackRequest(req)) throw new HttpError(403, 'loopback same-origin request required')
    const body = parseSignalRequest(await readJsonBody(req), provider)
    const ref = credentialRef(provider === 'openai' ? 'OPENAI_API_KEY' : 'DASHSCOPE_API_KEY')
    const credential = await ctx.credentials.resolve(ref)
    if (credential === undefined || credential.value.trim() === '') throw new HttpError(502, `${ref} is not configured`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('signaling timeout')), 20_000)
    try {
      const answer = provider === 'openai'
        ? await dependencies.exchangeOpenAi(body, credential.value, controller.signal)
        : await dependencies.exchangeQwen(body, credential.value, controller.signal)
      sendText(res, 200, answer, 'application/sdp')
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502
    const message = error instanceof Error ? error.message : 'signaling failed'
    sendJson(res, status, { error: message })
  }
}

async function handleStatus(ctx: HostContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
  if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'loopback same-origin request required' })
  const [openai, qwen] = await Promise.all([
    ctx.credentials.describe(credentialRef('OPENAI_API_KEY')),
    ctx.credentials.describe(credentialRef('DASHSCOPE_API_KEY')),
  ])
  sendJson(res, 200, {
    openai: { configured: openai.configured },
    qwen: { configured: qwen.configured },
    desktopMicrophone: false,
    externalBrowserRequired: true,
  })
}

async function handlePrefs(
  ctx: HostContext,
  getScope: () => SettingsScope<unknown> | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== 'GET' && req.method !== 'PUT') throw new HttpError(405, 'method not allowed')
    if (!isLoopbackRequest(req)) throw new HttpError(403, 'loopback same-origin request required')
    const scope = getScope()
    if (req.method === 'GET') {
      if (scope === undefined) return sendJson(res, 200, { hasUserData: false, prefs: {} })
      let hasUserData = false
      const settings = ctx.get('settings')
      if (settings !== undefined) {
        const descriptor = settings.describe().find(item => item.ns === PREFS_NS)
        hasUserData = descriptor?.user !== undefined && descriptor.user !== null
          && typeof descriptor.user === 'object'
          && Object.keys(descriptor.user as object).length > 0
      }
      const stored = scope.get() ?? {}
      sendJson(res, 200, { hasUserData, prefs: sanitizePrefs(stored) })
      return
    }
    const body = await readJsonBody(req)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'prefs body must be an object')
    if (scope === undefined) throw new HttpError(503, 'settings storage unavailable')
    await scope.update(sanitizePrefs(body))
    sendJson(res, 200, { ok: true })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502
    const message = error instanceof Error ? error.message : 'prefs failed'
    sendJson(res, status, { error: message })
  }
}

function sanitizePrefs(value: unknown): Record<string, unknown> {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const text = (v: unknown, max: number) => typeof v === 'string' ? v.slice(0, max) : ''
  return {
    provider: source.provider === 'openai' ? 'openai' : 'qwen',
    qwenWorkspaceId: text(source.qwenWorkspaceId, 128),
    qwenRegion: source.qwenRegion === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing',
    qwenModel: text(source.qwenModel, 128) || 'qwen3.5-omni-plus-realtime',
    qwenVoice: text(source.qwenVoice, 128) || 'Tina',
    qwenAsrModel: text(source.qwenAsrModel, 128) || 'qwen3-asr-flash-realtime',
    qwenTtsModel: text(source.qwenTtsModel, 128) || 'qwen3-tts-flash-realtime',
    qwenTtsVoice: text(source.qwenTtsVoice, 128) || 'Chelsie',
    qwenVadThreshold: numberInRange(source.qwenVadThreshold, -1, 1, 0.85),
    qwenSilenceMs: numberInRange(source.qwenSilenceMs, 200, 6000, 700),
    qwenMergeMs: numberInRange(source.qwenMergeMs, 100, 5000, 1200),
    openaiModel: text(source.openaiModel, 128) || 'gpt-realtime-2.1',
    openaiVoice: text(source.openaiVoice, 128) || 'marin',
    instructions: text(source.instructions, 12_000) || DEFAULT_INSTRUCTIONS,
  }
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  sendText(res, status, JSON.stringify(value), 'application/json; charset=utf-8')
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

export { isLoopbackRequest, readJsonBody } from './host/security.ts'
export { normalizeSdp, parseSignalRequest, qwenEndpoint } from './host/signaling.ts'
