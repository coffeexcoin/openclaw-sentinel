---
"@coffeexdev/openclaw-sentinel": minor
---

Redesign sentinel callback handler: consolidate dual-JSON prompt into single SENTINEL_CALLBACK_JSON block, register session-guarded action tools (sentinel_act, sentinel_escalate), add before_tool_call/after_tool_call hooks for safety and tracing, bump callback envelope to v2 with tags and operatorGoal fields, and simplify delivery target resolution.
