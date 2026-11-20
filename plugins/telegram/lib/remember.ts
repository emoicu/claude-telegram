// "Allow and don't ask again" for permission prompts relayed to Telegram.
//
// The channel's permission verdict is only allow or deny for one call. To
// remember a choice, the PermissionRequest hook (hooks/permission-telegram.ts)
// records each prompt's permission suggestions, the button marks the
// matching record as remembered, and the hook then allows later prompts with
// the same suggestions in the same conversation by itself, passing the
// suggestions on to Claude Code as session rules. Besides the two small
// JSON stores at the end, everything here is pure.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A permission update as Claude Code suggests it in the hook input. */
export type Suggestion = {
  type: string
  rules?: { toolName: string; ruleContent?: string }[]
  behavior?: string
  directories?: string[]
  mode?: string
  destination?: string
}

/** A prompt the hook saw, waiting for the user's answer. */
export type PendingPrompt = {
  at: number
  session: string
  tool: string
  /** JSON of the tool input. */
  input: string
  suggestions: Suggestion[]
  /** When the prompt was answered; an answered prompt is never matched again. */
  answered?: number
}

export type Remembered = {
  at: number
  session: string
  key: string
  /** What was remembered, for the chat. */
  label: string
  suggestions: Suggestion[]
}

/** Prompts are matched to button presses for this long. */
export const PENDING_TTL_MS = 10 * 60_000
/** A remembered answer holds this long at most, even in a long conversation. */
export const REMEMBER_TTL_MS = 24 * 3600_000
const MAX_PENDING = 20

/**
 * Suggestions safe to remember: allow rules and extra directories. A mode
 * change (for example to accept all edits) is far broader than the prompt
 * the user saw, so it is never remembered.
 */
export function rememberable(suggestions: Suggestion[] | undefined): Suggestion[] {
  return (suggestions ?? []).filter(
    s => (s.type === 'addRules' && s.behavior === 'allow' && s.rules?.length) || (s.type === 'addDirectories' && s.directories?.length),
  )
}

const ruleText = (r: { toolName: string; ruleContent?: string }): string => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)

/** Human-readable list of what remembering would allow. */
export function describe(suggestions: Suggestion[]): string {
  const parts: string[] = []
  for (const s of suggestions) {
    if (s.type === 'addRules') parts.push(...(s.rules ?? []).map(ruleText))
    if (s.type === 'addDirectories') parts.push(...(s.directories ?? []).map(d => `access to ${d}`))
  }
  return parts.join(', ')
}

/**
 * What identifies "the same kind of prompt": the tool and its rememberable
 * suggestions, or, when Claude Code suggests nothing, the exact same tool
 * call. The tool is part of the key because a suggestion such as an extra
 * directory says nothing about the tool: allowing Read in /etc must not
 * allow Write or Bash there.
 */
export function promptKey(tool: string, input: string, suggestions: Suggestion[] | undefined): string {
  const keep = rememberable(suggestions)
  if (!keep.length) return `exact:${tool}:${input}`
  const norm = keep
    .map(s =>
      s.type === 'addRules'
        ? `rules:${(s.rules ?? []).map(ruleText).sort().join('|')}`
        : `dirs:${[...(s.directories ?? [])].sort().join('|')}`,
    )
    .sort()
  return `tool:${tool}:${norm.join(';')}`
}

/** Label for the chat: the rules, or the exact call when there are none. */
export function promptLabel(p: PendingPrompt): string {
  const keep = rememberable(p.suggestions)
  if (keep.length) return describe(keep)
  const one = p.input.replace(/\s+/g, ' ')
  return `this exact ${p.tool} call${one.length > 2 ? `: ${one.length > 120 ? `${one.slice(0, 119)}…` : one}` : ''}`
}

/** Record a prompt the hook saw. Mutates and returns `list`. */
export function addPending(list: PendingPrompt[], p: PendingPrompt, now: number): PendingPrompt[] {
  const kept = list.filter(x => now - x.at < PENDING_TTL_MS)
  kept.push(p)
  list.splice(0, list.length, ...kept.slice(-MAX_PENDING))
  return list
}

/**
 * The prompt a relayed permission request belongs to. The relay carries the
 * tool name and an input preview (a possibly shortened JSON of the input);
 * the newest record whose input starts with that preview wins. Prompts
 * already answered (see markAnswered) are left out.
 */
export function findPending(list: PendingPrompt[], tool: string, preview: string, now: number): PendingPrompt | undefined {
  const head = preview.replace(/(…|\.\.\.)$/, '')
  const fresh = list.filter(p => p.tool === tool && !p.answered && now - p.at < PENDING_TTL_MS)
  for (let i = fresh.length - 1; i >= 0; i--) {
    const p = fresh[i]!
    if (p.input === preview || (head.length > 0 && p.input.startsWith(head))) return p
  }
  // Previews may be formatted differently from JSON.stringify; with a
  // single fresh candidate for the tool, that is the one.
  return fresh.length === 1 ? fresh[0] : undefined
}

/**
 * Mark a prompt as answered, so a later relay for the same tool cannot be
 * matched to it. `p` must be an element of `list` (as findPending returns
 * it). Mutates and returns `list`; save it afterwards.
 */
export function markAnswered(list: PendingPrompt[], p: PendingPrompt, now: number): PendingPrompt[] {
  if (list.includes(p)) p.answered = now
  return list
}

/** Remember a prompt's answer. Mutates and returns `list`. */
export function addRemembered(list: Remembered[], p: PendingPrompt, now: number): Remembered[] {
  const key = promptKey(p.tool, p.input, p.suggestions)
  const kept = list.filter(r => now - r.at < REMEMBER_TTL_MS && !(r.session === p.session && r.key === key))
  kept.push({ at: now, session: p.session, key, label: promptLabel(p), suggestions: rememberable(p.suggestions) })
  list.splice(0, list.length, ...kept)
  return list
}

/** A remembered answer covering this prompt, if any. */
export function matchRemembered(
  list: Remembered[],
  session: string,
  tool: string,
  input: string,
  suggestions: Suggestion[] | undefined,
  now: number,
): Remembered | undefined {
  const key = promptKey(tool, input, suggestions)
  return list.find(r => r.session === session && r.key === key && now - r.at < REMEMBER_TTL_MS)
}

/** The hook's answer for a remembered prompt. */
export function allowOutput(suggestions: Suggestion[]): object {
  const updatedPermissions = rememberable(suggestions).map(s => ({ ...s, destination: 'session' }))
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', ...(updatedPermissions.length ? { updatedPermissions } : {}) },
    },
  }
}

// ---- stores (shared by the hook and server.ts) ------------------------------

export const pendingFile = (stateDir: string, slot: string): string => join(stateDir, 'permissions', `pending-${slot}.json`)
export const rememberedFile = (stateDir: string, slot: string): string => join(stateDir, 'permissions', `remembered-${slot}.json`)

/** Read a JSON array; anything missing or malformed reads as empty. */
export function loadList<T>(file: string): T[] {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** Write a JSON array atomically, readable by this user only. */
export function saveList(file: string, list: unknown[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 })
  renameSync(tmp, file)
}
