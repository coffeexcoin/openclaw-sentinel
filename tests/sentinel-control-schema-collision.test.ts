import { describe, expect, it, vi } from "vitest";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { registerSentinelControl } from "../src/tool.js";
import { SentinelToolSchema } from "../src/toolSchema.js";
import { TemplateValueSchema, TEMPLATE_VALUE_SCHEMA_ID } from "../src/templateValueSchema.js";
import { WatcherSchema } from "../src/validator.js";

const validWatcher = {
  id: "watcher-1",
  skillId: "skills.test",
  enabled: true,
  strategy: "http-poll",
  endpoint: "https://api.github.com/events",
  intervalMs: 1000,
  match: "all",
  conditions: [{ path: "type", op: "exists" }],
  fire: {
    webhookPath: "/hooks/agent",
    eventName: "evt",
    payloadTemplate: {
      nested: {
        values: ["${event.type}", 1, true, null],
      },
    },
  },
  retry: { maxRetries: 1, baseMs: 100, maxMs: 1000 },
};

describe("sentinel_control schema refs", () => {
  it("uses one shared recursive template schema with stable $id", () => {
    expect(TemplateValueSchema.$id).toBe(TEMPLATE_VALUE_SCHEMA_ID);

    const toolPayloadTemplateSchema = Object.values(
      (SentinelToolSchema as any).properties.watcher.properties.fire.properties.payloadTemplate
        .patternProperties,
    )[0];
    const validatorPayloadTemplateSchema = Object.values(
      (WatcherSchema as any).properties.fire.properties.payloadTemplate.patternProperties,
    )[0];

    expect(toolPayloadTemplateSchema).toBe(TemplateValueSchema);
    expect(validatorPayloadTemplateSchema).toBe(TemplateValueSchema);
  });

  it("supports runtime sentinel_control create/list without recursive ref collision", async () => {
    expect(() => {
      TypeCompiler.Compile(SentinelToolSchema);
      TypeCompiler.Compile(WatcherSchema);
    }).not.toThrow();

    const manager = {
      create: vi.fn(async () => ({ ok: true })),
      enable: vi.fn(async () => ({ ok: true })),
      disable: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => ({ ok: true })),
      status: vi.fn(() => ({ ok: true })),
      list: vi.fn(() => [{ id: "watcher-1" }]),
    } as any;

    const registerTool = vi.fn();
    registerSentinelControl(registerTool as any, manager);
    const factory = registerTool.mock.calls[0][0];
    const tool = factory({ messageChannel: "telegram", requesterSenderId: "123" });

    const createResult = await tool.execute("tc-1", { action: "create", watcher: validWatcher });
    expect(createResult).toBeTruthy();
    expect(manager.create).toHaveBeenCalledTimes(1);

    const listResult = await tool.execute("tc-2", { action: "list" });
    expect(listResult).toBeTruthy();
    expect(manager.list).toHaveBeenCalledTimes(1);
  });
});
