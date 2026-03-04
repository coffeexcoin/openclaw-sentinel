import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sentinelConfigSchema } from "./configSchema.js";
import { registerSentinelControl } from "./tool.js";
import {
  DEFAULT_SENTINEL_WEBHOOK_PATH,
  DeliveryTarget,
  HookResponseFallbackMode,
  SentinelConfig,
} from "./types.js";
import { WatcherManager } from "./watcherManager.js";

const registeredWebhookPathsByRegistrar = new WeakMap<object, Set<string>>();
const DEFAULT_HOOK_SESSION_PREFIX = "agent:main:hooks:sentinel";
const DEFAULT_RELAY_DEDUPE_WINDOW_MS = 120_000;
const DEFAULT_HOOK_RESPONSE_TIMEOUT_MS = 30_000;
const DEFAULT_HOOK_RESPONSE_FALLBACK_MODE: HookResponseFallbackMode = "concise";
const HOOK_RESPONSE_RELAY_CLEANUP_INTERVAL_MS = 60_000;
const MAX_SENTINEL_WEBHOOK_BODY_BYTES = 64 * 1024;
const MAX_SENTINEL_WEBHOOK_TEXT_CHARS = 8000;
const MAX_SENTINEL_PAYLOAD_JSON_CHARS = 2500;
const SENTINEL_CALLBACK_WAKE_REASON = "cron:sentinel-callback";
const SENTINEL_CALLBACK_CONTEXT_KEY = "cron:sentinel-callback";
const RESERVED_CONTROL_TOKEN_PATTERN = /\b(?:NO[\s_-]*REPLY|HEARTBEAT[\s_-]*OK)\b/gi;
const SENTINEL_EVENT_INSTRUCTION_PREFIX =
  "SENTINEL_TRIGGER: This system event came from /hooks/sentinel. Use watcher + payload context to decide safe follow-up actions and produce a user-facing response.";

const SUPPORTED_DELIVERY_CHANNELS = new Set([
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
  "whatsapp",
  "line",
]);

type SentinelDeliveryContext = {
  sessionKey?: string;
  messageChannel?: string;
  requesterSenderId?: string;
  agentAccountId?: string;
  currentChat?: DeliveryTarget;
  deliveryTargets?: DeliveryTarget[];
};

type SentinelEventEnvelope = {
  watcherId: string | null;
  eventName: string | null;
  skillId?: string;
  matchedAt: string;
  watcher: {
    id: string | null;
    skillId: string | null;
    eventName: string | null;
    intent: string | null;
    strategy: string | null;
    endpoint: string | null;
    match: string | null;
    conditions: unknown[];
    fireOnce: boolean | null;
  };
  trigger: {
    matchedAt: string;
    dedupeKey: string;
    priority: string | null;
  };
  context: unknown;
  payload: unknown;
  dedupeKey: string;
  correlationId: string;
  hookSessionGroup?: string;
  deliveryTargets?: DeliveryTarget[];
  deliveryContext?: SentinelDeliveryContext;
  source: {
    route: string;
    plugin: string;
  };
};

type RelayDeliverySummary = {
  dedupeKey: string;
  attempted: number;
  delivered: number;
  failed: number;
  deduped: boolean;
  pending: boolean;
  timeoutMs: number;
  fallbackMode: HookResponseFallbackMode;
};

type PendingHookResponse = {
  dedupeKey: string;
  sessionKey: string;
  relayTargets: DeliveryTarget[];
  fallbackMessage: string;
  createdAt: number;
  timeoutMs: number;
  fallbackMode: HookResponseFallbackMode;
  timer?: ReturnType<typeof setTimeout>;
  state: "pending" | "completed" | "timed_out";
};

