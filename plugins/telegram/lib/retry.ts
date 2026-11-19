// When to retry a failed Bot API call. Telegram answers bursts with 429 and
// a retry_after; its servers occasionally return 5xx; connections drop.
// Without retries a reply could be lost silently. A network error may hide
// a request that did go through, so only calls that are safe to repeat are
// retried then; a send is not, it could post the message twice.

export type Failure = {
  /** HTTP-like error code from the Bot API (429, 500, ...). */
  status?: number
  /** Seconds, from parameters.retry_after. */
  retryAfter?: number
  /** The request failed before an answer came back. */
  network?: boolean
}

export const MAX_ATTEMPTS = 4
/** A longer flood wait is not worth blocking a tool call for. */
export const MAX_RETRY_AFTER_S = 60
const BASE_MS = 1000

/** Methods that do the same thing when repeated. */
export function isRepeatable(method: string): boolean {
  return /^(get|edit|delete|set|answer|pin|unpin)/.test(method)
}

/** Milliseconds to wait before attempt `attempt + 1`, or undefined to give up. */
export function retryDelayMs(method: string, attempt: number, f: Failure): number | undefined {
  if (method === 'getUpdates' || attempt + 1 >= MAX_ATTEMPTS) return undefined
  if (f.status === 429) {
    const after = f.retryAfter ?? 1
    return after <= MAX_RETRY_AFTER_S ? after * 1000 + 250 : undefined
  }
  const backoff = BASE_MS * 2 ** attempt
  if (f.status != null && f.status >= 500) return backoff
  if (f.network && isRepeatable(method)) return backoff
  return undefined
}
