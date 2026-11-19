// Reaction shortcuts: a reaction (or quick button) on one of the bot's
// messages becomes a short instruction to Claude. Defaults here;
// <state>/reactions.json overrides them ({"emoji": "meaning"} or
// {"emoji": {"meaning": "…", "label": "…"}}, null removes one).

export type Shortcut = { meaning: string; label: string }

export const DEFAULT_REACTIONS: Record<string, string> = {
  '👍': 'Agreed, go ahead: continue with what this message proposes.',
  '👌': 'Pick the option you recommended in this message and carry on.',
  '👎': 'Not right: drop this approach and try a different one.',
  '🤔': "I don't follow: explain this message again in simpler words.",
  '👀': 'Tell me more: expand on this message with details and reasoning.',
  '✍': "Write it down: turn this message's content into a document or save it to memory.",
  '❤': 'Remember this: save the preference shown here to memory and follow it from now on.',
  '🔥': 'Do it now: carry out what this message proposes without asking again.',
  '🙏': 'Pause: stop the current work and wait for my next instruction.',
  '🎉': 'Done: wrap up, commit the work and clean up temporary files.',
}

/** Also interrupts a running turn. */
export const PAUSE_REACTION = '🙏'

export const DEFAULT_LABELS: Record<string, string> = {
  '👍': 'Go on', '👌': 'Your pick', '👎': 'Rethink', '🤔': 'Explain', '👀': 'More',
  '✍': 'Write down', '❤': 'Remember', '🔥': 'Do it', '🙏': 'Pause', '🎉': 'Wrap up',
}
// Shown first under the latest reply; the rest sit behind "⋯".
export const QUICK_FIRST = ['👍', '👎', '🤔', '🔥']

/** Telegram sometimes adds a variation selector (U+FE0F) to emoji. */
export const bare = (emoji: string) => emoji.replace(/\uFE0F/g, '')

/** Defaults merged with the parsed reactions.json (anything else is ignored). */
export function mergeShortcuts(custom?: unknown, labels: Record<string, string> = DEFAULT_LABELS): Map<string, Shortcut> {
  const map = new Map<string, Shortcut>()
  for (const [e, meaning] of Object.entries(DEFAULT_REACTIONS)) map.set(e, { meaning, label: labels[e] ?? DEFAULT_LABELS[e] ?? '' })
  if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
    for (const [e, v] of Object.entries(custom as Record<string, unknown>)) {
      if (v == null) map.delete(e)
      else if (typeof v === 'string') map.set(e, { meaning: v, label: map.get(e)?.label ?? '' })
      else if (typeof v === 'object') {
        const o = v as { meaning?: unknown; label?: unknown }
        map.set(e, {
          meaning: typeof o.meaning === 'string' ? o.meaning : (map.get(e)?.meaning ?? ''),
          label: typeof o.label === 'string' ? o.label : (map.get(e)?.label ?? ''),
        })
      }
    }
  }
  for (const [e, v] of map) if (!v.meaning) map.delete(e)
  return map
}