function trimText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asIsoString(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sniffGatewayDispatchToken(
  configRoot: Record<string, unknown> | undefined,
): string | undefined {
  if (!configRoot) return undefined;

  const auth = isRecord(configRoot.auth) ? configRoot.auth : undefined;
  const gateway = isRecord(configRoot.gateway) ? configRoot.gateway : undefined;
  const gatewayAuth = gateway && isRecord(gateway.auth) ? gateway.auth : undefined;
  const server = isRecord(configRoot.server) ? configRoot.server : undefined;
  const serverAuth = server && isRecord(server.auth) ? server.auth : undefined;

  const candidates: unknown[] = [
    auth?.token,
    gateway?.authToken,
    gatewayAuth?.token,
    serverAuth?.token,
    configRoot.gatewayAuthToken,
    configRoot.authToken,
  ];

  for (const candidate of candidates) {
    const token = asString(candidate);
    if (token) return token;
  }

  return undefined;
}

function resolveSentinelPluginConfig(api: OpenClawPluginApi): Partial<SentinelConfig> {
  const pluginConfig = isRecord(api.pluginConfig)
    ? ({ ...api.pluginConfig } as Partial<SentinelConfig>)
    : {};

  const configRoot = isRecord(api.config) ? (api.config as Record<string, unknown>) : undefined;
  const legacyRootConfig = configRoot?.sentinel;

  let resolved: Partial<SentinelConfig> = pluginConfig;
  if (legacyRootConfig !== undefined) {
    api.logger?.warn?.(
      '[openclaw-sentinel] Detected deprecated root-level config key "sentinel". Move settings to plugins.entries.openclaw-sentinel.config. Root-level "sentinel" may fail with: Unrecognized key: "sentinel".',
    );

    if (isRecord(legacyRootConfig) && Object.keys(pluginConfig).length === 0) {
      resolved = { ...(legacyRootConfig as Partial<SentinelConfig>) };
    }
  }

  if (!asString(resolved.dispatchAuthToken)) {
    const sniffedToken = sniffGatewayDispatchToken(configRoot);
    if (sniffedToken) resolved.dispatchAuthToken = sniffedToken;
  }

  return resolved;
}

function isDeliveryTarget(value: unknown): value is DeliveryTarget {
  return (
    isRecord(value) &&
    typeof value.channel === "string" &&
    typeof value.to === "string" &&
    (value.accountId === undefined || typeof value.accountId === "string")
  );
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return DEFAULT_SENTINEL_WEBHOOK_PATH;
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function sanitizeSessionSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized.length > 0 ? sanitized.slice(0, 64) : "unknown";
}

function clipPayloadForPrompt(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (!serialized) return value;
  if (serialized.length <= MAX_SENTINEL_PAYLOAD_JSON_CHARS) return value;

  const clipped = serialized.slice(0, MAX_SENTINEL_PAYLOAD_JSON_CHARS);
  const overflow = serialized.length - clipped.length;
  return {
    __truncated: true,
    truncatedChars: overflow,
    maxChars: MAX_SENTINEL_PAYLOAD_JSON_CHARS,
    preview: `${clipped}…`,
  };
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  let cursor: unknown = value;
  for (const segment of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return asString(cursor);
}

function extractDeliveryContext(
  payload: Record<string, unknown>,
): SentinelDeliveryContext | undefined {
  const raw = isRecord(payload.deliveryContext) ? payload.deliveryContext : undefined;
  if (!raw) return undefined;

  const sessionKey =
    asString(raw.sessionKey) ??
    asString(raw.sourceSessionKey) ??
    getNestedString(raw, ["source", "sessionKey"]);

  const messageChannel = asString(raw.messageChannel);
  const requesterSenderId = asString(raw.requesterSenderId);
  const agentAccountId = asString(raw.agentAccountId);

  const currentChat = isDeliveryTarget(raw.currentChat)
    ? raw.currentChat
    : isDeliveryTarget(raw.deliveryTarget)
      ? raw.deliveryTarget
      : undefined;

  const deliveryTargets = Array.isArray(raw.deliveryTargets)
    ? raw.deliveryTargets.filter(isDeliveryTarget)
    : undefined;

  const context: SentinelDeliveryContext = {};
  if (sessionKey) context.sessionKey = sessionKey;
  if (messageChannel) context.messageChannel = messageChannel;
  if (requesterSenderId) context.requesterSenderId = requesterSenderId;
  if (agentAccountId) context.agentAccountId = agentAccountId;
  if (currentChat) context.currentChat = currentChat;
  if (deliveryTargets && deliveryTargets.length > 0) context.deliveryTargets = deliveryTargets;

  return Object.keys(context).length > 0 ? context : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function buildSentinelEventEnvelope(payload: Record<string, unknown>): SentinelEventEnvelope {
  const watcherRecord = isRecord(payload.watcher) ? payload.watcher : undefined;
  const triggerRecord = isRecord(payload.trigger) ? payload.trigger : undefined;

  const watcherId =
    asString(payload.watcherId) ??
    asString(watcherRecord?.id) ??
    getNestedString(payload, ["context", "watcherId"]);

  const eventName =
    asString(payload.eventName) ??
    asString(watcherRecord?.eventName) ??
    getNestedString(payload, ["event", "name"]);

  const skillId =
    asString(payload.skillId) ??
    asString(watcherRecord?.skillId) ??
    getNestedString(payload, ["context", "skillId"]) ??
    undefined;

  const matchedAt =
    asIsoString(payload.matchedAt) ??
    asIsoString(payload.timestamp) ??
    asIsoString(triggerRecord?.matchedAt) ??
    new Date().toISOString();

  const dedupeSeed = JSON.stringify({
    watcherId: watcherId ?? null,
    eventName: eventName ?? null,
    matchedAt,
  });
  const generatedDedupe = createHash("sha256").update(dedupeSeed).digest("hex").slice(0, 16);
  const dedupeKey =
    asString(payload.dedupeKey) ??
    asString(payload.correlationId) ??
    asString(payload.correlationID) ??
    asString(triggerRecord?.dedupeKey) ??
    generatedDedupe;

  const rawPayload =
    payload.payload ??
    (isRecord(payload.event) ? (payload.event.payload ?? payload.event.data) : undefined) ??
    payload;
  const rawContext =
    payload.context ??
    (isRecord(rawPayload) ? rawPayload.context : undefined) ??
    (isRecord(payload.event) ? payload.event.context : undefined) ??
    null;

  const deliveryTargets = Array.isArray(payload.deliveryTargets)
    ? payload.deliveryTargets.filter(isDeliveryTarget)
    : undefined;

  const sourceRoute =
    getNestedString(payload, ["source", "route"]) ?? DEFAULT_SENTINEL_WEBHOOK_PATH;
  const sourcePlugin = getNestedString(payload, ["source", "plugin"]) ?? "openclaw-sentinel";

  const hookSessionGroup =
    asString(payload.hookSessionGroup) ??
    asString(payload.sessionGroup) ??
    asString(watcherRecord?.sessionGroup);

  const deliveryContext = extractDeliveryContext(payload);

  const watcherIntent = asString(payload.intent) ?? asString(watcherRecord?.intent) ?? null;
  const watcherStrategy = asString(watcherRecord?.strategy) ?? asString(payload.strategy) ?? null;
  const watcherEndpoint = asString(watcherRecord?.endpoint) ?? asString(payload.endpoint) ?? null;
  const watcherMatch = asString(watcherRecord?.match) ?? asString(payload.match) ?? null;
  const watcherConditions = Array.isArray(watcherRecord?.conditions)
    ? watcherRecord.conditions
    : Array.isArray(payload.conditions)
      ? payload.conditions
      : [];
  const watcherFireOnce = asBoolean(watcherRecord?.fireOnce ?? payload.fireOnce) ?? null;

  const triggerPriority = asString(payload.priority) ?? asString(triggerRecord?.priority) ?? null;

  const envelope: SentinelEventEnvelope = {
    watcherId: watcherId ?? null,
    eventName: eventName ?? null,
    matchedAt,
    watcher: {
      id: watcherId ?? null,
      skillId: skillId ?? null,
      eventName: eventName ?? null,
      intent: watcherIntent,
      strategy: watcherStrategy,
      endpoint: watcherEndpoint,
      match: watcherMatch,
      conditions: watcherConditions,
      fireOnce: watcherFireOnce,
    },
    trigger: {
      matchedAt,
      dedupeKey,
      priority: triggerPriority,
    },
    context: clipPayloadForPrompt(rawContext),
    payload: clipPayloadForPrompt(rawPayload),
    dedupeKey,
    correlationId: dedupeKey,
    source: {
      route: sourceRoute,
      plugin: sourcePlugin,
    },
  };

  if (skillId) envelope.skillId = skillId;
  if (hookSessionGroup) envelope.hookSessionGroup = hookSessionGroup;
  if (deliveryTargets && deliveryTargets.length > 0) envelope.deliveryTargets = deliveryTargets;
  if (deliveryContext) envelope.deliveryContext = deliveryContext;

  return envelope;
}

function buildSentinelSystemEvent(envelope: SentinelEventEnvelope): string {
  const callbackContext = {
    watcher: envelope.watcher,
    trigger: envelope.trigger,
    source: envelope.source,
    deliveryTargets: envelope.deliveryTargets ?? [],
    deliveryContext: envelope.deliveryContext ?? null,
    context: envelope.context,
    payload: envelope.payload,
  };

  const text = [
    SENTINEL_EVENT_INSTRUCTION_PREFIX,
    "Callback handling requirements:",
    "- Base actions on watcher intent/event/skill plus the callback context and payload.",
    "- Return a concise user-facing response that reflects what triggered and what to do next.",
    "- Never emit control tokens such as NO_REPLY or HEARTBEAT_OK.",
    "SENTINEL_CALLBACK_CONTEXT_JSON:",
    JSON.stringify(callbackContext, null, 2),
    "SENTINEL_ENVELOPE_JSON:",
    JSON.stringify(envelope, null, 2),
  ].join("\n");

  return trimText(text, MAX_SENTINEL_WEBHOOK_TEXT_CHARS);
}

function normalizeDeliveryTargets(targets: DeliveryTarget[]): DeliveryTarget[] {
  const deduped = new Map<string, DeliveryTarget>();
  for (const target of targets) {
    const channel = asString(target.channel);
    const to = asString(target.to);
    if (!channel || !to || !SUPPORTED_DELIVERY_CHANNELS.has(channel)) continue;
    const accountId = asString(target.accountId);
    const key = `${channel}:${to}:${accountId ?? ""}`;
    deduped.set(key, { channel, to, ...(accountId ? { accountId } : {}) });
  }
  return [...deduped.values()];
}

function inferTargetFromSessionKey(
  sessionKey: string,
  accountId?: string,
): DeliveryTarget | undefined {
  const segments = sessionKey
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length < 5) return undefined;

  const channel = segments[2];
  const to = segments.at(-1);
  if (!channel || !to || !SUPPORTED_DELIVERY_CHANNELS.has(channel)) return undefined;

  return {
    channel,
    to,
    ...(accountId ? { accountId } : {}),
  };
}

function inferRelayTargets(
  payload: Record<string, unknown>,
  envelope: SentinelEventEnvelope,
): DeliveryTarget[] {
  const inferred: DeliveryTarget[] = [];

  if (envelope.deliveryTargets?.length) inferred.push(...envelope.deliveryTargets);

  if (envelope.deliveryContext?.deliveryTargets?.length) {
    inferred.push(...envelope.deliveryContext.deliveryTargets);
  }

  if (envelope.deliveryContext?.currentChat) inferred.push(envelope.deliveryContext.currentChat);

  if (envelope.deliveryContext?.messageChannel && envelope.deliveryContext?.requesterSenderId) {
    if (SUPPORTED_DELIVERY_CHANNELS.has(envelope.deliveryContext.messageChannel)) {
      inferred.push({
        channel: envelope.deliveryContext.messageChannel,
        to: envelope.deliveryContext.requesterSenderId,
        ...(envelope.deliveryContext.agentAccountId
          ? { accountId: envelope.deliveryContext.agentAccountId }
          : {}),
      });
    }
  }

  if (envelope.deliveryContext?.sessionKey) {
    const target = inferTargetFromSessionKey(
      envelope.deliveryContext.sessionKey,
      envelope.deliveryContext.agentAccountId,
    );
    if (target) inferred.push(target);
  }

  if (isDeliveryTarget(payload.currentChat)) inferred.push(payload.currentChat);

  const sourceCurrentChat = isRecord(payload.source) ? payload.source.currentChat : undefined;
  if (isDeliveryTarget(sourceCurrentChat)) inferred.push(sourceCurrentChat);

  const messageChannel = asString(payload.messageChannel);
  const requesterSenderId = asString(payload.requesterSenderId);
  if (messageChannel && requesterSenderId && SUPPORTED_DELIVERY_CHANNELS.has(messageChannel)) {
    inferred.push({ channel: messageChannel, to: requesterSenderId });
  }

  const fromSessionKey = asString(payload.sessionKey);
  if (fromSessionKey) {
    const target = inferTargetFromSessionKey(fromSessionKey, asString(payload.agentAccountId));
    if (target) inferred.push(target);
  }

  const sourceSessionKey = getNestedString(payload, ["source", "sessionKey"]);
  if (sourceSessionKey) {
    const sourceAccountId = getNestedString(payload, ["source", "accountId"]);
    const target = inferTargetFromSessionKey(sourceSessionKey, sourceAccountId);
    if (target) inferred.push(target);
  }

  return normalizeDeliveryTargets(inferred);
}

function summarizeContext(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;

  const entries = Object.entries(value).slice(0, 3);
  if (entries.length === 0) return undefined;

  const chunks = entries.map(([key, val]) => {
    if (typeof val === "string") return `${key}=${trimText(val, 64)}`;
    if (typeof val === "number" || typeof val === "boolean") return `${key}=${String(val)}`;
    return `${key}=${trimText(JSON.stringify(val), 64)}`;
  });
  return chunks.join(" · ");
}

function buildRelayMessage(envelope: SentinelEventEnvelope): string {
  const title = envelope.eventName ? `Sentinel alert: ${envelope.eventName}` : "Sentinel alert";
  const watcher = envelope.watcherId ? `watcher ${envelope.watcherId}` : "watcher unknown";
  const intent = envelope.watcher.intent ? `intent ${envelope.watcher.intent}` : undefined;

  const contextSummary = summarizeContext(envelope.context) ?? summarizeContext(envelope.payload);

  const lines = [title, `${watcher} · ${envelope.matchedAt}`];
  if (intent) lines.push(intent);
  if (contextSummary) lines.push(contextSummary);

  const text = lines.join("\n").trim();
  return text.length > 0
    ? text
    : "Sentinel callback received, but no assistant detail was generated.";
}

function normalizeControlTokenCandidate(value: string): string {
  return value.replace(/[^a-zA-Z]/g, "").toUpperCase();
}

function sanitizeAssistantRelaySegment(value: string): string {
  if (typeof value !== "string") return "";

  const tokenCandidate = normalizeControlTokenCandidate(value.trim());
  if (tokenCandidate === "NOREPLY" || tokenCandidate === "HEARTBEATOK") return "";

  const withoutTokens = value.replace(RESERVED_CONTROL_TOKEN_PATTERN, " ").trim();
  if (!withoutTokens) return "";

  const collapsed = withoutTokens.replace(/\s+/g, " ").trim();
  return /[a-zA-Z0-9]/.test(collapsed) ? collapsed : "";
}

function normalizeAssistantRelayText(assistantTexts: string[]): string | undefined {
  if (!Array.isArray(assistantTexts) || assistantTexts.length === 0) return undefined;
  const parts = assistantTexts.map(sanitizeAssistantRelaySegment).filter(Boolean);
  if (parts.length === 0) return undefined;
  return trimText(parts.join("\n\n"), MAX_SENTINEL_WEBHOOK_TEXT_CHARS);
}

function resolveHookResponseDedupeWindowMs(config: SentinelConfig): number {
  const candidate =
    config.hookResponseDedupeWindowMs ??
    config.hookRelayDedupeWindowMs ??
    DEFAULT_RELAY_DEDUPE_WINDOW_MS;
  return Math.max(0, candidate);
}

function resolveHookResponseTimeoutMs(config: SentinelConfig): number {
  const candidate = config.hookResponseTimeoutMs ?? DEFAULT_HOOK_RESPONSE_TIMEOUT_MS;
  return Math.max(0, candidate);
}

function resolveHookResponseFallbackMode(config: SentinelConfig): HookResponseFallbackMode {
  return config.hookResponseFallbackMode === "none" ? "none" : DEFAULT_HOOK_RESPONSE_FALLBACK_MODE;
}

function buildIsolatedHookSessionKey(
  envelope: SentinelEventEnvelope,
  config: SentinelConfig,
): string {
  const configuredPrefix = asString(config.hookSessionPrefix);
  const legacyPrefix = asString(config.hookSessionKey);
  const hasCustomPrefix =
    typeof configuredPrefix === "string" && configuredPrefix !== DEFAULT_HOOK_SESSION_PREFIX;

  const rawPrefix = hasCustomPrefix
    ? configuredPrefix
    : (legacyPrefix ?? configuredPrefix ?? DEFAULT_HOOK_SESSION_PREFIX);
  const prefix = rawPrefix.replace(/:+$/g, "");

  const group = asString(envelope.hookSessionGroup) ?? asString(config.hookSessionGroup);
  if (group) {
    return `${prefix}:group:${sanitizeSessionSegment(group)}`;
  }

  if (envelope.watcherId) {
    return `${prefix}:watcher:${sanitizeSessionSegment(envelope.watcherId)}`;
  }

  if (envelope.dedupeKey) {
    return `${prefix}:event:${sanitizeSessionSegment(envelope.dedupeKey.slice(0, 24))}`;
  }

  return `${prefix}:event:unknown`;
}

function assertJsonContentType(req: IncomingMessage): void {
  const raw = req.headers["content-type"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return;

  const normalized = header.toLowerCase();
  const isJson =
    normalized.includes("application/json") ||
    normalized.includes("application/cloudevents+json") ||
    normalized.includes("+json");

  if (!isJson) {
    throw new Error(`Unsupported Content-Type: ${header}`);
  }
}

async function readSentinelWebhookPayload(req: IncomingMessage): Promise<Record<string, unknown>> {
  assertJsonContentType(req);

  const preParsed = (req as { body?: unknown }).body;
  if (preParsed !== undefined) {
    if (!isRecord(preParsed)) {
      throw new Error("Payload must be a JSON object");
    }
    return preParsed;
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += next.length;
    if (total > MAX_SENTINEL_WEBHOOK_BODY_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(next);
  }

  if (chunks.length === 0) return {};

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON payload");
  }

  if (!isRecord(parsed)) {
    throw new Error("Payload must be a JSON object");
  }

  return parsed;
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

async function deliverMessageToTargets(
  api: OpenClawPluginApi,
  targets: DeliveryTarget[],
  message: string,
): Promise<{ delivered: number; failed: number }> {
  if (targets.length === 0) return { delivered: 0, failed: 0 };

  const results = await Promise.all(
    targets.map(async (target) => {
      try {
        await notifyDeliveryTarget(api, target, message);
        return true;
      } catch {
        return false;
      }
    }),
  );

  const delivered = results.filter(Boolean).length;
  return {
    delivered,
    failed: results.length - delivered,
  };
}

class HookResponseRelayManager {
  private recentByDedupe = new Map<string, number>();
  private pendingByDedupe = new Map<string, PendingHookResponse>();
  private pendingQueueBySession = new Map<string, string[]>();
  private cleanupTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private readonly config: SentinelConfig,
    private readonly api: OpenClawPluginApi,
  ) {}

  register(args: {
    dedupeKey: string;
    sessionKey: string;
    relayTargets: DeliveryTarget[];
    fallbackMessage: string;
  }): RelayDeliverySummary {
    this.cleanup();

    const dedupeWindowMs = resolveHookResponseDedupeWindowMs(this.config);
    const now = Date.now();

    const existingTs = this.recentByDedupe.get(args.dedupeKey);
    if (
      dedupeWindowMs > 0 &&
      typeof existingTs === "number" &&
      now - existingTs <= dedupeWindowMs
    ) {
      return {
        dedupeKey: args.dedupeKey,
        attempted: args.relayTargets.length,
        delivered: 0,
        failed: 0,
        deduped: true,
        pending: false,
        timeoutMs: resolveHookResponseTimeoutMs(this.config),
        fallbackMode: resolveHookResponseFallbackMode(this.config),
      };
    }

    this.recentByDedupe.set(args.dedupeKey, now);
    this.scheduleCleanup();

    const timeoutMs = resolveHookResponseTimeoutMs(this.config);
    const fallbackMode = resolveHookResponseFallbackMode(this.config);

    if (args.relayTargets.length === 0) {
      return {
        dedupeKey: args.dedupeKey,
        attempted: 0,
        delivered: 0,
        failed: 0,
        deduped: false,
        pending: false,
        timeoutMs,
        fallbackMode,
      };
    }

    const pending: PendingHookResponse = {
      dedupeKey: args.dedupeKey,
      sessionKey: args.sessionKey,
      relayTargets: args.relayTargets,
      fallbackMessage: args.fallbackMessage,
      createdAt: now,
      timeoutMs,
      fallbackMode,
      state: "pending",
    };

    this.pendingByDedupe.set(args.dedupeKey, pending);
    const queue = this.pendingQueueBySession.get(args.sessionKey) ?? [];
    queue.push(args.dedupeKey);
    this.pendingQueueBySession.set(args.sessionKey, queue);

    if (timeoutMs === 0) {
      void this.handleTimeout(args.dedupeKey);
    } else {
      pending.timer = setTimeout(() => {
        void this.handleTimeout(args.dedupeKey);
      }, timeoutMs);
    }

    return {
      dedupeKey: args.dedupeKey,
      attempted: args.relayTargets.length,
      delivered: 0,
      failed: 0,
      deduped: false,
      pending: true,
      timeoutMs,
      fallbackMode,
    };
  }

  async handleLlmOutput(sessionKey: string | undefined, assistantTexts: string[]): Promise<void> {
    if (!sessionKey) return;
    if (!Array.isArray(assistantTexts) || assistantTexts.length === 0) return;

    const dedupeKey = this.popNextPendingDedupe(sessionKey);
    if (!dedupeKey) return;

    const pending = this.pendingByDedupe.get(dedupeKey);
    if (!pending || pending.state !== "pending") return;

    const assistantMessage = normalizeAssistantRelayText(assistantTexts);
    if (assistantMessage) {
      await this.completeWithMessage(pending, assistantMessage, "assistant");
      return;
    }

    await this.completeWithMessage(pending, pending.fallbackMessage, "guardrail");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    for (const pending of this.pendingByDedupe.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      }
    }

    this.pendingByDedupe.clear();
    this.pendingQueueBySession.clear();
    this.recentByDedupe.clear();
  }

  private scheduleCleanup(): void {
    if (this.disposed || this.cleanupTimer) return;

    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      this.cleanup();
    }, HOOK_RESPONSE_RELAY_CLEANUP_INTERVAL_MS);

    this.cleanupTimer.unref?.();
  }

  private cleanup(now = Date.now()): void {
    const dedupeWindowMs = resolveHookResponseDedupeWindowMs(this.config);

    if (dedupeWindowMs > 0) {
      for (const [key, ts] of this.recentByDedupe.entries()) {
        if (now - ts > dedupeWindowMs) {
          this.recentByDedupe.delete(key);
        }
      }
    }

    for (const [key, pending] of this.pendingByDedupe.entries()) {
      const gcAfterMs = Math.max(pending.timeoutMs, dedupeWindowMs, 1_000);
      if (pending.state !== "pending" && now - pending.createdAt > gcAfterMs) {
        this.pendingByDedupe.delete(key);
        this.removeFromSessionQueue(pending.sessionKey, key);
      }
    }

    if (this.pendingByDedupe.size > 0 || this.recentByDedupe.size > 0) {
      this.scheduleCleanup();
    }
  }

  private removeFromSessionQueue(sessionKey: string, dedupeKey: string): void {
    const queue = this.pendingQueueBySession.get(sessionKey);
    if (!queue || queue.length === 0) return;

    const filtered = queue.filter((key) => key !== dedupeKey);
    if (filtered.length === 0) {
      this.pendingQueueBySession.delete(sessionKey);
      return;
    }

    this.pendingQueueBySession.set(sessionKey, filtered);
  }

  private popNextPendingDedupe(sessionKey: string): string | undefined {
    const queue = this.pendingQueueBySession.get(sessionKey);
    if (!queue || queue.length === 0) return undefined;

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) continue;
      const pending = this.pendingByDedupe.get(next);
      if (pending && pending.state === "pending") {
        if (queue.length === 0) this.pendingQueueBySession.delete(sessionKey);
        else this.pendingQueueBySession.set(sessionKey, queue);
        return next;
      }
    }

    this.pendingQueueBySession.delete(sessionKey);
    return undefined;
  }

  private async handleTimeout(dedupeKey: string): Promise<void> {
    const pending = this.pendingByDedupe.get(dedupeKey);
    if (!pending || pending.state !== "pending") return;

    if (pending.fallbackMode === "none") {
      this.markClosed(pending, "timed_out");
      return;
    }

    await this.completeWithMessage(pending, pending.fallbackMessage, "timeout");
  }

  private async completeWithMessage(
    pending: PendingHookResponse,
    message: string,
    source: "assistant" | "timeout" | "guardrail",
  ): Promise<void> {
    const delivery = await deliverMessageToTargets(this.api, pending.relayTargets, message);

    this.markClosed(pending, source === "assistant" ? "completed" : "timed_out");

    const action =
      source === "assistant"
        ? "Relayed assistant response"
        : source === "guardrail"
          ? "Sent guardrail fallback"
          : "Sent timeout fallback";

    this.api.logger?.info?.(
      `[openclaw-sentinel] ${action} for dedupe=${pending.dedupeKey} delivered=${delivery.delivered} failed=${delivery.failed}`,
    );
  }

  private markClosed(pending: PendingHookResponse, state: "completed" | "timed_out"): void {
    pending.state = state;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    this.pendingByDedupe.set(pending.dedupeKey, pending);
  }
}

