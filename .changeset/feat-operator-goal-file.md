---
"@coffeexdev/openclaw-sentinel": minor
---

feat: add `operatorGoalFile` to fire config for runtime policy/config references

Adds an optional `operatorGoalFile` field to the watcher fire config that points to a local
policy/config file. The file is read fresh each time the watcher fires, and its contents are
injected into the callback envelope as `operatorGoalRuntimeContext`. This ensures callback agents
always use current policy values instead of stale values baked in at watcher creation time.

Closes #87
