import { describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
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

function countSchemaIds(schema: unknown, id: string): number {
  let count = 0;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if ((node as Record<string, unknown>).$id === id) count += 1;
    for (const value of Object.values(node as Record<string, unknown>)) {
      walk(value);
    }
  };
  walk(schema);
  return count;
}

describe("sentinel_control schema refs", () => {
  it("stores template schema exactly once in each root schema", () => {
    expect(TemplateValueSchema.$id).toBe(TEMPLATE_VALUE_SCHEMA_ID);
    expect(countSchemaIds(SentinelToolSchema, TEMPLATE_VALUE_SCHEMA_ID)).toBe(1);
    expect(countSchemaIds(WatcherSchema, TEMPLATE_VALUE_SCHEMA_ID)).toBe(1);
  });

  it("compiles with Ajv even after cloning (runtime-like path)", () => {
    const buildAjv = () => new Ajv({ allErrors: true, strict: false, removeAdditional: false });

    expect(() => buildAjv().compile(SentinelToolSchema)).not.toThrow();
    expect(() => buildAjv().compile(WatcherSchema)).not.toThrow();
    expect(() => buildAjv().compile(JSON.parse(JSON.stringify(SentinelToolSchema)))).not.toThrow();
    expect(() => buildAjv().compile(JSON.parse(JSON.stringify(WatcherSchema)))).not.toThrow();
  });

  it("supports runtime sentinel_control create/list without recursive ref collision", async () => {
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
