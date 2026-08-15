export type TurnPhase = 'listening' | 'endpoint-candidate' | 'harness' | 'tts-pending' | 'tts-speaking' | 'post-playback'

/**
 * Owns voice turn identity and serializes every state-changing event. Audio,
 * Harness and TTS callbacks can arrive from unrelated transports; allowing
 * them to mutate the controller directly is what previously produced mixed
 * turns and stale playback.
 */
export class TurnCoordinator {
  private currentPhase: TurnPhase = 'listening'
  private currentTurn = 0
  private tail = Promise.resolve()

  get phase(): TurnPhase { return this.currentPhase }
  get turnId(): number { return this.currentTurn }

  begin(): number {
    this.currentTurn++
    this.currentPhase = 'harness'
    return this.currentTurn
  }

  transition(turnId: number, phase: TurnPhase): boolean {
    if (turnId !== this.currentTurn) return false
    this.currentPhase = phase
    return true
  }

  isCurrent(turnId: number): boolean { return turnId === this.currentTurn }

  invalidate(): void {
    this.currentTurn++
    this.currentPhase = 'listening'
  }

  enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
