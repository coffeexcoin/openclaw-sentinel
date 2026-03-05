import { describe, expect, it, vi, beforeEach } from "vitest";
import { evmCallStrategy } from "../src/strategies/evmCall.js";
import { WatcherDefinition } from "../src/types.js";

const baseWatcher: WatcherDefinition = {
  id: "evm-test",
  skillId: "skill.test",
  enabled: true,
  strategy: "evm-call",
  endpoint: "https://rpc.example.com",
  match: "all",
  conditions: [{ path: "result.0", op: "gt", value: "0" }],
  fire: {
    eventName: "balance_changed",
    payloadTemplate: { balance: "${payload.result.0}" },
  },
  retry: { maxRetries: 3, baseMs: 100, maxMs: 2000 },
  evmCall: {
    to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    signature: "function balanceOf(address) view returns (uint256)",
    args: ["0x0000000000000000000000000000000000000001"],
  },
};

function mockFetchResponse(result: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ jsonrpc: "2.0", id: 1, result }),
  };
}

function mockFetchRpcError(message: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({
      jsonrpc: "2.0",
      id: 1,
      error: { code: 3, message },
    }),
  };
}

describe("evmCallStrategy", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("decodes uint256 return value and calls onPayload", async () => {
    const balanceHex = "0x00000000000000000000000000000000000000000000000000000000499602d2";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockFetchResponse(balanceHex)) as any;

    const onPayload = vi.fn();
    const onError = vi.fn();

    const stop = await evmCallStrategy({ ...baseWatcher, intervalMs: 999999 }, onPayload, onError);

    await vi.waitFor(() => expect(onPayload).toHaveBeenCalledTimes(1));
    await stop();

    const payload = onPayload.mock.calls[0][0];
    expect(payload.result).toEqual(["1234567890"]);
    expect(payload.raw).toBe(balanceHex);
    expect(payload.blockTag).toBe("latest");
    expect(payload.to).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(payload.signature).toBe("function balanceOf(address) view returns (uint256)");
    expect(onError).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it("decodes multiple return values", async () => {
    const watcher: WatcherDefinition = {
      ...baseWatcher,
      intervalMs: 999999,
      evmCall: {
        to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        signature: "function getReserves() view returns (uint112, uint112, uint32)",
        args: [],
      },
    };

    const hex =
      "0x" +
      "0000000000000000000000000000000000000000000000000000000000000064" +
      "00000000000000000000000000000000000000000000000000000000000000c8" +
      "00000000000000000000000000000000000000000000000000000000000003e8";

    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockFetchResponse(hex)) as any;

    const onPayload = vi.fn();
    const stop = await evmCallStrategy(watcher, onPayload, vi.fn());

    await vi.waitFor(() => expect(onPayload).toHaveBeenCalledTimes(1));
    await stop();

    const payload = onPayload.mock.calls[0][0];
    expect(payload.result).toEqual(["100", "200", 1000]);
    expect(payload.result).toHaveLength(3);

    globalThis.fetch = originalFetch;
  });

  it("decodes tuple/struct return values with BigInt conversion", async () => {
    const watcher: WatcherDefinition = {
      ...baseWatcher,
      intervalMs: 999999,
      evmCall: {
        to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        signature: "function getPool() view returns ((address token0, address token1, uint24 fee))",
        args: [],
      },
    };

    const hex =
      "0x" +
      "000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" +
      "000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" +
      "00000000000000000000000000000000000000000000000000000000000001f4";

    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockFetchResponse(hex)) as any;

    const onPayload = vi.fn();
    const stop = await evmCallStrategy(watcher, onPayload, vi.fn());

    await vi.waitFor(() => expect(onPayload).toHaveBeenCalledTimes(1));
    await stop();

    const payload = onPayload.mock.calls[0][0];
    // Single tuple return → wrapped in array
    expect(payload.result).toHaveLength(1);
    // Inner struct has named keys
    expect(payload.result[0].token0).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(payload.result[0].token1).toBe("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
    expect(payload.result[0].fee).toBe(500);

    globalThis.fetch = originalFetch;
  });

  it("calls onError for invalid ABI signature", async () => {
    const watcher: WatcherDefinition = {
      ...baseWatcher,
      evmCall: {
        to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        signature: "not a valid abi signature",
      },
    };

    const onError = vi.fn();
    const stop = await evmCallStrategy(watcher, vi.fn(), onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toMatch(/ABI encoding failed/);
    await stop();
  });

  it("calls onError for JSON-RPC error (revert)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(mockFetchRpcError("execution reverted")) as any;

    const onError = vi.fn();
    const stop = await evmCallStrategy({ ...baseWatcher, intervalMs: 999999 }, vi.fn(), onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await stop();

    expect(onError.mock.calls[0][0].message).toMatch(/JSON-RPC error.*execution reverted/);

    globalThis.fetch = originalFetch;
  });

  it("calls onError for non-2xx HTTP response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ "content-type": "application/json" }),
    }) as any;

    const onError = vi.fn();
    const stop = await evmCallStrategy({ ...baseWatcher, intervalMs: 999999 }, vi.fn(), onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await stop();

    expect(onError.mock.calls[0][0].message).toMatch(/non-2xx: 429/);

    globalThis.fetch = originalFetch;
  });

  it("calls onError for non-JSON response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
    }) as any;

    const onError = vi.fn();
    const stop = await evmCallStrategy({ ...baseWatcher, intervalMs: 999999 }, vi.fn(), onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await stop();

    expect(onError.mock.calls[0][0].message).toMatch(/expected JSON/);

    globalThis.fetch = originalFetch;
  });

  it("calls onError for network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED")) as any;

    const onError = vi.fn();
    const stop = await evmCallStrategy({ ...baseWatcher, intervalMs: 999999 }, vi.fn(), onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await stop();

    expect(onError.mock.calls[0][0].message).toBe("ECONNREFUSED");

    globalThis.fetch = originalFetch;
  });

  it("does not call onError on abort during cleanup", async () => {
    let resolveInflight: (() => void) | undefined;
    globalThis.fetch = vi.fn().mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          resolveInflight = () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }),
    ) as any;

    const onError = vi.fn();
    const stop = await evmCallStrategy({ ...baseWatcher, intervalMs: 999999 }, vi.fn(), onError);

    // Give tick time to start
    await new Promise((r) => setTimeout(r, 10));
    await stop();
    resolveInflight?.();

    // Give time for any pending callbacks
    await new Promise((r) => setTimeout(r, 10));
    expect(onError).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it("sends redirect: 'error' in fetch options", async () => {
    const balanceHex = "0x00000000000000000000000000000000000000000000000000000000499602d2";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockFetchResponse(balanceHex)) as any;

    const onPayload = vi.fn();
    const stop = await evmCallStrategy({ ...baseWatcher, intervalMs: 999999 }, onPayload, vi.fn());

    await vi.waitFor(() => expect(onPayload).toHaveBeenCalledTimes(1));
    await stop();

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].redirect).toBe("error");

    globalThis.fetch = originalFetch;
  });

  it("merges custom headers with content-type", async () => {
    const balanceHex = "0x00000000000000000000000000000000000000000000000000000000499602d2";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockFetchResponse(balanceHex)) as any;

    const watcher: WatcherDefinition = {
      ...baseWatcher,
      intervalMs: 999999,
      headers: { Authorization: "Bearer test-token" },
    };

    const onPayload = vi.fn();
    const stop = await evmCallStrategy(watcher, onPayload, vi.fn());

    await vi.waitFor(() => expect(onPayload).toHaveBeenCalledTimes(1));
    await stop();

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].headers["content-type"]).toBe("application/json");
    expect(fetchCall[1].headers.Authorization).toBe("Bearer test-token");

    globalThis.fetch = originalFetch;
  });

  it("calls onError when evmCall config is missing", async () => {
    const watcher: WatcherDefinition = {
      ...baseWatcher,
      evmCall: undefined,
    };

    const onError = vi.fn();
    const stop = await evmCallStrategy(watcher, vi.fn(), onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toMatch(/requires evmCall config/);
    await stop();
  });

  it("preserves BigInt precision for values > Number.MAX_SAFE_INTEGER", async () => {
    // 2^64 = 18446744073709551616
    const bigHex = "0x0000000000000000000000000000000000000000000000010000000000000000";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockFetchResponse(bigHex)) as any;

    const onPayload = vi.fn();
    const stop = await evmCallStrategy({ ...baseWatcher, intervalMs: 999999 }, onPayload, vi.fn());

    await vi.waitFor(() => expect(onPayload).toHaveBeenCalledTimes(1));
    await stop();

    const payload = onPayload.mock.calls[0][0];
    expect(payload.result[0]).toBe("18446744073709551616");
    expect(typeof payload.result[0]).toBe("string");

    globalThis.fetch = originalFetch;
  });

  it("uses custom blockTag when provided", async () => {
    const balanceHex = "0x00000000000000000000000000000000000000000000000000000000499602d2";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockFetchResponse(balanceHex)) as any;

    const watcher: WatcherDefinition = {
      ...baseWatcher,
      intervalMs: 999999,
      evmCall: {
        ...baseWatcher.evmCall!,
        blockTag: "0x1234",
      },
    };

    const onPayload = vi.fn();
    const stop = await evmCallStrategy(watcher, onPayload, vi.fn());

    await vi.waitFor(() => expect(onPayload).toHaveBeenCalledTimes(1));
    await stop();

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.params[1]).toBe("0x1234");
    expect(onPayload.mock.calls[0][0].blockTag).toBe("0x1234");

    globalThis.fetch = originalFetch;
  });

  it("sends correct JSON-RPC body with eth_call", async () => {
    const balanceHex = "0x00000000000000000000000000000000000000000000000000000000499602d2";
    globalThis.fetch = vi.fn().mockResolvedValueOnce(mockFetchResponse(balanceHex)) as any;

    const onPayload = vi.fn();
    const stop = await evmCallStrategy({ ...baseWatcher, intervalMs: 999999 }, onPayload, vi.fn());

    await vi.waitFor(() => expect(onPayload).toHaveBeenCalledTimes(1));
    await stop();

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("eth_call");
    expect(body.params[0].to).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(body.params[0].data).toMatch(/^0x70a08231/); // balanceOf selector
    expect(body.params[1]).toBe("latest");

    globalThis.fetch = originalFetch;
  });
});
