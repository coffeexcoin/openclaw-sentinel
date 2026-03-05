import { Type } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DeliveryTarget, SentinelConfig } from "./types.js";
import { WatcherManager } from "./watcherManager.js";

const DEFAULT_HOOK_SESSION_PREFIX = "agent:main:hooks:sentinel";
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

type ActionToolContext = {
  sessionKey?: string;
};

type RegisterToolFn = (tool: AnyAgentTool | ((ctx: ActionToolContext) => AnyAgentTool)) => void;

function isSentinelSession(sessionKey: string | undefined, config: SentinelConfig): boolean {
  if (!sessionKey) return false;
  const prefix = (config.hookSessionPrefix ?? DEFAULT_HOOK_SESSION_PREFIX).replace(/:+$/g, "");
  return sessionKey.startsWith(prefix + ":");
}

function normalizeToolResultText(
  payload: unknown,
  fallbackText?: string,
): ReturnType<typeof jsonResult> {
  const preferredText = fallbackText?.trim();
  const safeText =
    preferredText && preferredText.length > 0 ? preferredText : (stringifyPayload(payload) ?? "ok");

  const result = jsonResult(payload) as ReturnType<typeof jsonResult>;
  const currentContent = Array.isArray((result as any).content)
    ? ([...(result as any).content] as any[])
    : [];

  let sawTextBlock = false;
  const normalized = currentContent.map((entry) => {
    if (!entry || typeof entry !== "object" || entry.type !== "text") return entry;
    sawTextBlock = true;
    if (typeof entry.text === "string" && entry.text.length > 0) return entry;
    return { ...entry, text: safeText };
  });

  if (!sawTextBlock) {
    normalized.unshift({ type: "text", text: safeText });
  }

  return {
    ...result,
    content: normalized,
  } as ReturnType<typeof jsonResult>;
}

function stringifyPayload(payload: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(payload, null, 2);
    if (typeof serialized !== "string" || serialized.length === 0) return undefined;
    return serialized;
  } catch {
    return undefined;
  }
}

const DeliveryTargetSchema = Type.Object(
  {
    channel: Type.String({ description: "Channel/provider id (e.g. telegram, discord)" }),
    to: Type.String({ description: "Destination id within the channel" }),
    accountId: Type.Optional(
      Type.String({ description: "Optional account id for multi-account channels" }),
    ),
  },
  { additionalProperties: false },
);

const SentinelActSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("run_command"),
      command: Type.String({ description: "Command to execute" }),
      args: Type.Optional(Type.Array(Type.String(), { description: "Command arguments" })),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds (default 30s, max 120s)",
          minimum: 1000,
          maximum: MAX_COMMAND_TIMEOUT_MS,
        }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("notify"),
      message: Type.String({ description: "Message to send" }),
      targets: Type.Optional(
        Type.Array(DeliveryTargetSchema, {
          description: "Delivery targets (defaults to envelope targets)",
        }),
      ),
    },
    { additionalProperties: false },
  ),
]);

const SentinelEscalateSchema = Type.Object(
  {
    reason: Type.String({ description: "Reason for escalation" }),
    severity: Type.Optional(
      Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("critical")], {
        description: "Escalation severity (default: warning)",
      }),
    ),
  },
  { additionalProperties: false },
);

