import { describe, expect, it } from "vitest";
import { validateWatcherDefinition } from "../src/validator.js";
import { DEFAULT_SENTINEL_WEBHOOK_PATH } from "../src/types.js";

const base = {
  id: "w1",
  skillId: "skill.a",
  enabled: true,
  strategy: "http-poll",
  endpoint: "https://api.github.com/events",
  match: "all",
  conditions: [{ path: "a", op: "exists" }],
  fire: {
    webhookPath: "/internal/sentinel",
    eventName: "x",
    payloadTemplate: { a: "${payload.a}" },
  },
  retry: { maxRetries: 3, baseMs: 100, maxMs: 2000 },
};

describe("validator", () => {
  it("accepts valid watcher", () => {
    expect(validateWatcherDefinition(base).id).toBe("w1");
  });
  it("applies default webhook path when omitted", () => {
    const watcher = validateWatcherDefinition({
      ...base,
      fire: {
        ...base.fire,
        webhookPath: undefined,
      },
    });
    expect(watcher.fire.webhookPath).toBe(DEFAULT_SENTINEL_WEBHOOK_PATH);
  });
  it("preserves explicit webhook path override", () => {
    const watcher = validateWatcherDefinition(base);
    expect(watcher.fire.webhookPath).toBe("/internal/sentinel");
  });
  it("accepts generic callback fields", () => {
    const watcher = validateWatcherDefinition({
      ...base,
      fire: {
        ...base.fire,
        intent: "incident_triage",
        contextTemplate: {
          summary: "${payload.a}",
          details: { previous: "${watcher.id}", next: ["${event.name}"] },
        },
        priority: "high",
        deadlineTemplate: "${timestamp}",
        notificationPayloadMode: "debug",
      },
    });
    expect(watcher.fire.intent).toBe("incident_triage");
    expect(watcher.fire.priority).toBe("high");
    expect(watcher.fire.notificationPayloadMode).toBe("debug");
  });

  it("accepts none notification payload mode override", () => {
    const watcher = validateWatcherDefinition({
      ...base,
      fire: {
        ...base.fire,
        notificationPayloadMode: "none",
      },
    });
    expect(watcher.fire.notificationPayloadMode).toBe("none");
  });

  it("rejects watcher ids with invalid characters", () => {
    expect(() => validateWatcherDefinition({ ...base, id: "../../etc/passwd" })).toThrow(
      /Invalid watcher definition/,
    );
  });

  it("rejects watcher ids that exceed 128 characters", () => {
    expect(() => validateWatcherDefinition({ ...base, id: "a".repeat(129) })).toThrow(
      /Invalid watcher definition/,
    );
  });

  it("rejects unknown fields", () => {
    expect(() => validateWatcherDefinition({ ...base, rogue: true })).toThrow();
  });
  it("rejects code-like fields", () => {
    expect(() =>
      validateWatcherDefinition({ ...base, metadata: { handler: "function(){return 1;}" } }),
    ).toThrow();
  });

  describe("evm-call strategy", () => {
    const evmBase = {
      ...base,
      strategy: "evm-call",
      evmCall: {
        to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        signature: "function balanceOf(address) view returns (uint256)",
        args: ["0x0000000000000000000000000000000000000001"],
      },
    };

    it("accepts valid evm-call watcher", () => {
      const watcher = validateWatcherDefinition(evmBase);
      expect(watcher.strategy).toBe("evm-call");
      expect(watcher.evmCall?.to).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    });

    it("rejects evm-call without evmCall config", () => {
      const { evmCall, ...noEvmCall } = evmBase;
      expect(() => validateWatcherDefinition(noEvmCall)).toThrow(/requires evmCall/);
    });

    it("rejects evmCall on non-evm-call strategy", () => {
      expect(() =>
        validateWatcherDefinition({
          ...base,
          strategy: "http-poll",
          evmCall: evmBase.evmCall,
        }),
      ).toThrow(/only valid with evm-call strategy/);
    });

    it("rejects invalid contract address", () => {
      expect(() =>
        validateWatcherDefinition({
          ...evmBase,
          evmCall: { ...evmBase.evmCall, to: "0xinvalid" },
        }),
      ).toThrow(/Invalid watcher definition/);
    });

    it("rejects method/body on evm-call strategy", () => {
      expect(() => validateWatcherDefinition({ ...evmBase, method: "POST" })).toThrow(
        /does not support method\/body/,
      );
      expect(() => validateWatcherDefinition({ ...evmBase, body: "{}" })).toThrow(
        /does not support method\/body/,
      );
    });

    it("allows ABI signature containing 'function' without code-like rejection", () => {
      const watcher = validateWatcherDefinition(evmBase);
      expect(watcher.evmCall?.signature).toBe("function balanceOf(address) view returns (uint256)");
    });

    it("still rejects 'function' in non-exempt fields", () => {
      expect(() =>
        validateWatcherDefinition({
          ...evmBase,
          metadata: { note: "function balanceOf(address)" },
        }),
      ).toThrow(/Code-like value rejected/);
    });
  });
});
