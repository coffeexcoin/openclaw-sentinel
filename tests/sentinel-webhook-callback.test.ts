import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createSentinelPlugin } from "../src/index.js";

type MockRes = {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

function makeReq(method: string, body?: string) {
  const req = new PassThrough() as PassThrough & { method: string };
  req.method = method;
  if (body !== undefined) req.end(body);
  else req.end();
  return req;
}

function makeRes(): MockRes {
  return {
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

describe("sentinel webhook callback route", () => {
  it("enqueues a system event and requests heartbeat on POST", async () => {
    const registerHttpRoute = vi.fn();
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();

    const plugin = createSentinelPlugin({ hookSessionKey: "agent:main:main" });
    plugin.register({
      registerTool: vi.fn(),
      registerHttpRoute,
      runtime: { system: { enqueueSystemEvent, requestHeartbeatNow } },
      logger: { info: vi.fn(), error: vi.fn() },
    } as any);

    const route = registerHttpRoute.mock.calls[0][0];
    const req = makeReq(
      "POST",
      JSON.stringify({
        text: "price moved > 5%",
        watcherId: "btc-price",
        eventName: "price_alert",
      }),
    );
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(enqueueSystemEvent).toHaveBeenCalledWith("price moved > 5%", {
      sessionKey: "agent:main:main",
    });
    expect(requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "hook:sentinel",
      sessionKey: "agent:main:main",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "{}").ok).toBe(true);
  });

  it("returns 400 for invalid json payloads", async () => {
    const registerHttpRoute = vi.fn();
    const enqueueSystemEvent = vi.fn(() => true);

    const plugin = createSentinelPlugin();
    plugin.register({
      registerTool: vi.fn(),
      registerHttpRoute,
      runtime: { system: { enqueueSystemEvent, requestHeartbeatNow: vi.fn() } },
      logger: { info: vi.fn(), error: vi.fn() },
    } as any);

    const route = registerHttpRoute.mock.calls[0][0];
    const req = makeReq("POST", "not json");
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(res.statusCode).toBe(400);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("returns 500 when loop callback wiring fails", async () => {
    const registerHttpRoute = vi.fn();

    const plugin = createSentinelPlugin();
    plugin.register({
      registerTool: vi.fn(),
      registerHttpRoute,
      runtime: {
        system: {
          enqueueSystemEvent: vi.fn(() => {
            throw new Error("enqueue failed");
          }),
          requestHeartbeatNow: vi.fn(),
        },
      },
      logger: { info: vi.fn(), error: vi.fn() },
    } as any);

    const route = registerHttpRoute.mock.calls[0][0];
    const req = makeReq("POST", JSON.stringify({ eventName: "x" }));
    const res = makeRes();

    await route.handler(req as any, res as any);

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toContain("enqueue failed");
  });
});
