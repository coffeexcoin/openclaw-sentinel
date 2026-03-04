import { describe, expect, it, vi } from "vitest";
import { createSentinelPlugin } from "../src/index.js";

describe("plugin init webhook registration", () => {
  it("registers default sentinel webhook route idempotently", async () => {
    const registerHttpRoute = vi.fn();

    const pluginA = createSentinelPlugin();
    pluginA.register({ registerTool: vi.fn(), registerHttpRoute });

    const pluginB = createSentinelPlugin();
    pluginB.register({ registerTool: vi.fn(), registerHttpRoute });

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute.mock.calls[0][0].path).toBe("/hooks/sentinel");

    const audit = await pluginB.manager.audit();
    expect((audit as any).webhookRegistration.status).toBe("ok");
  });

  it("surfaces registration failure in audit diagnostics", async () => {
    const registerHttpRoute = vi.fn(() => {
      throw new Error("route collision");
    });

    const plugin = createSentinelPlugin();
    plugin.register({ registerTool: vi.fn(), registerHttpRoute, logger: { error: vi.fn() } });

    const audit = await plugin.manager.audit();
    expect((audit as any).webhookRegistration.status).toBe("error");
    expect(String((audit as any).webhookRegistration.message)).toContain("route collision");
  });
});
