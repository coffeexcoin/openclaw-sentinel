---
"@coffeexdev/openclaw-sentinel": patch
---

Fix `/hooks/sentinel` callback wake flow to avoid heartbeat-poll prompting. Callback events are now enqueued with a cron-tagged context and woken with `cron:sentinel-callback`, preserving isolated hook-session routing, dedupe, and relay behavior while driving sentinel-context processing (`SENTINEL_TRIGGER` + envelope).

Add callback relay guardrails so literal `HEARTBEAT_OK` is never forwarded to users. When no assistant-authored callback output is available, sentinel fallback relay remains concise and sentinel-specific.
