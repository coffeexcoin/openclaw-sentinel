import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";

const tmpState = () =>
  path.join(os.tmpdir(), `sentinel-ws-reconnect-${Date.now()}-${Math.random()}.json`);

const baseConfig = () => ({
  allowedHosts: ["example.com"],
  localDispatchBase: "http://127.0.0.1:18789",
  stateFilePath: tmpState(),
  limits: {
    maxWatchersTotal: 10,
    maxWatchersPerSkill: 10,
    maxConditionsPerWatcher: 10,
    maxIntervalMsFloor: 1,
  },
});

const baseWatcher = () => ({
  id: "w-ws",
  skillId: "skills.test",
  enabled: true,
  strategy: "websocket" as const,
  endpoint: "wss://example.com/feed",
  match: "all" as const,
  conditions: [{ path: "type", op: "eq" as const, value: "tick" }],
  fire: {
    webhookPath: "/hooks/agent",
    eventName: "evt",
    payloadTemplate: { event: "${event.name}" },
  },
  retry: { maxRetries: 5, baseMs: 500, maxMs: 60000 },
});

const captured = vi.hoisted(() => ({
  onError: null as null | ((err: unknown) => Promise<void>),
  onPayload: null as null | ((payload: unknown) => Promise<void>),
  onConnect: null as null | (() => void),
  stopSpy: vi.fn(),
}));

vi.mock("../src/strategies/websocket.js", () => ({
  websocketStrategy: vi.fn(
    async (
      _watcher: unknown,
      onPayload: (p: unknown) => Promise<void>,
      onError: (e: unknown) => Promise<void>,
      callbacks?: { onConnect?: () => void },
    ) => {
      captured.onPayload = onPayload;
      captured.onError = onError;
      captured.onConnect = callbacks?.onConnect ?? null;
      callbacks?.onConnect?.();
      return async () => {
        captured.stopSpy();
      };
    },
  ),
}));

import { WatcherManager, backoff, RESET_BACKOFF_AFTER_MS } from "../src/watcherManager.js";

describe("backoff", () => {
  it("returns at least baseMs", () => {
    // #given failures=0
    // #when / #then
    for (let i = 0; i < 100; i++) {
      expect(backoff(500, 60000, 0)).toBeGreaterThanOrEqual(500 * 0.75);
    }
  });

  it("caps at maxMs (plus jitter headroom)", () => {
    // #given high failure count
    // #when / #then
    for (let i = 0; i < 100; i++) {
      const val = backoff(500, 60000, 20);
      expect(val).toBeLessThanOrEqual(60000 * 1.25);
    }
  });

  it("grows exponentially before cap", () => {
    // #given deterministic random
    const orig = Math.random;
    Math.random = () => 0.5;
    try {
      // #when
      const d0 = backoff(500, 60000, 1);
      const d1 = backoff(500, 60000, 2);
      const d2 = backoff(500, 60000, 3);
      // #then
      expect(d1).toBeGreaterThan(d0);
      expect(d2).toBeGreaterThan(d1);
    } finally {
      Math.random = orig;
    }
  });

  it("jitter stays within ±25% of raw value", () => {
    const base = 500;
    const max = 60000;
    for (let failures = 0; failures < 8; failures++) {
      const raw = Math.min(max, base * 2 ** failures);
      for (let i = 0; i < 50; i++) {
        // #when
        const val = backoff(base, max, failures);
        // #then
        expect(val).toBeGreaterThanOrEqual(Math.max(base, raw * 0.75));
        expect(val).toBeLessThanOrEqual(raw * 1.25);
      }
    }
  });
});

