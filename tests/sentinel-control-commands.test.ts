import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSentinelControl } from "../src/tool.js";

const validWatcher = {
  id: "watcher-1",
  skillId: "skills.test",
  enabled: false,
  strategy: "http-poll" as const,
  endpoint: "https://api.github.com/events",
  intervalMs: 1000,
  match: "all" as const,
  conditions: [{ path: "type", op: "exists" as const }],
  fire: {
    webhookPath: "/hooks/agent",
    eventName: "evt",
    payloadTemplate: { message: "ok" },
  },
  retry: { maxRetries: 1, baseMs: 100, maxMs: 1000 },
};

type MockManager = {
  create: ReturnType<typeof vi.fn>;
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
};

function buildTool(manager: MockManager) {
  const registerTool = vi.fn();
  registerSentinelControl(registerTool as any, manager as any);
  const factory = registerTool.mock.calls[0][0];
  return factory({
    messageChannel: "telegram",
    requesterSenderId: "5613673222",
    agentAccountId: "acct-1",
    sessionKey: "agent:main:telegram:direct:5613673222",
  });
}

describe("sentinel_control command coverage", () => {
  let manager: MockManager;

  beforeEach(() => {
    manager = {
      create: vi.fn(async () => ({ id: "watcher-1" })),
      enable: vi.fn(async () => ({ ok: true })),
      disable: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => ({ ok: true })),
      status: vi.fn(() => ({ id: "watcher-1", enabled: true })),
      list: vi.fn(() => [{ id: "watcher-1" }]),
    };
  });

  it("dispatches create and add alias to manager.create", async () => {
    const tool = buildTool(manager);

    await tool.execute("tc-1", { action: "create", watcher: validWatcher });
    await tool.execute("tc-2", {
      action: "add",
      watcher: { ...validWatcher, id: "watcher-2" },
    });

    expect(manager.create).toHaveBeenCalledTimes(2);
    expect(manager.create.mock.calls[0][0].id).toBe("watcher-1");
    expect(manager.create.mock.calls[1][0].id).toBe("watcher-2");
    expect(manager.create.mock.calls[0][1]).toEqual({
      deliveryTargets: [{ channel: "telegram", to: "5613673222", accountId: "acct-1" }],
    });
  });

  it("dispatches enable/disable/status/get/remove/delete/list", async () => {
    const tool = buildTool(manager);

    await tool.execute("tc-enable", { action: "enable", id: "watcher-1" });
    await tool.execute("tc-disable", { action: "disable", id: "watcher-1" });
    await tool.execute("tc-status", { action: "status", id: "watcher-1" });
    await tool.execute("tc-get", { action: "get", id: "watcher-1" });
    await tool.execute("tc-remove", { action: "remove", id: "watcher-1" });
    await tool.execute("tc-delete", { action: "delete", id: "watcher-1" });
    await tool.execute("tc-list", { action: "list" });

    expect(manager.enable).toHaveBeenCalledWith("watcher-1");
    expect(manager.disable).toHaveBeenCalledWith("watcher-1");
    expect(manager.status).toHaveBeenCalledTimes(2);
    expect(manager.remove).toHaveBeenCalledTimes(2);
    expect(manager.list).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid payloads for required fields and unsupported actions", async () => {
    const tool = buildTool(manager);

    await expect(tool.execute("tc-bad-1", { action: "create" } as any)).rejects.toThrow(
      /Invalid sentinel_control parameters/i,
    );
    await expect(tool.execute("tc-bad-2", { action: "add" } as any)).rejects.toThrow(
      /Invalid sentinel_control parameters/i,
    );
    await expect(tool.execute("tc-bad-3", { action: "enable" } as any)).rejects.toThrow(
      /Invalid sentinel_control parameters/i,
    );
    await expect(tool.execute("tc-bad-4", { action: "disable" } as any)).rejects.toThrow(
      /Invalid sentinel_control parameters/i,
    );
    await expect(tool.execute("tc-bad-5", { action: "status" } as any)).rejects.toThrow(
      /Invalid sentinel_control parameters/i,
    );
    await expect(tool.execute("tc-bad-6", { action: "get" } as any)).rejects.toThrow(
      /Invalid sentinel_control parameters/i,
    );
    await expect(tool.execute("tc-bad-7", { action: "remove" } as any)).rejects.toThrow(
      /Invalid sentinel_control parameters/i,
    );
    await expect(tool.execute("tc-bad-8", { action: "delete" } as any)).rejects.toThrow(
      /Invalid sentinel_control parameters/i,
    );
    await expect(tool.execute("tc-bad-9", { action: "list", id: "nope" } as any)).rejects.toThrow(
      /Invalid sentinel_control parameters/i,
    );
    await expect(tool.execute("tc-bad-10", { action: "update", id: "w1" } as any)).rejects.toThrow(
      /Invalid sentinel_control parameters/i,
    );
    await expect(tool.execute("tc-bad-11", { action: "edit", id: "w1" } as any)).rejects.toThrow(
      /Invalid sentinel_control parameters/i,
    );
  });

  it("propagates manager errors for runtime error paths", async () => {
    manager.enable.mockRejectedValueOnce(new Error("Watcher not found: missing"));
    const tool = buildTool(manager);

    await expect(tool.execute("tc-fail", { action: "enable", id: "missing" })).rejects.toThrow(
      "Watcher not found: missing",
    );
  });
});
