import { describe, expect, it, vi } from "vitest";
import { registerSentinelActionTools } from "../src/actionTools.js";

function createMockApi(overrides: Record<string, unknown> = {}) {
  return {
    registerTool: vi.fn(),
    runtime: {
      system: {
        runCommandWithTimeout: vi.fn(async () => ({
          pid: 123,
          stdout: "ok\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        })),
      },
      channel: {
        telegram: { sendMessageTelegram: vi.fn(async () => undefined) },
        discord: { sendMessageDiscord: vi.fn(async () => undefined) },
        slack: { sendMessageSlack: vi.fn(async () => undefined) },
        signal: { sendMessageSignal: vi.fn(async () => undefined) },
        imessage: { sendMessageIMessage: vi.fn(async () => undefined) },
        whatsapp: { sendMessageWhatsApp: vi.fn(async () => undefined) },
        line: { sendMessageLine: vi.fn(async () => undefined) },
      },
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    on: vi.fn(),
    ...overrides,
  } as any;
}

function createMockConfig(overrides: Record<string, unknown> = {}) {
  return {
    allowedHosts: [],
    localDispatchBase: "http://127.0.0.1:18789",
    hookSessionPrefix: "agent:main:hooks:sentinel",
    limits: {
      maxWatchersTotal: 200,
      maxWatchersPerSkill: 20,
      maxConditionsPerWatcher: 25,
      maxIntervalMsFloor: 1000,
    },
    ...overrides,
  } as any;
}

function createMockManager() {
  return {} as any;
}

function getToolExecutor(api: any, toolName: string, sessionKey?: string) {
  const toolFactories = api.registerTool.mock.calls.map((c: any) => c[0]);
  for (const factory of toolFactories) {
    const tool = factory({ sessionKey });
    if (tool.name === toolName) {
      return (params: unknown) => tool.execute("test-call-id", params);
    }
  }
  throw new Error(`Tool ${toolName} not found`);
}

describe("sentinel action tools", () => {
  it("sentinel_act returns error outside sentinel session", async () => {
    const api = createMockApi();
    const config = createMockConfig();
    registerSentinelActionTools(api.registerTool, createMockManager(), api, config);

    const execute = getToolExecutor(api, "sentinel_act", "agent:main:main");
    const result = await execute({ action: "run_command", command: "echo hello" });

    expect(result.content[0].text).toContain(
      "sentinel_act can only be used in a sentinel callback session",
    );
  });

  it("sentinel_act with run_command executes successfully in sentinel session", async () => {
    const api = createMockApi();
    const config = createMockConfig();
    registerSentinelActionTools(api.registerTool, createMockManager(), api, config);

    const execute = getToolExecutor(api, "sentinel_act", "agent:main:hooks:sentinel:watcher:test");
    const result = await execute({ action: "run_command", command: "echo", args: ["hello"] });

    expect(api.runtime.system.runCommandWithTimeout).toHaveBeenCalledWith(["echo", "hello"], {
      timeoutMs: 30000,
    });
    expect(result.content[0].text).toContain('"ok": true');
    expect(result.content[0].text).toContain('"code": 0');
  });

  it("sentinel_act with notify sends to delivery targets", async () => {
    const api = createMockApi();
    const config = createMockConfig();
    registerSentinelActionTools(api.registerTool, createMockManager(), api, config);

    const execute = getToolExecutor(api, "sentinel_act", "agent:main:hooks:sentinel:watcher:test");
    const result = await execute({
      action: "notify",
      message: "Alert: price threshold reached",
      targets: [{ channel: "telegram", to: "5613673222" }],
    });

    expect(api.runtime.channel.telegram.sendMessageTelegram).toHaveBeenCalledWith(
      "5613673222",
      "Alert: price threshold reached",
      { accountId: undefined },
    );
    expect(result.content[0].text).toContain('"delivered": 1');
  });

  it("sentinel_escalate returns acknowledgment in sentinel session", async () => {
    const api = createMockApi();
    const config = createMockConfig();
    registerSentinelActionTools(api.registerTool, createMockManager(), api, config);

    const execute = getToolExecutor(
      api,
      "sentinel_escalate",
      "agent:main:hooks:sentinel:watcher:test",
    );
    const result = await execute({ reason: "Price spike beyond threshold", severity: "critical" });

    expect(result.content[0].text).toContain('"escalated": true');
    expect(result.content[0].text).toContain('"severity": "critical"');
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Escalation: severity=critical"),
    );
  });

  it("sentinel_escalate returns error outside sentinel session", async () => {
    const api = createMockApi();
    const config = createMockConfig();
    registerSentinelActionTools(api.registerTool, createMockManager(), api, config);

    const execute = getToolExecutor(api, "sentinel_escalate", "agent:main:main");
    const result = await execute({ reason: "test" });

    expect(result.content[0].text).toContain(
      "sentinel_escalate can only be used in a sentinel callback session",
    );
  });

  it("sentinel_act run_command handles execution failure", async () => {
    const api = createMockApi({
      runtime: {
        system: {
          runCommandWithTimeout: vi.fn(async () => {
            throw new Error("Command not found: nonexistent");
          }),
        },
        channel: {
          telegram: { sendMessageTelegram: vi.fn(async () => undefined) },
          discord: { sendMessageDiscord: vi.fn(async () => undefined) },
          slack: { sendMessageSlack: vi.fn(async () => undefined) },
          signal: { sendMessageSignal: vi.fn(async () => undefined) },
          imessage: { sendMessageIMessage: vi.fn(async () => undefined) },
          whatsapp: { sendMessageWhatsApp: vi.fn(async () => undefined) },
          line: { sendMessageLine: vi.fn(async () => undefined) },
        },
      },
    });
    const config = createMockConfig();
    registerSentinelActionTools(api.registerTool, createMockManager(), api, config);

    const execute = getToolExecutor(api, "sentinel_act", "agent:main:hooks:sentinel:watcher:test");
    const result = await execute({ action: "run_command", command: "nonexistent" });

    expect(result.content[0].text).toContain("Command not found: nonexistent");
  });

  it("sentinel_act notify returns error when no targets specified", async () => {
    const api = createMockApi();
    const config = createMockConfig();
    registerSentinelActionTools(api.registerTool, createMockManager(), api, config);

    const execute = getToolExecutor(api, "sentinel_act", "agent:main:hooks:sentinel:watcher:test");
    const result = await execute({ action: "notify", message: "test" });

    expect(result.content[0].text).toContain("No delivery targets");
  });
});
