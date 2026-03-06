---
"@coffeexdev/openclaw-sentinel": patch
---

Expand watcher `fire.operatorGoal` limits to support richer callback instructions while preserving safety caps.

- Increase default max `operatorGoal` length from 500 to 12000 characters.
- Add configurable `maxOperatorGoalChars` with enforced bounds (minimum 500, hard maximum 20000).
- Align runtime validation, JSON schema, and docs/tests with the new configurable limit behavior.
