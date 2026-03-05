# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw Sentinel is a declarative, gateway-native background watcher plugin for [OpenClaw](https://github.com/coffeexcoin/openclaw). It monitors external endpoints via configurable strategies (HTTP polling, WebSocket, SSE, HTTP long-poll), evaluates declarative conditions against response payloads, and dispatches callback envelopes to the gateway's internal webhook system when conditions match. It does **not** execute user-authored code.

## Commands

```bash
pnpm install              # Install dependencies
pnpm run build            # TypeScript compile (tsc -p tsconfig.json) → dist/
pnpm run lint             # Type-check only (tsc --noEmit)
pnpm run format           # Format with oxfmt
pnpm run format:check     # Check formatting
pnpm test                 # Run all tests (unit + e2e)
pnpm run test:unit        # Unit tests only (vitest, excludes *-e2e.test.ts)
pnpm run test:e2e         # E2E tests only (*-e2e.test.ts, serial, 120s timeout)
```

Run a single test file:

```bash
npx vitest run tests/evaluator.test.ts --config vitest.unit.config.ts
npx vitest run tests/sentinel-callback-e2e.test.ts --config vitest.e2e.config.ts
```

Pre-commit hook runs `lint-staged` (oxfmt) + `tsc --noEmit`.

## Architecture

### Plugin Entry Point (`src/index.ts`)

`createSentinelPlugin()` is the main export. It implements the OpenClaw plugin API (`openclaw/plugin-sdk`):

- Resolves config from `api.pluginConfig` (with legacy root-level fallback)
- Auto-detects gateway auth token from runtime config
- Registers the `sentinel_control` tool and `/hooks/sentinel` webhook route
- Creates and manages the `WatcherManager` lifecycle

The module also exports `register`/`activate` as bound aliases of the plugin's register method.

### Core Pipeline

```
WatcherDefinition → Strategy (poll/ws/sse) → Payload
    → Evaluator (condition matching) → CallbackEnvelope
    → WatcherManager.dispatch() → Gateway webhook
    → /hooks/sentinel route → Hook session → LLM response
    → Response-delivery contract → Relay to deliveryTargets
```

### Key Modules

| File                  | Purpose                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watcherManager.ts`   | Lifecycle management: create/enable/disable/remove watchers, run strategy loops, dispatch envelopes, manage state persistence                                                           |
| `tool.ts`             | `sentinel_control` tool registration with action routing (create/enable/disable/remove/status/list)                                                                                     |
| `toolSchema.ts`       | TypeBox schema for the `sentinel_control` tool input                                                                                                                                    |
| `evaluator.ts`        | Condition evaluation engine (11 operators). Uses RE2/re2-wasm for safe regex (`matches` operator)                                                                                       |
| `validator.ts`        | Watcher definition validation: TypeBox schema check + code-like field/value rejection (`scanNoCodeLike`)                                                                                |
| `callbackEnvelope.ts` | Builds the `sentinel.callback` envelope with intent, context, trigger, delivery metadata                                                                                                |
| `template.ts`         | Non-Turing-complete `${placeholder}` substitution (restricted to `watcher.*`, `event.*`, `payload.*`, `timestamp`)                                                                      |
| `configSchema.ts`     | TypeBox schema for plugin config with defaults                                                                                                                                          |
| `limits.ts`           | Resource limit enforcement (max watchers, per-skill limits, interval floor, host allowlist)                                                                                             |
| `stateStore.ts`       | JSON file persistence at `~/.openclaw/sentinel-state.json`                                                                                                                              |
| `strategies/`         | Strategy implementations: `httpPoll.ts`, `httpLongPoll.ts`, `websocket.ts`, `sse.ts` — all return a `StrategyHandler` (takes watcher + onPayload/onError callbacks, returns cleanup fn) |
| `cli.ts`              | Minimal CLI entry point for `list/status/enable/disable/audit`                                                                                                                          |

### Schema Validation

Uses `@sinclair/typebox` for all schema definitions (config, tool input, watcher definitions). Schemas enforce `additionalProperties: false` throughout. The validator also rejects code-like keys/values (patterns like `function`, `eval`, `import`, `require`, `=>`).

### Webhook & Callback System

The `/hooks/sentinel` route in `index.ts` handles incoming callbacks:

- Validates JSON Content-Type, enforces body size limits
- Creates isolated hook sessions per-watcher (or grouped via `sessionGroup`)
- Manages response-delivery contracts with timeout/fallback/dedupe
- Relay guardrails suppress control tokens (`NO_REPLY`, `HEARTBEAT_OK`)

### Test Structure

- **Unit tests** (`tests/*.test.ts`, excluding `*-e2e.test.ts`): Test individual modules in isolation
- **E2E tests** (`tests/*-e2e.test.ts`): Run serially with extended timeouts (120s), single worker, `forks` pool
- Tests use `vitest` with no shared test utilities — each test file is self-contained with inline mocks

## Conventions

- ESM-only (`"type": "module"`), Node.js >= 22
- Package manager: pnpm (10.6.5)
- Formatter: oxfmt (not prettier/eslint)
- TypeScript target: ES2022 with NodeNext module resolution
- Versioning: Changesets (`pnpm changeset` to create, CI handles release)
- Watcher IDs: constrained to `^[A-Za-z0-9_-]{1,128}$`
- HTTP strategies set `redirect: "error"` to prevent host-allowlist bypass
- All file imports use `.js` extension (NodeNext resolution)
