import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { SentinelToolSchema, SentinelToolValidationSchema } from "../src/toolSchema.js";
import { TemplateValueSchema } from "../src/templateValueSchema.js";

const validCreate = {
  action: "create",
  watcher: {
    id: "w1",
    skillId: "skills.test",
    enabled: true,
    strategy: "http-poll",
    endpoint: "https://api.github.com/events",
    intervalMs: 1000,
    match: "all",
    conditions: [{ path: "type", op: "eq", value: "PushEvent" }],
    fire: {
      webhookPath: "/hooks/agent",
      eventName: "evt",
      payloadTemplate: { event: "${event.name}" },
    },
    retry: { maxRetries: 1, baseMs: 100, maxMs: 1000 },
  },
};

describe("tool schema validation", () => {
  it("accepts valid create payload in both runtime and strict schemas", () => {
    expect(Value.Check(SentinelToolSchema, [TemplateValueSchema], validCreate)).toBe(true);
    expect(Value.Check(SentinelToolValidationSchema, [TemplateValueSchema], validCreate)).toBe(
      true,
    );
  });

  it("rejects invalid action", () => {
    const bad = { action: "noop" };
    expect(Value.Check(SentinelToolSchema, [TemplateValueSchema], bad)).toBe(false);
    expect(Value.Check(SentinelToolValidationSchema, [TemplateValueSchema], bad)).toBe(false);
  });

  it("rejects unknown top-level fields", () => {
    const bad = { ...validCreate, unexpected: true } as any;
    expect(Value.Check(SentinelToolSchema, [TemplateValueSchema], bad)).toBe(false);
    expect(Value.Check(SentinelToolValidationSchema, [TemplateValueSchema], bad)).toBe(false);
  });

  it("keeps strict action-specific validation for required fields", () => {
    expect(
      Value.Check(SentinelToolSchema, [TemplateValueSchema], { action: "list", id: "x" }),
    ).toBe(true);
    expect(
      Value.Check(SentinelToolValidationSchema, [TemplateValueSchema], { action: "list", id: "x" }),
    ).toBe(false);
  });
});
