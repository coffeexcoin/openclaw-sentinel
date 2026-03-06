import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { WatcherManager } from "../src/watcherManager.js";

function buildManager(maxOperatorGoalChars?: number) {
  return new WatcherManager(
    {
      allowedHosts: ["api.github.com"],
      localDispatchBase: "http://127.0.0.1:18789",
      stateFilePath: path.join(
        os.tmpdir(),
        `sentinel-operator-goal-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      ),
      maxOperatorGoalChars,
      limits: {
        maxWatchersTotal: 20,
        maxWatchersPerSkill: 20,
        maxConditionsPerWatcher: 25,
        maxIntervalMsFloor: 1,
      },
    },
    {
      async dispatch() {
        /* noop */
      },
    },
  );
}

function watcherWithOperatorGoal(id: string, operatorGoal: string) {
  return {
    id,
    skillId: "skills.ops",
    enabled: false,
    strategy: "http-poll" as const,
    endpoint: "https://api.github.com/events",
    match: "all" as const,
    conditions: [{ path: "type", op: "exists" as const }],
    fire: {
      webhookPath: "/hooks/sentinel",
      eventName: "ops_alert",
      payloadTemplate: { event: "${event.name}" },
      operatorGoal,
    },
    retry: { maxRetries: 1, baseMs: 100, maxMs: 1000 },
  };
}

describe("watcher operatorGoal limits", () => {
  it("accepts old small prompts", async () => {
    const manager = buildManager();
    const watcher = await manager.create(
      watcherWithOperatorGoal("small-goal", "Summarize the incident and notify on-call"),
    );
    expect(watcher.fire.operatorGoal).toContain("incident");
  });

  it("accepts larger prompts near the default limit", async () => {
    const manager = buildManager();
    const watcher = await manager.create(watcherWithOperatorGoal("near-limit", "x".repeat(11999)));
    expect(watcher.fire.operatorGoal).toHaveLength(11999);
  });

  it("rejects prompts over the configured/default limit", async () => {
    const manager = buildManager();
    await expect(
      manager.create(watcherWithOperatorGoal("too-large", "x".repeat(12001))),
    ).rejects.toThrow(/operatorGoal/i);
  });

  it("supports raising the limit via config override", async () => {
    const manager = buildManager(18000);
    await expect(
      manager.create(watcherWithOperatorGoal("override-ok", "x".repeat(17000))),
    ).resolves.toMatchObject({ id: "override-ok" });

    await expect(
      manager.create(watcherWithOperatorGoal("override-too-large", "x".repeat(18001))),
    ).rejects.toThrow(/operatorGoal/i);
  });
});
