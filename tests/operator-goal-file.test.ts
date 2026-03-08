import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WatcherManager } from "../src/watcherManager.js";

const TEST_DIR = path.join(
  os.tmpdir(),
  `sentinel-goal-file-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

function buildManager(opts?: { maxOperatorGoalChars?: number }) {
  const dispatched: Array<{ path: string; body: Record<string, unknown> }> = [];
  const warnings: string[] = [];

  const manager = new WatcherManager(
    {
      allowedHosts: ["api.example.com"],
      localDispatchBase: "http://127.0.0.1:18789",
      stateFilePath: path.join(TEST_DIR, `state-${Math.random().toString(36).slice(2)}.json`),
      maxOperatorGoalChars: opts?.maxOperatorGoalChars,
      limits: {
        maxWatchersTotal: 20,
        maxWatchersPerSkill: 20,
        maxConditionsPerWatcher: 25,
        maxIntervalMsFloor: 1,
      },
    },
    {
      async dispatch(dispatchPath, body) {
        dispatched.push({ path: dispatchPath, body });
      },
    },
  );

  manager.setLogger({
    info() {},
    warn(msg: string) {
      warnings.push(msg);
    },
    error() {},
  });

  return { manager, dispatched, warnings };
}

function baseWatcher(
  id: string,
  overrides?: Partial<{ operatorGoal: string; operatorGoalFile: string }>,
) {
  return {
    id,
    skillId: "skills.test",
    enabled: false,
    strategy: "http-poll" as const,
    endpoint: "https://api.example.com/data",
    match: "all" as const,
    conditions: [{ path: "status", op: "exists" as const }],
    fire: {
      webhookPath: "/hooks/sentinel",
      eventName: "test_event",
      payloadTemplate: { event: "${event.name}" },
      ...overrides,
    },
    retry: { maxRetries: 1, baseMs: 100, maxMs: 1000 },
  };
}

describe("operatorGoalFile", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("creates a watcher with operatorGoalFile", async () => {
    const { manager } = buildManager();
    const watcher = await manager.create(
      baseWatcher("with-file", { operatorGoalFile: "/tmp/policy.json" }),
    );
    expect(watcher.fire.operatorGoalFile).toBe("/tmp/policy.json");
  });

  it("creates a watcher with both operatorGoal and operatorGoalFile", async () => {
    const { manager } = buildManager();
    const watcher = await manager.create(
      baseWatcher("with-both", {
        operatorGoal: "Follow the bidding policy",
        operatorGoalFile: "~/.openclaw/policies/bid.json",
      }),
    );
    expect(watcher.fire.operatorGoal).toBe("Follow the bidding policy");
    expect(watcher.fire.operatorGoalFile).toBe("~/.openclaw/policies/bid.json");
  });

  it("persists operatorGoalFile through state save/load cycle", async () => {
    const { manager } = buildManager();
    const watcher = await manager.create(
      baseWatcher("persist-test", { operatorGoalFile: "/tmp/policy.json" }),
    );
    expect(watcher.fire.operatorGoalFile).toBe("/tmp/policy.json");

    const listed = manager.list();
    const found = listed.find((w) => w.id === "persist-test");
    expect(found?.fire.operatorGoalFile).toBe("/tmp/policy.json");
  });
});
