// Taking back a reaction shortcut. A held shortcut (lib/shortcuts.ts) reaches
// Claude only after a short wait; removing the reaction during the wait drops
// it. Removed later, within the undo window, Claude is asked to undo what it
// did; after that, removing a reaction does nothing.
//
// State is in memory: a restart forgets pending and delivered shortcuts.

export type Withdrawal = 'cancelled' | 'undo' | 'ignore'

export type Delivered = { at: number }

export class Holds {
  private pending = new Map<string, ReturnType<typeof setTimeout>>()
  private delivered = new Map<string, Delivered>()

  constructor(
    private readonly holdMs: number,
    private readonly undoMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  static key(chat: string, messageId: number, emoji: string): string {
    return `${chat}:${messageId}:${emoji}`
  }

  /**
   * Run deliver after the hold, or at once when holding is off. A second hold
   * for the same key replaces the first.
   */
  hold(key: string, deliver: () => boolean): void {
    const existing = this.pending.get(key)
    if (existing) clearTimeout(existing)
    const fire = () => {
      this.pending.delete(key)
      if (deliver()) this.markDelivered(key)
    }
    if (this.holdMs <= 0) {
      fire()
      return
    }
    this.pending.set(key, setTimeout(fire, this.holdMs))
  }

  /** Note a shortcut that reached Claude, so removing it later can undo it. */
  markDelivered(key: string): void {
    this.prune()
    if (this.undoMs > 0) this.delivered.set(key, { at: this.now() })
  }

  /** The user removed the reaction. */
  withdraw(key: string): Withdrawal {
    const timer = this.pending.get(key)
    if (timer) {
      clearTimeout(timer)
      this.pending.delete(key)
      return 'cancelled'
    }
    const d = this.delivered.get(key)
    if (!d) return 'ignore'
    this.delivered.delete(key)
    return this.now() - d.at <= this.undoMs ? 'undo' : 'ignore'
  }

  isPending(key: string): boolean {
    return this.pending.has(key)
  }

  private prune(): void {
    const cutoff = this.now() - this.undoMs
    for (const [k, d] of this.delivered) if (d.at < cutoff) this.delivered.delete(k)
  }
}

/** Seconds or minutes from the environment; blank or invalid gives the default. */
export function envDuration(raw: string | undefined, unitMs: number, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback * unitMs
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n * unitMs : fallback * unitMs
}
