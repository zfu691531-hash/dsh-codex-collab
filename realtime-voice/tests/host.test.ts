import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply, isHostDependencies, type HostDependencies } from '../src/index.ts'

function request(body = {}, method = 'POST') {
  const req = Readable.from([JSON.stringify(body)]) as Readable & Record<string, unknown>
  req.method = method
  req.headers = {
    host: '127.0.0.1:52628',
    origin: 'http://127.0.0.1:52628',
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
  }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

function response() {
  const result = { status: 0, headers: {} as Record<string, string>, body: '' }
  return {
    result,
    value: {
      writeHead(status: number, headers: Record<string, string>) { result.status = status; result.headers = headers },
      end(body = '') { result.body = String(body) },
    },
  }
}

function fixture(configured: boolean) {
  const routes = new Map<string, (req: never, res: never) => Promise<void> | void>()
  const upgrades = new Map<string, (req: never, socket: never, head: Buffer) => Promise<void> | void>()
  const disposers: Array<() => void> = []
  let exchanged = 0
  let voiceContextProvider: ((context: { agent?: { id: string } }) => string) | undefined
  const dependencies: HostDependencies = {
    exchangeOpenAi: async () => { exchanged++; return 'v=0\r\na=answer\r\n' },
    exchangeQwen: async () => { exchanged++; return 'v=0\r\na=answer\r\n' },
  }
  const ctx = {
    credentials: {
      resolve: async () => configured ? { value: 'fake-test-key', source: 'test' } : undefined,
      describe: async () => ({ configured, writable: false }),
    },
    webServer: {
      register(route: { path: string; handler: (req: never, res: never) => Promise<void> | void }) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
      registerUpgrade(route: { path: string; handler: (req: never, socket: never, head: Buffer) => Promise<void> | void }) {
        upgrades.set(route.path, route.handler)
        return () => upgrades.delete(route.path)
      },
    },
    systemPrompt: {
      context(input: { text: string | ((context: { agent?: { id: string } }) => string) }) {
        voiceContextProvider = typeof input.text === 'function' ? input.text : () => input.text
        return () => { voiceContextProvider = undefined }
      },
    },
    effect(callback: () => void | (() => void)) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
    get() { return undefined },
    logger: { info() {}, warn() {} },
  }
  apply(ctx as never, dependencies)
  return { routes, upgrades, disposers, exchanged: () => exchanged, voiceContext: (sessionId: string) => voiceContextProvider?.({ agent: { id: sessionId } }) ?? '' }
}

test('host routes dispose cleanly and can be mounted again', () => {
  const one = fixture(false)
  assert.deepEqual([...one.routes.keys()].sort(), [
    '/dsh-realtime-voice/context',
    '/dsh-realtime-voice/prefs',
    '/dsh-realtime-voice/signaling/openai',
    '/dsh-realtime-voice/signaling/qwen',
    '/dsh-realtime-voice/status',
  ])
  assert.deepEqual([...one.upgrades.keys()].sort(), [
    '/dsh-realtime-voice/asr/qwen',
    '/dsh-realtime-voice/tts/qwen',
  ])
  one.disposers.forEach(dispose => dispose())
  assert.equal(one.routes.size, 0)
  assert.equal(one.upgrades.size, 0)
  const two = fixture(false)
  assert.equal(two.routes.size, 5)
  assert.equal(two.upgrades.size, 2)
})

test('voice output contract is session-scoped runtime context, not route-visible prompt text', async () => {
  const fx = fixture(false)
  assert.equal(fx.voiceContext('voice-session'), '')

  const on = response()
  await fx.routes.get('/dsh-realtime-voice/context')?.(
    request({ sessionId: 'voice-session', active: true }, 'PUT') as never,
    on.value as never,
  )
  assert.equal(on.result.status, 200)
  assert.match(fx.voiceContext('voice-session'), /voice-summary/)
  assert.equal(fx.voiceContext('other-session'), '')

  const off = response()
  await fx.routes.get('/dsh-realtime-voice/context')?.(
    request({ sessionId: 'voice-session', active: false }, 'PUT') as never,
    off.value as never,
  )
  assert.equal(off.result.status, 200)
  assert.equal(fx.voiceContext('voice-session'), '')
})

test('voice context endpoint rejects cross-site activation', async () => {
  const fx = fixture(false)
  const req = request({ sessionId: 'voice-session', active: true }, 'PUT')
  ;(req.headers as Record<string, string>)['sec-fetch-site'] = 'cross-site'
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/context')?.(req as never, res.value as never)
  assert.equal(res.result.status, 403)
  assert.equal(fx.voiceContext('voice-session'), '')
})

test('signaling refuses missing credentials without network exchange', async () => {
  const fx = fixture(false)
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/signaling/openai')?.(
    request({ sdp: 'v=0\r\na=offer\r\n' }) as never,
    res.value as never,
  )
  assert.equal(res.result.status, 502)
  assert.match(res.result.body, /OPENAI_API_KEY/)
  assert.equal(fx.exchanged(), 0)
})

test('configured signaling exchanges canned SDP and never returns the key', async () => {
  const fx = fixture(true)
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/signaling/openai')?.(
    request({ sdp: 'v=0\r\na=offer\r\n' }) as never,
    res.value as never,
  )
  assert.equal(res.result.status, 200)
  assert.match(res.result.body, /a=answer/)
  assert.doesNotMatch(res.result.body, /fake-test-key/)
  assert.equal(fx.exchanged(), 1)
})

test('cross-site signaling is rejected before credential resolution', async () => {
  const fx = fixture(true)
  const req = request({ sdp: 'v=0\r\na=offer\r\n' })
  ;(req.headers as Record<string, string>)['sec-fetch-site'] = 'cross-site'
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/signaling/openai')?.(req as never, res.value as never)
  assert.equal(res.result.status, 403)
  assert.equal(fx.exchanged(), 0)
})

test('cordis install shape: config objects do not masquerade as host dependencies', () => {
  // cordis calls apply(ctx, config); the installed `config: {}` must not be
  // mistaken for the optional test-injection object.
  assert.equal(isHostDependencies({}), false)
  assert.equal(isHostDependencies(undefined), false)
  assert.equal(isHostDependencies(null), false)
  assert.equal(isHostDependencies({ exchangeOpenAi: async () => '' }), false)
  assert.equal(isHostDependencies({
    exchangeOpenAi: async () => '',
    exchangeQwen: async () => '',
  } satisfies HostDependencies), true)
})
