// Turn-failure alerts: what to tell the chat when a turn ends on an API
// error (Claude Code's StopFailure hook). Pure functions; the hook script
// does the I/O.

import { type T, tEn } from './i18n.ts'

/** Fields of the StopFailure hook input that matter here. */
export type FailureInput = {
  /** rate_limit, authentication_failed, billing_error, server_error, ... */
  error?: string
  /** e.g. "429 Too Many Requests" */
  error_details?: string
  /** The error text shown in the conversation, e.g. "API Error: Rate limit reached". */
  last_assistant_message?: string
}

const KINDS = [
  'rate_limit',
  'server_error',
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'max_output_tokens',
  'cloud_credential_error',
] as const

const MAX_DETAIL = 300

const clip = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > MAX_DETAIL ? `${one.slice(0, MAX_DETAIL - 1)}…` : one
}

/** Plain-text alert for the chat. */
export function failureMessage(input: FailureInput, t: T = tEn): string {
  const kind = (KINDS as readonly string[]).includes(input.error ?? '') ? (input.error as (typeof KINDS)[number]) : 'unknown'
  const lines = [`⚠️ ${t(`fail.${kind}`)}`]
  // The conversation's error text often says when a limit resets; show it
  // as is, plus the HTTP detail when it adds something.
  const shown = input.last_assistant_message ? clip(input.last_assistant_message) : ''
  const detail = input.error_details ? clip(input.error_details) : ''
  if (shown) lines.push(`“${shown}”`)
  if (detail && !shown.includes(detail)) lines.push(t('failDetails', { details: detail }))
  lines.push('', t(`fail.${kind}.hint`))
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
