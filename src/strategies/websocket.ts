import WebSocket from 'ws';
import { StrategyHandler } from './base.js';

export const websocketStrategy: StrategyHandler = async (watcher, onPayload, onError) => {
  let active = true;
  let ws: WebSocket | null = null;

  const connect = () => {
    ws = new WebSocket(watcher.endpoint, { headers: watcher.headers });

    ws.on('message', async (data) => {
      if (!active) return;
      const text = data.toString();
      try {
        await onPayload(JSON.parse(text));
      } catch {
        await onPayload({ message: text });
      }
    });

    ws.on('error', (err) => {
      if (!active) return;
      void onError(err);
    });

    ws.on('close', (code) => {
      if (!active) return;
      void onError(new Error(`websocket closed: ${code}`));
    });
  };

  connect();

  return async () => {
    active = false;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  };
};
