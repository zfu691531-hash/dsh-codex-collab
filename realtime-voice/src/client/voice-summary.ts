import { VOICE_SUMMARY_END, VOICE_SUMMARY_START } from '../voice-contract.ts'

export { VOICE_SUMMARY_END, VOICE_SUMMARY_START } from '../voice-contract.ts'

const MAX_SUMMARY_WEIGHT = 320

/**
 * Consumes Harness text deltas and emits only completed sentences inside the
 * voice-summary markers. The closing marker may be split across any number of
 * chunks, so a matching suffix is retained until it becomes unambiguous.
 */
export class VoiceSummaryStream {
  private input = ''
  private pendingSpeech = ''
  private started = false
  private ended = false
  private emitted = false
  private acceptedWeight = 0

  constructor(private readonly emit: (sentence: string) => void) {}

  push(delta: string): void {
    if (delta === '' || this.ended) return
    this.input = normalizeSummaryMarkers(this.input + delta)
    if (!this.started) {
      const start = this.input.indexOf(VOICE_SUMMARY_START)
      if (start < 0) {
        // Some models insert spaces inside the HTML comment even when asked
        // for the exact marker. Keep a small bounded tail until the complete
        // comment arrives, then normalize it to the canonical marker.
        this.input = this.input.slice(-64)
        return
      }
      this.started = true
      this.input = this.input.slice(start + VOICE_SUMMARY_START.length)
    }
    this.drain(false)
  }

  finish(finalText: string): void {
    if (!this.ended) this.drain(true)
    if (this.pendingSpeech.trim() !== '') this.emitSpeech(this.pendingSpeech)
    this.pendingSpeech = ''
    if (!this.emitted) {
      const fallback = extractVoiceSummary(finalText)
      if (fallback !== '') this.emitSpeech(fallback)
    }
  }

  private drain(final: boolean): void {
    if (!this.started || this.ended) return
    const end = this.input.indexOf(VOICE_SUMMARY_END)
    if (end >= 0) {
      this.accept(this.input.slice(0, end), true)
      this.input = ''
      this.ended = true
      return
    }
    if (final) {
      this.accept(this.input, true)
      this.input = ''
      return
    }
    const held = partialMarkerSuffixLength(this.input, VOICE_SUMMARY_END)
    const safeLength = this.input.length - held
    if (safeLength <= 0) return
    this.accept(this.input.slice(0, safeLength), false)
    this.input = this.input.slice(safeLength)
  }

  private accept(text: string, flush: boolean): void {
    if (text === '') return
    const remaining = MAX_SUMMARY_WEIGHT - this.acceptedWeight
    if (remaining <= 0) return
    const bounded = takeWeighted(text, remaining)
    this.acceptedWeight += speechWeight(bounded)
    this.pendingSpeech += bounded

    let boundary = completedSentenceBoundary(this.pendingSpeech)
    while (boundary > 0) {
      const sentence = this.pendingSpeech.slice(0, boundary)
      this.pendingSpeech = this.pendingSpeech.slice(boundary)
      this.emitSpeech(sentence)
      boundary = completedSentenceBoundary(this.pendingSpeech)
    }
    if (flush && this.pendingSpeech.trim() !== '') {
      this.emitSpeech(this.pendingSpeech)
      this.pendingSpeech = ''
    }
  }

  private emitSpeech(text: string): void {
    const clean = cleanSpeechText(text)
    if (clean === '') return
    this.emitted = true
    this.emit(clean)
  }
}

export function extractVoiceSummary(text: string): string {
  text = normalizeSummaryMarkers(text)
  const start = text.indexOf(VOICE_SUMMARY_START)
  if (start >= 0) {
    const bodyStart = start + VOICE_SUMMARY_START.length
    const end = text.indexOf(VOICE_SUMMARY_END, bodyStart)
    return cleanSpeechText(takeWeighted(text.slice(bodyStart, end < 0 ? undefined : end), MAX_SUMMARY_WEIGHT))
  }
  // Safe compatibility fallback for models that miss the contract: speak only
  // the first visible paragraph/sentence, never the complete detailed answer.
  const visible = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .trim()
  const paragraph = visible.split(/\n\s*\n/)[0] ?? ''
  const boundary = completedSentenceBoundary(paragraph)
  return cleanSpeechText(takeWeighted(boundary > 0 ? paragraph.slice(0, boundary) : paragraph, 180))
}

function normalizeSummaryMarkers(text: string): string {
  return text
    .replace(/<!--\s*voice-summary\s*-->/gi, VOICE_SUMMARY_START)
    .replace(/<!--\s*\/voice-summary\s*-->/gi, VOICE_SUMMARY_END)
}

function completedSentenceBoundary(text: string): number {
  const match = /[。！？!?；;](?:[”’」』】）)])?/u.exec(text)
  if (match === null || match.index === undefined) return 0
  return match.index + match[0].length
}

function cleanSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!??\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[>*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function partialMarkerSuffixLength(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1)
  for (let length = max; length > 0; length--) {
    if (text.endsWith(marker.slice(0, length))) return length
  }
  return 0
}

function takeWeighted(text: string, limit: number): string {
  let weight = 0
  let result = ''
  for (const char of text) {
    const next = speechWeight(char)
    if (weight + next > limit) break
    result += char
    weight += next
  }
  return result
}

function speechWeight(text: string): number {
  let value = 0
  for (const char of text) value += /[\u3400-\u9fff\uf900-\ufaff]/u.test(char) ? 2 : 1
  return value
}
