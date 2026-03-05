# Sentinel runtime E2E harness mapping

`tests/sentinel-callback-e2e.test.ts` now runs a **real OpenClaw runtime path** instead of a plugin-only mock harness.

## Test-layer split

- **Unit / integration tests** (`tests/*.test.ts`, excluding `*-e2e.test.ts`)
  - validate plugin logic in-process with mocked runtime surfaces
  - fast feedback for schema, route validation, envelope construction, and guardrail helpers
- **Runtime E2E** (`tests/sentinel-callback-e2e.test.ts`)
  - boots an isolated OpenClaw profile + gateway process
  - installs the plugin tarball built under test
  - posts real `/hooks/sentinel` callbacks over HTTP
  - verifies runtime prompt handoff + relay behavior end-to-end

## OpenClaw-core concept → Sentinel repo runtime equivalent

| OpenClaw-core plan concept                 | Sentinel runtime E2E equivalent                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolated test gateway instance             | Spawn `openclaw gateway run` with a unique `--profile` and temp state directory.                                                                                                    |
| Install plugin build-under-test            | `pnpm pack` tarball + `openclaw plugins install <tarball>` inside test profile.                                                                                                     |
| Real callback route exercise               | HTTP `POST /hooks/sentinel` against live gateway listener.                                                                                                                          |
| Runtime prompt-envelope verification       | Local OpenAI-compatible mock model server captures live `/chat/completions` request; test asserts `SENTINEL_CALLBACK_CONTEXT_JSON` + watcher/context fields in model input payload. |
| LLM independence / deterministic CI        | Model provider points at local mock server (`127.0.0.1`) with queued deterministic assistant responses. No external network/LLM dependency.                                         |
| Relay + control-token suppression behavior | Runtime gateway logs are asserted for `Relayed assistant response ...` and `Sent guardrail fallback ...` (for `NO_REPLY` output), validating suppression + fallback path.           |

## Why this is CI-safe

- No external network dependencies (only loopback HTTP).
- No real provider/API keys required beyond dummy local token.
- Deterministic response queue in mock model server.
- Single-worker E2E config avoids profile/port races in CI.