describe("websocket reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    captured.stopSpy.mockReset();
    captured.onError = null;
    captured.onPayload = null;
    captured.onConnect = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deduplicates rapid failure calls into a single retry timer", async () => {
    // #given
    const manager = new WatcherManager(baseConfig(), { dispatch: vi.fn(async () => {}) });
    await manager.init();
    await manager.create(baseWatcher());

    // #when — simulate rapid error+close (two onError calls)
    await captured.onError!(new Error("conn reset"));
    await captured.onError!(new Error("ws closed: 1006"));

    // #then — only one retry timer scheduled
    const rt = manager.status("w-ws")!;
    expect(rt.consecutiveFailures).toBe(2);
    expect(rt.reconnectAttempts).toBe(1);
  });

  it("stop cancels pending reconnect timer", async () => {
    // #given
    const manager = new WatcherManager(baseConfig(), { dispatch: vi.fn(async () => {}) });
    await manager.init();
    await manager.create(baseWatcher());

    // #when — trigger failure to schedule reconnect, then disable
    await captured.onError!(new Error("disconnected"));
    await manager.disable("w-ws");

    // #then — advance time past retry delay; no new startWatcher calls
    const callsBefore = captured.stopSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(captured.stopSpy.mock.calls.length).toBe(callsBefore);
  });

  it("tracks lastConnectAt on connect", async () => {
    // #given / #when
    const manager = new WatcherManager(baseConfig(), { dispatch: vi.fn(async () => {}) });
    await manager.init();
    await manager.create(baseWatcher());

    // #then — onConnect was called by mock
    const rt = manager.status("w-ws")!;
    expect(rt.lastConnectAt).toBeDefined();
  });

  it("tracks disconnect telemetry on failure", async () => {
    // #given
    const manager = new WatcherManager(baseConfig(), { dispatch: vi.fn(async () => {}) });
    await manager.init();
    await manager.create(baseWatcher());

    // #when
    await captured.onError!(new Error("connection lost"));

    // #then
    const rt = manager.status("w-ws")!;
    expect(rt.lastDisconnectAt).toBeDefined();
    expect(rt.lastDisconnectReason).toBe("connection lost");
    expect(rt.reconnectAttempts).toBe(1);
  });

  it("resets backoff after sustained healthy connection", async () => {
    // #given — watcher connected for >60s
    const manager = new WatcherManager(baseConfig(), { dispatch: vi.fn(async () => {}) });
    await manager.init();
    await manager.create(baseWatcher());

    const rt = manager.status("w-ws")!;
    rt.consecutiveFailures = 4;
    rt.lastConnectAt = new Date(Date.now() - RESET_BACKOFF_AFTER_MS - 1000).toISOString();

    // #when — connection drops after long healthy period
    await captured.onError!(new Error("timeout"));

    // #then — failures reset to 1 (reset to 0, then +1 for this failure)
    expect(manager.status("w-ws")!.consecutiveFailures).toBe(1);
  });

  it("does NOT reset backoff for short-lived connections", async () => {
    // #given — watcher connected recently
    const manager = new WatcherManager(baseConfig(), { dispatch: vi.fn(async () => {}) });
    await manager.init();
    await manager.create(baseWatcher());

    const rt = manager.status("w-ws")!;
    rt.consecutiveFailures = 4;
    rt.lastConnectAt = new Date(Date.now() - 5000).toISOString();

    // #when
    await captured.onError!(new Error("quick drop"));

    // #then — failures continue to accumulate
    expect(manager.status("w-ws")!.consecutiveFailures).toBe(5);
  });

  it("resets reconnectAttempts on successful payload", async () => {
    // #given
    const manager = new WatcherManager(baseConfig(), { dispatch: vi.fn(async () => {}) });
    await manager.init();
    await manager.create(baseWatcher());

    const rt = manager.status("w-ws")!;
    rt.reconnectAttempts = 3;
    rt.consecutiveFailures = 3;

    // #when — successful payload arrives
    await captured.onPayload!({ type: "tick" });

    // #then
    const updated = manager.status("w-ws")!;
    expect(updated.reconnectAttempts).toBe(0);
    expect(updated.consecutiveFailures).toBe(0);
  });
});
