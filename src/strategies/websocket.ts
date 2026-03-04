import WebSocket from "ws";
import { StrategyHandler } from "./base.js";

export const websocketStrategy: StrategyHandler = async (
  watcher,
  onPayload,
  onError,
  callbacks,
) => {
  let active = true;
  let ws: WebSocket | null = null;

  const connect = () => {
    let pendingError: Error | null = null;
    let failureReported = false;

    ws = new WebSocket(watcher.endpoint, { headers: watcher.headers });

    ws.on("open", () => {
      if (!active) return;
      callbacks?.onConnect?.();
    });

    ws.on("message", async (data) => {
      if (!active) return;
      const text = data.toString();
      try {
        await onPayload(JSON.parse(text));
      } catch {
        await onPayload({ message: text });
      }
    });

    ws.on("error", (err) => {
      if (!active) return;
      pendingError = err instanceof Error ? err : new Error(String(err));
    });

    ws.on("close", (code) => {
      if (!active || failureReported) return;
      failureReported = true;
      const reason = pendingError?.message ?? `websocket closed: ${code}`;
      void onError(new Error(reason));
    });
  };

  connect();

  return async () => {
    active = false;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  };
};
