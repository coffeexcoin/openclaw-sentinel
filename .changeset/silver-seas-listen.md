---
"@coffeexdev/openclaw-sentinel": minor
---

Enrich `/hooks/sentinel` callback prompting with structured watcher/trigger/source context so LLM actions can be guided by watcher intent/event metadata plus payload context. Add relay guardrails that suppress reserved control-token outputs (`NO_REPLY`, `HEARTBEAT_OK`, empty variants) and emit concise sentinel-specific fallback messaging when model output is unusable.
