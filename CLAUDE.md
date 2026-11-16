# Repository conventions

- **English only.** Everything committed to this repository is written in English: code, comments, user-facing strings, docs, config descriptions and commit messages. This overrides any personal default to write commit subjects in another language.
- Commit messages follow Conventional Commits: `type(scope): subject`, a blank line, then `- ` bullets, wrapped at about 72 characters.
- The plugin lives in `plugins/telegram`. Bump `version` in `plugins/telegram/.claude-plugin/plugin.json` on every change that should reach installed copies, otherwise `claude plugin update` may not pick it up.
- No build step: Bun runs `server.ts` directly. Check syntax with `bun build server.ts --target=bun --outdir <tmp>`.
- Never commit tokens, `access.json` or anything from `~/.claude/channels/`.