export function registerSentinelActionTools(
  registerTool: RegisterToolFn,
  _manager: WatcherManager,
  api: OpenClawPluginApi,
  config: SentinelConfig,
): void {
  registerTool((ctx) => ({
    name: "sentinel_act",
    label: "sentinel_act",
    description:
      "Execute an action in response to a sentinel callback. Supports running commands or sending notifications.",
    parameters: SentinelActSchema,
    async execute(_toolCallId, params: any) {
      if (!isSentinelSession(ctx.sessionKey, config)) {
        return normalizeToolResultText(
          { ok: false, error: "sentinel_act can only be used in a sentinel callback session" },
          "Session guard: not a sentinel session",
        );
      }

      if (params.action === "run_command") {
        const argv = [params.command, ...(params.args ?? [])];
        const timeoutMs = Math.min(
          params.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          MAX_COMMAND_TIMEOUT_MS,
        );
        try {
          const result = await api.runtime.system.runCommandWithTimeout(argv, { timeoutMs });
          return normalizeToolResultText(
            {
              ok: true,
              code: result.code,
              stdout: result.stdout.slice(0, 4000),
              stderr: result.stderr.slice(0, 2000),
            },
            result.code === 0
              ? `Command completed (exit ${result.code})`
              : `Command failed (exit ${result.code})`,
          );
        } catch (err) {
          return normalizeToolResultText(
            { ok: false, error: String((err as Error)?.message ?? err) },
            `Command execution failed: ${String((err as Error)?.message ?? err)}`,
          );
        }
      }

      if (params.action === "notify") {
        const targets: DeliveryTarget[] = params.targets ?? [];
        if (targets.length === 0) {
          return normalizeToolResultText(
            { ok: false, error: "No delivery targets specified" },
            "No delivery targets specified",
          );
        }
        const results = await Promise.all(
          targets.map(async (target: DeliveryTarget) => {
            try {
              await notifyDeliveryTarget(api, target, params.message);
              return { target, ok: true };
            } catch (err) {
              return { target, ok: false, error: String((err as Error)?.message ?? err) };
            }
          }),
        );
        const delivered = results.filter((r) => r.ok).length;
        return normalizeToolResultText(
          { ok: true, delivered, failed: results.length - delivered, results },
          `Notified ${delivered}/${results.length} targets`,
        );
      }

      return normalizeToolResultText({ ok: false, error: "Unknown action" }, "Unknown action");
    },
  }));

  registerTool((ctx) => ({
    name: "sentinel_escalate",
    label: "sentinel_escalate",
    description:
      "Escalate a sentinel callback situation that requires user attention or is beyond automated resolution.",
    parameters: SentinelEscalateSchema,
    async execute(_toolCallId, params: any) {
      if (!isSentinelSession(ctx.sessionKey, config)) {
        return normalizeToolResultText(
          { ok: false, error: "sentinel_escalate can only be used in a sentinel callback session" },
          "Session guard: not a sentinel session",
        );
      }

      const severity = params.severity ?? "warning";
      api.logger?.info?.(
        `[openclaw-sentinel] Escalation: severity=${severity} reason=${params.reason}`,
      );

      return normalizeToolResultText(
        { ok: true, escalated: true, severity, reason: params.reason },
        `Escalation recorded (${severity}): ${params.reason}`,
      );
    },
  }));
}

async function notifyDeliveryTarget(
  api: OpenClawPluginApi,
  target: DeliveryTarget,
  message: string,
): Promise<void> {
  switch (target.channel) {
    case "telegram":
      await api.runtime.channel.telegram.sendMessageTelegram(target.to, message, {
        accountId: target.accountId,
      });
      return;
    case "discord":
      await api.runtime.channel.discord.sendMessageDiscord(target.to, message, {
        accountId: target.accountId,
      } as any);
      return;
    case "slack":
      await api.runtime.channel.slack.sendMessageSlack(target.to, message, {
        accountId: target.accountId,
      } as any);
      return;
    case "signal":
      await api.runtime.channel.signal.sendMessageSignal(target.to, message, {
        accountId: target.accountId,
      } as any);
      return;
    case "imessage":
      await api.runtime.channel.imessage.sendMessageIMessage(target.to, message, {
        accountId: target.accountId,
      } as any);
      return;
    case "whatsapp":
      await api.runtime.channel.whatsapp.sendMessageWhatsApp(target.to, message, {
        accountId: target.accountId,
      } as any);
      return;
    case "line":
      await api.runtime.channel.line.sendMessageLine(target.to, message, {
        accountId: target.accountId,
      } as any);
      return;
    default:
      throw new Error(`Unsupported delivery target channel: ${target.channel}`);
  }
}
