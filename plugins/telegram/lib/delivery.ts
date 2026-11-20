// Did a channel message reach Claude? MCP notifications get no answer, and a
// session that is still starting (for example resuming a conversation whose
// last turn was cut off) has been seen to drop one. Claude Code writes every
// channel message it accepts into the session transcript, with the <channel>
// tag's attributes JSON-escaped, so the server looks for it there.

/** How a channel message's chat and message id appear in the transcript. */
export function channelMarker(chat: string, messageId: string | number): string {
  return `chat_id=\\"${chat}\\" message_id=\\"${messageId}\\"`
}

/**
 * Should a message handed to Claude be checked? Only during the first
 * `windowMs` after the server started, when a session may still be starting.
 */
export function inStartupWindow(startedAt: number, now: number, windowMs: number): boolean {
  return now - startedAt <= windowMs
}
