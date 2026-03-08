import { AbiFunction } from "ox";
import { StrategyHandler } from "./base.js";

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message.toLowerCase().includes("aborted");
}

function normalizeBigInts(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeBigInts);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeBigInts(v);
    }
    return out;
  }
  return value;
}

function buildNamedResult(
  outputs: AbiFunction.AbiFunction["outputs"] | undefined,
  normalizedResult: unknown[],
): Record<string, unknown> {
  const named: Record<string, unknown> = {};
  if (!outputs?.length) return named;

  outputs.forEach((output, index) => {
    if (!output.name) return;
    named[output.name] = normalizedResult[index];
  });

  return named;
}

export const evmCallStrategy: StrategyHandler = async (watcher, onPayload, onError) => {
  const evmCall = watcher.evmCall;
  if (!evmCall) {
    await onError(new Error("evm-call strategy requires evmCall config"));
    return async () => {};
  }

  let abiFunction: AbiFunction.AbiFunction;
  let calldata: `0x${string}`;
  try {
    const parsed = AbiFunction.from(evmCall.signature);
    if (parsed.type !== "function") {
      throw new Error(`Expected function ABI, got ${parsed.type}`);
    }
    abiFunction = parsed as AbiFunction.AbiFunction;
    calldata = AbiFunction.encodeData(abiFunction, (evmCall.args ?? []) as never);
  } catch (err) {
    await onError(
      new Error(`evm-call ABI encoding failed: ${String((err as Error)?.message ?? err)}`),
    );
    return async () => {};
  }

  const blockTag = evmCall.blockTag ?? "latest";
  const interval = watcher.intervalMs ?? 30000;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlightAbort: AbortController | undefined;

  const tick = async () => {
    if (!active) return;

    try {
      inFlightAbort = new AbortController();

      const rpcBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: evmCall.to, data: calldata }, blockTag],
      });

      const response = await fetch(watcher.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...watcher.headers,
        },
        body: rpcBody,
        signal: AbortSignal.any([
          inFlightAbort.signal,
          AbortSignal.timeout(watcher.timeoutMs ?? 15000),
        ]),
        redirect: "error",
      });

      if (!response.ok) throw new Error(`evm-call non-2xx: ${response.status}`);

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("json")) {
        throw new Error(`evm-call expected JSON, got: ${contentType || "unknown"}`);
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        throw new Error(
          `evm-call invalid JSON response: ${String((err as Error)?.message ?? err)}`,
        );
      }

      const rpcResponse = json as Record<string, unknown>;
      if (rpcResponse.error) {
        const rpcError = rpcResponse.error as Record<string, unknown>;
        throw new Error(
          `evm-call JSON-RPC error: ${rpcError.message ?? JSON.stringify(rpcResponse.error)}`,
        );
      }

      const raw = rpcResponse.result;
      if (typeof raw !== "string") {
        throw new Error("evm-call: missing or non-string result in JSON-RPC response");
      }

      const decoded = AbiFunction.decodeResult(abiFunction, raw as `0x${string}`);
      const normalizedResult = Array.isArray(decoded)
        ? (normalizeBigInts(decoded) as unknown[])
        : [normalizeBigInts(decoded)];
      const resultNamed = buildNamedResult(abiFunction.outputs, normalizedResult);

      await onPayload({
        result: normalizedResult,
        resultNamed,
        raw,
        blockTag,
        to: evmCall.to,
        signature: evmCall.signature,
      });
    } catch (err) {
      if (!active && isAbortError(err)) return;
      await onError(err);
      return;
    } finally {
      inFlightAbort = undefined;
    }

    if (active) {
      timer = setTimeout(() => {
        void tick();
      }, interval);
    }
  };

  void tick();

  return async () => {
    active = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    inFlightAbort?.abort();
    inFlightAbort = undefined;
  };
};
