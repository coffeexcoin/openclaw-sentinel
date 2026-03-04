---
"@coffeexdev/openclaw-sentinel": minor
---

Add generic sentinel callback envelope semantics for watcher matches.

- Extend watcher fire schema with optional `intent`, `contextTemplate`, `priority`, `deadlineTemplate`, and `dedupeKeyTemplate`
- Emit stable callback envelopes (`type: sentinel.callback`, `version: 1`) including watcher/trigger/context/payload/source fields
- Add deterministic trigger `dedupeKey` generation
- Add generic fallback behavior when `intent`/`contextTemplate` are omitted
- Upgrade `/hooks/sentinel` enqueue text to include instruction prefix and JSON envelope block
- Keep legacy `text`/`message` webhook payload behavior for backward compatibility
- Add tests for explicit/fallback callback behavior, payload truncation, and callback route formatting
- Update README and docs/USAGE with generic workflow examples
