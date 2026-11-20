// Choice polls: Claude asks the user to pick from a list with a native
// Telegram poll (the `choose` tool). Votes come back as poll_answer updates,
// which carry no chat, so each session remembers the polls it sent in
// <state>/polls[-<slot>].json; the router reads those files to route a vote.

export type PollRecord = { chat: string; id: number; question: string; options: string[]; multiple: boolean; at: number }

export const POLLS_KEEP = 50
export const MAX_POLL_OPTIONS = 12

/** Add a poll, keeping the newest POLLS_KEEP. */
export function addPoll(all: Record<string, PollRecord>, pollId: string, rec: PollRecord): Record<string, PollRecord> {
  const entries = Object.entries({ ...all, [pollId]: rec }).sort((a, b) => a[1].at - b[1].at)
  return Object.fromEntries(entries.slice(-POLLS_KEEP))
}

/** The slot whose polls file this is: polls.json is main, polls-t32.json is t32. */
export function pollFileSlot(name: string): string | undefined {
  const m = /^polls(?:-(.+))?\.json$/.exec(name)
  return m ? (m[1] ?? 'main') : undefined
}

/** What Claude is told about a vote; no options means the vote was withdrawn. */
export function describeAnswer(rec: PollRecord, optionIds: number[]): string {
  if (!optionIds.length) {
    return `[Poll vote withdrawn on your message ${rec.id}] The user withdrew their vote on "${rec.question}". Wait for their new vote before acting on it.`
  }
  const picked = optionIds.map(i => rec.options[i]).filter((o): o is string => o != null)
  const rest = rec.options.filter((_, i) => !optionIds.includes(i))
  const list = (xs: string[]) => xs.map(x => `"${x}"`).join(', ')
  return (
    `[Poll answer on your message ${rec.id}] "${rec.question}"\nPicked: ${list(picked)}` +
    (rec.multiple ? `\nNot picked: ${rest.length ? list(rest) : '(none)'}` : '') +
    '\nIf they vote again, the newest vote replaces this one.'
  )
}
