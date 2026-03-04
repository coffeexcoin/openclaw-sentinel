---
"@coffeexdev/openclaw-sentinel": minor
---

Wire `/hooks/sentinel` into the OpenClaw agent loop by enqueueing a system event and requesting heartbeat wake on webhook receipt.

Also adds:

- optional `hookSessionKey` config (default `agent:main:main`)
- webhook payload validation/size guards and error responses
- route callback wiring + failure handling tests
- README/USAGE docs for callback behavior and configuration
