# Repository conventions

- **English only.** Everything committed to this repository is written in English: code, comments, user-facing strings, docs, config descriptions and commit messages. This overrides any personal default to write commit subjects in another language.
- Commit messages follow Conventional Commits: `type(scope): subject`, a blank line, then `- ` bullets, wrapped at about 72 characters.
- The plugin lives in `plugins/telegram`. Bump `version` in `plugins/telegram/.claude-plugin/plugin.json` on every change that should reach installed copies, otherwise `claude plugin update` may not pick it up.
- No build step: Bun runs `server.ts` directly. Check syntax with `bun build server.ts --target=bun --outdir <tmp>`.
- Pure helpers live in `plugins/telegram/lib/` with tests next to them. Run `bun run check` in `plugins/telegram` before committing: it type-checks (`tsc`, strict), lints (Biome) and runs the unit tests and the end-to-end tests in `plugins/telegram/test/` (fake Bot API server, MCP over stdio). Add an end-to-end test for any change to a flow in `server.ts`, the router or the hooks. CI runs the same on every push.
- Never commit tokens, `access.json` or anything from `~/.claude/channels/`.
