import { jsonResult } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { WatcherManager } from "./watcherManager.js";
import { SentinelToolSchema } from "./toolSchema.js";

export type SentinelToolParams = Static<typeof SentinelToolSchema>;

function validateParams(params: unknown): SentinelToolParams {
  const candidate = (params ?? {}) as Record<string, unknown>;
  if (!Value.Check(SentinelToolSchema, candidate)) {
    const first = [...Value.Errors(SentinelToolSchema, candidate)][0];
    const where = first?.path || "(root)";
    const why = first?.message || "Invalid parameters";
    throw new Error(`Invalid sentinel_control parameters at ${where}: ${why}`);
  }
  return candidate as SentinelToolParams;
}

type RegisterToolFn = (tool: AnyAgentTool) => void;

export function registerSentinelControl(
  registerTool: RegisterToolFn,
  manager: WatcherManager,
): void {
  registerTool({
    name: "sentinel_control",
    label: "sentinel_control",
    description: "Create/manage sentinel watchers",
    parameters: SentinelToolSchema,
    async execute(_toolCallId, params: SentinelToolParams) {
      const payload = validateParams(params);
      switch (payload.action) {
        case "create":
          return jsonResult(await manager.create(payload.watcher));
        case "enable":
          return jsonResult(await manager.enable(payload.id ?? ""));
        case "disable":
          return jsonResult(await manager.disable(payload.id ?? ""));
        case "remove":
          return jsonResult(await manager.remove(payload.id ?? ""));
        case "status":
          return jsonResult(manager.status(payload.id ?? ""));
        case "list":
          return jsonResult(manager.list());
      }
    },
  });
}
