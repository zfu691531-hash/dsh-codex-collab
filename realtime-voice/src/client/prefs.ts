export type VoiceProviderId = 'qwen' | 'openai'
export type QwenRegion = 'cn-beijing' | 'ap-southeast-1'

export interface VoicePrefs {
  provider: VoiceProviderId
  qwenWorkspaceId: string
  qwenRegion: QwenRegion
  qwenModel: string
  qwenVoice: string
  qwenAsrModel: string
  qwenTtsModel: string
  qwenTtsVoice: string
  qwenVadThreshold: number
  qwenSilenceMs: number
  qwenMergeMs: number
  openaiModel: string
  openaiVoice: string
  instructions: string
}

const KEY = 'dsh-realtime-voice:prefs:v1'
const PREFS_URL = '/dsh-realtime-voice/prefs'
const DEFAULTS: VoicePrefs = {
  provider: 'qwen',
  qwenWorkspaceId: '',
  qwenRegion: 'cn-beijing',
  qwenModel: 'qwen3.5-omni-plus-realtime',
  qwenVoice: 'Tina',
  qwenAsrModel: 'qwen3-asr-flash-realtime',
  qwenTtsModel: 'qwen3-tts-flash-realtime',
  qwenTtsVoice: 'Chelsie',
  qwenVadThreshold: 0.85,
  qwenSilenceMs: 700,
  qwenMergeMs: 1200,
  openaiModel: 'gpt-realtime-2.1',
  openaiVoice: 'marin',
  instructions: '请用自然、简洁、适合口语播报的中文表达，并允许用户随时打断。',
}

let cache: VoicePrefs | undefined
const listeners = new Set<() => void>()

export function loadPrefs(): VoicePrefs {
  if (cache !== undefined) return cache
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<VoicePrefs>
    cache = sanitize({ ...DEFAULTS, ...parsed })
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function updatePrefs(patch: Partial<VoicePrefs>): VoicePrefs {
  cache = sanitize({ ...loadPrefs(), ...patch })
  localStorage.setItem(KEY, JSON.stringify(cache))
  persistPrefs(cache)
  listeners.forEach(listener => listener())
  return cache
}

/** Push the current prefs to the host bridge so they survive browser switches and port changes. */
export function persistPrefs(prefs: VoicePrefs): void {
  try {
    fetch(PREFS_URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prefs),
      cache: 'no-store',
    }).catch(() => {})
  } catch {
    // fetch unavailable; localStorage remains the cache
  }
}

function hasCustomPrefs(prefs: VoicePrefs): boolean {
  return prefs.provider !== 'qwen'
    || prefs.qwenWorkspaceId !== ''
    || prefs.qwenModel !== DEFAULTS.qwenModel
    || prefs.qwenVoice !== DEFAULTS.qwenVoice
    || prefs.qwenAsrModel !== DEFAULTS.qwenAsrModel
    || prefs.qwenTtsModel !== DEFAULTS.qwenTtsModel
    || prefs.qwenTtsVoice !== DEFAULTS.qwenTtsVoice
    || prefs.qwenVadThreshold !== DEFAULTS.qwenVadThreshold
    || prefs.qwenSilenceMs !== DEFAULTS.qwenSilenceMs
    || prefs.qwenMergeMs !== DEFAULTS.qwenMergeMs
    || prefs.openaiModel !== DEFAULTS.openaiModel
    || prefs.openaiVoice !== DEFAULTS.openaiVoice
    || prefs.instructions !== DEFAULTS.instructions
}

/**
 * One-shot hydration: pull prefs persisted on the host (settings document) and
 * merge them over localStorage. When the host has nothing yet but this browser
 * already has custom values (pre-fix state), push them up so they are saved.
 */
export function hydrateFromHost(): void {
  fetch(PREFS_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
    .then(response => response.ok ? response.json() : null)
    .then((data: { hasUserData?: boolean; prefs?: Partial<VoicePrefs> } | null) => {
      const local = loadPrefs()
      if (data && data.hasUserData && typeof data.prefs === 'object' && data.prefs !== null) {
        cache = sanitize({ ...local, ...data.prefs })
        localStorage.setItem(KEY, JSON.stringify(cache))
        listeners.forEach(listener => listener())
      } else if (hasCustomPrefs(local)) {
        persistPrefs(local)
      }
    })
    .catch(() => {
      // host bridge unavailable; keep localStorage
    })
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function sanitize(value: VoicePrefs): VoicePrefs {
  return {
    provider: value.provider === 'openai' ? 'openai' : 'qwen',
    qwenWorkspaceId: text(value.qwenWorkspaceId, 128),
    qwenRegion: value.qwenRegion === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing',
    qwenModel: text(value.qwenModel, 128) || DEFAULTS.qwenModel,
    qwenVoice: text(value.qwenVoice, 128) || DEFAULTS.qwenVoice,
    qwenAsrModel: text(value.qwenAsrModel, 128) || DEFAULTS.qwenAsrModel,
    qwenTtsModel: text(value.qwenTtsModel, 128) || DEFAULTS.qwenTtsModel,
    qwenTtsVoice: text(value.qwenTtsVoice, 128) || DEFAULTS.qwenTtsVoice,
    qwenVadThreshold: numberInRange(value.qwenVadThreshold, -1, 1, DEFAULTS.qwenVadThreshold),
    qwenSilenceMs: numberInRange(value.qwenSilenceMs, 200, 6000, DEFAULTS.qwenSilenceMs),
    qwenMergeMs: numberInRange(value.qwenMergeMs, 100, 5000, DEFAULTS.qwenMergeMs),
    openaiModel: text(value.openaiModel, 128) || DEFAULTS.openaiModel,
    openaiVoice: text(value.openaiVoice, 128) || DEFAULTS.openaiVoice,
    instructions: text(value.instructions, 12_000) || DEFAULTS.instructions,
  }
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
