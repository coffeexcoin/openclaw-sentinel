---
"@coffeexdev/openclaw-sentinel": patch
---

Fix a v0.4.0 schema regression where recursive TypeBox schemas could generate duplicate auto refs (for example `T0`) and fail validation/registration at runtime.

- Introduce a shared recursive `TemplateValueSchema` module with explicit stable `$id`
- Reuse that shared schema in both tool parameters schema and watcher validator schema
- Add runtime-focused tests for `sentinel_control` create/list flows to guard against schema ref collisions