export function createSentinelPlugin(overrides?: Partial<SentinelConfig>) {
  const config: SentinelConfig = {
    allowedHosts: [],
    localDispatchBase: "http://127.0.0.1:18789",
    dispatchAuthToken: asString(process.env.SENTINEL_DISPATCH_TOKEN),
    hookSessionPrefix: DEFAULT_HOOK_SESSION_PREFIX,
    hookRelayDedupeWindowMs: DEFAULT_RELAY_DEDUPE_WINDOW_MS,
    hookResponseTimeoutMs: DEFAULT_HOOK_RESPONSE_TIMEOUT_MS,
    hookResponseFallbackMode: DEFAULT_HOOK_RESPONSE_FALLBACK_MODE,
    hookResponseDedupeWindowMs: DEFAULT_RELAY_DEDUPE_WINDOW_MS,
    notificationPayloadMode: "concise",
    limits: {
      maxWatchersTotal: 200,
      maxWatchersPerSkill: 20,
      maxConditionsPerWatcher: 25,
      maxIntervalMsFloor: 1000,
    },
    ...overrides,
  };

  const manager = new WatcherManager(config, {
    async dispatch(path, body) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.dispatchAuthToken) headers.authorization = `Bearer ${config.dispatchAuthToken}`;

      const response = await fetch(`${config.localDispatchBase}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        let responseBody = "";
        try {
          responseBody = await response.text();
        } catch {
          responseBody = "";
        }
        const details = responseBody ? ` body=${trimText(responseBody, 256)}` : "";
        const error = new Error(
          `dispatch failed with status ${response.status}${details}`,
        ) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
    },
  });

  return {
    manager,
    async init() {
      await manager.init();
    },
    register(api: OpenClawPluginApi) {
      const runtimeConfig = resolveSentinelPluginConfig(api);
      if (Object.keys(runtimeConfig).length > 0) Object.assign(config, runtimeConfig);
      config.dispatchAuthToken = asString(config.dispatchAuthToken);

      manager.setLogger(api.logger);

      if (Array.isArray(config.allowedHosts) && config.allowedHosts.length === 0) {
        api.logger?.warn?.(
          "[openclaw-sentinel] allowedHosts is empty. Watcher creation will fail until at least one host is configured.",
        );
      }

      const hasLegacyHookSessionKey = !!asString(config.hookSessionKey);
      const hasCustomHookSessionPrefix =
        !!asString(config.hookSessionPrefix) &&
        asString(config.hookSessionPrefix) !== DEFAULT_HOOK_SESSION_PREFIX;
      if (hasLegacyHookSessionKey) {
        api.logger?.warn?.(
          hasCustomHookSessionPrefix
            ? "[openclaw-sentinel] hookSessionKey is deprecated and ignored when hookSessionPrefix is set. Remove hookSessionKey from config."
            : "[openclaw-sentinel] hookSessionKey is deprecated. Rename it to hookSessionPrefix.",
        );
      }

      manager.setNotifier({
        async notify(target, message) {
          await notifyDeliveryTarget(api, target, message);
        },
      });

      registerSentinelControl(api.registerTool.bind(api), manager);

      const path = normalizePath(DEFAULT_SENTINEL_WEBHOOK_PATH);
      if (!api.registerHttpRoute) {
        const msg =
          "registerHttpRoute API not available; default sentinel webhook route was not registered";
        manager.setWebhookRegistrationStatus("error", msg, path);
        api.logger?.error?.(`[openclaw-sentinel] ${msg}`);
        return;
      }

      const registrarKey = api.registerHttpRoute as unknown as object;
      const registeredPaths =
        registeredWebhookPathsByRegistrar.get(registrarKey) ?? new Set<string>();
      registeredWebhookPathsByRegistrar.set(registrarKey, registeredPaths);
      if (registeredPaths.has(path)) {
        manager.setWebhookRegistrationStatus("ok", "Route already registered (idempotent)", path);
        return;
      }

      const hookResponseRelayManager = new HookResponseRelayManager(config, api);
      if (typeof api.on === "function") {
        api.on("llm_output", (event, ctx) => {
          void hookResponseRelayManager.handleLlmOutput(ctx?.sessionKey, event.assistantTexts);
        });
      }

      try {
        api.registerHttpRoute({
          path,
          auth: "gateway",
          match: "exact",
          replaceExisting: true,
          async handler(req, res) {
            if (req.method !== "POST") {
              res.writeHead(405, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }

            try {
              const payload = await readSentinelWebhookPayload(req);
              const envelope = buildSentinelEventEnvelope(payload);
              const sessionKey = buildIsolatedHookSessionKey(envelope, config);
              const text = buildSentinelSystemEvent(envelope);
              const enqueued = api.runtime.system.enqueueSystemEvent(text, {
                sessionKey,
                contextKey: SENTINEL_CALLBACK_CONTEXT_KEY,
              });
              api.runtime.system.requestHeartbeatNow({
                reason: SENTINEL_CALLBACK_WAKE_REASON,
                sessionKey,
              });

              const relayTargets = inferRelayTargets(payload, envelope);
              const relay = hookResponseRelayManager.register({
                dedupeKey: envelope.dedupeKey,
                sessionKey,
                relayTargets,
                fallbackMessage: buildRelayMessage(envelope),
              });

              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: true,
                  route: path,
                  sessionKey,
                  enqueued,
                  relay,
                }),
              );
            } catch (err) {
              const message = String((err as Error)?.message ?? err);
              const badRequest =
                message.includes("Invalid JSON payload") ||
                message.includes("Payload must be a JSON object");
              const unsupportedMediaType = message.includes("Unsupported Content-Type");
              const status = message.includes("too large")
                ? 413
                : unsupportedMediaType
                  ? 415
                  : badRequest
                    ? 400
                    : 500;
              res.writeHead(status, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: message }));
            }
          },
        });
        registeredPaths.add(path);
        manager.setWebhookRegistrationStatus("ok", "Route registered", path);
        api.logger?.info?.(`[openclaw-sentinel] Registered default webhook route ${path}`);
      } catch (err) {
        hookResponseRelayManager.dispose();
        const msg = `Failed to register default webhook route ${path}: ${String((err as Error)?.message ?? err)}`;
        manager.setWebhookRegistrationStatus("error", msg, path);
        api.logger?.error?.(`[openclaw-sentinel] ${msg}`);
      }
    },
  };
}

// OpenClaw plugin entrypoint (default plugin object with register)
const sentinelPlugin = {
  id: "openclaw-sentinel",
  name: "OpenClaw Sentinel",
  description: "Secure declarative gateway-native watcher plugin for OpenClaw",
  configSchema: sentinelConfigSchema,
  register(api: OpenClawPluginApi) {
    const plugin = createSentinelPlugin(api.pluginConfig as Partial<SentinelConfig>);
    plugin.register(api);
    void plugin.init();
  },
};

export const register = sentinelPlugin.register.bind(sentinelPlugin);
export const activate = sentinelPlugin.register.bind(sentinelPlugin);
export default sentinelPlugin;

export * from "./types.js";
