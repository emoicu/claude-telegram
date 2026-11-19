// Turn-failure alerts: what to tell the chat when a turn ends on an API
// error (Claude Code's StopFailure hook). Pure functions; the hook script
// does the I/O.

/** Fields of the StopFailure hook input that matter here. */
export type FailureInput = {
  /** rate_limit, authentication_failed, billing_error, server_error, ... */
  error?: string
  /** e.g. "429 Too Many Requests" */
  error_details?: string
  /** The error text shown in the conversation, e.g. "API Error: Rate limit reached". */
  last_assistant_message?: string
}

type Kind = { title: string; hint: string }

const KINDS: Record<string, Kind> = {
  rate_limit: {
    title: 'Usage or rate limit reached',
    hint: 'Claude cannot answer until the limit resets. Send /usage to see when.',
  },
  server_error: {
    title: 'The Claude API is overloaded or failing',
    hint: 'This is usually temporary. Send your message again in a minute.',
  },
  authentication_failed: {
    title: 'Claude Code is not logged in',
    hint: 'The login is missing or has expired. Run /login in the terminal.',
  },
  oauth_org_not_allowed: {
    title: 'This organization may not use Claude Code',
    hint: 'Log in with another account (/login in the terminal) or ask the organization admin.',
  },
  account_on_hold: {
    title: 'The account is on hold',
    hint: 'Check the account at claude.ai.',
  },
  billing_error: {
    title: 'Billing problem',
    hint: 'Check the plan or payment method at claude.ai.',
  },
  invalid_request: {
    title: 'The API rejected the request',
    hint: 'Often the conversation or an attachment is too large. Try /new or a smaller file.',
  },
  model_not_found: {
    title: 'The selected model is not available',
    hint: 'Switch to another one with /model.',
  },
  max_output_tokens: {
    title: 'The reply hit the output limit',
    hint: 'Ask Claude to continue.',
  },
  cloud_credential_error: {
    title: 'Cloud provider credentials failed',
    hint: 'Check the Bedrock / Vertex credentials on the host.',
  },
}

const UNKNOWN: Kind = {
  title: 'The turn stopped on an error',
  hint: 'Send your message again; if it keeps failing, check the terminal.',
}

const MAX_DETAIL = 300

const clip = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > MAX_DETAIL ? `${one.slice(0, MAX_DETAIL - 1)}…` : one
}

/** Plain-text alert for the chat. */
export function failureMessage(input: FailureInput): string {
  const kind = KINDS[input.error ?? ''] ?? UNKNOWN
  const lines = [`⚠️ ${kind.title}`]
  // The conversation's error text often says when a limit resets; show it
  // as is, plus the HTTP detail when it adds something.
  const shown = input.last_assistant_message ? clip(input.last_assistant_message) : ''
  const detail = input.error_details ? clip(input.error_details) : ''
  if (shown) lines.push(`“${shown}”`)
  if (detail && !shown.includes(detail)) lines.push(`Details: ${detail}`)
  lines.push('', kind.hint)
  return lines.join('\n')
}

/** Alerts of the same kind closer together than this are dropped. */
export const ALERT_COOLDOWN_MS = 10 * 60_000

/**
 * Decide whether to send an alert for `key` (session + error type) and
 * record it. A failing session tends to fail every turn; one alert per
 * cooldown is enough. Mutates `sent`; returns true when the alert should go.
 */
export function takeAlertSlot(
  sent: Record<string, number>,
  key: string,
  now: number,
  cooldownMs: number = ALERT_COOLDOWN_MS,
): boolean {
  for (const [k, at] of Object.entries(sent)) if (now - at >= cooldownMs) delete sent[k]
  if (key in sent) return false
  sent[key] = now
  return true
}
