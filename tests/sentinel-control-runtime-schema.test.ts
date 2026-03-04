import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { SentinelToolSchema, SentinelToolValidationSchema } from "../src/toolSchema.js";

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

const validCreatePayload = {
  action: "create",
  watcher: validWatcher,
};

const validListPayload = {
  action: "list",
};

function extractEnumValues(schema: unknown): unknown[] | undefined {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum)) {
    return record.enum;
  }
  if ("const" in record) {
    return [record.const];
  }
  const variants = Array.isArray(record.anyOf)
    ? record.anyOf
    : Array.isArray(record.oneOf)
      ? record.oneOf
      : null;
  if (!variants) {
    return undefined;
  }
  const values = variants.flatMap((variant) => extractEnumValues(variant) ?? []);
  return values.length > 0 ? values : undefined;
}

function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }

  const existingEnum = extractEnumValues(existing);
  const incomingEnum = extractEnumValues(incoming);
  if (existingEnum || incomingEnum) {
    const values = Array.from(new Set([...(existingEnum ?? []), ...(incomingEnum ?? [])]));
    const merged: Record<string, unknown> = {};
    for (const source of [existing, incoming]) {
      if (!source || typeof source !== "object") {
        continue;
      }
      const record = source as Record<string, unknown>;
      for (const key of ["title", "description", "default"]) {
        if (!(key in merged) && key in record) {
          merged[key] = record[key];
        }
      }
    }
    const types = new Set(values.map((value) => typeof value));
    if (types.size === 1) {
      merged.type = Array.from(types)[0];
    }
    merged.enum = values;
    return merged;
  }

  return existing;
}

// Mirrors OpenClaw's union flattening in normalizeToolParameters().
function normalizeOpenClawToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if ("type" in schema && "properties" in schema && !Array.isArray(schema.anyOf)) {
    return schema;
  }

  const variantKey = Array.isArray(schema.anyOf)
    ? "anyOf"
    : Array.isArray(schema.oneOf)
      ? "oneOf"
      : null;
  if (!variantKey) {
    return schema;
  }

  const variants = schema[variantKey] as unknown[];
  const mergedProperties: Record<string, unknown> = {};
  const requiredCounts = new Map<string, number>();
  let objectVariants = 0;

  for (const entry of variants) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const props = (entry as { properties?: unknown }).properties;
    if (!props || typeof props !== "object") {
      continue;
    }

    objectVariants += 1;
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
      if (!(key in mergedProperties)) {
        mergedProperties[key] = value;
        continue;
      }
      mergedProperties[key] = mergePropertySchemas(mergedProperties[key], value);
    }

    const required = Array.isArray((entry as { required?: unknown }).required)
      ? (entry as { required: unknown[] }).required
      : [];
    for (const key of required) {
      if (typeof key !== "string") {
        continue;
      }
      requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
    }
  }

  const baseRequired = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : undefined;
  const mergedRequired =
    baseRequired && baseRequired.length > 0
      ? baseRequired
      : objectVariants > 0
        ? Array.from(requiredCounts.entries())
            .filter(([, count]) => count === objectVariants)
            .map(([key]) => key)
        : undefined;

  return {
    type: "object",
    ...(typeof schema.title === "string" ? { title: schema.title } : {}),
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    properties:
      Object.keys(mergedProperties).length > 0 ? mergedProperties : (schema.properties ?? {}),
    ...(mergedRequired && mergedRequired.length > 0 ? { required: mergedRequired } : {}),
    additionalProperties: "additionalProperties" in schema ? schema.additionalProperties : true,
  };
}

function buildAjv() {
  return new Ajv({ allErrors: true, strict: false, removeAdditional: false });
}

describe("sentinel_control runtime schema path", () => {
  it("reproduces previous runtime failure for root-union schemas", () => {
    const normalized = normalizeOpenClawToolSchema(
      SentinelToolValidationSchema as Record<string, unknown>,
    );

    expect(() => buildAjv().compile(normalized)).toThrow(
      /can't resolve reference https:\/\/schemas\.coffeexcoin\.dev\/openclaw-sentinel\/template-value\.json from id #/i,
    );
  });

  it("keeps exported schema Ajv-compilable after OpenClaw normalization for create/list", () => {
    const normalized = normalizeOpenClawToolSchema(SentinelToolSchema as Record<string, unknown>);

    expect(normalized.type).toBe("object");
    expect(normalized.anyOf).toBeUndefined();

    const validate = buildAjv().compile(normalized);
    expect(validate(validCreatePayload)).toBe(true);
    expect(validate(validListPayload)).toBe(true);
  });
});
