import { StrategyHandler } from './base.js';

export const httpPollStrategy: StrategyHandler = async (watcher, onPayload) => {
  const interval = watcher.intervalMs ?? 30000;
  let active = true;

  const loop = async () => {
    while (active) {
      const response = await fetch(watcher.endpoint, {
        method: watcher.method ?? 'GET',
        headers: watcher.headers,
        body: watcher.body,
        signal: AbortSignal.timeout(watcher.timeoutMs ?? 15000)
      });
      if (!response.ok) throw new Error(`http-poll non-2xx: ${response.status}`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('json')) throw new Error(`http-poll expected JSON, got: ${contentType || 'unknown'}`);
      const payload = await response.json();
      await onPayload(payload);
      await new Promise((r) => setTimeout(r, interval));
    }
  };

  await loop();
  return async () => { active = false; };
};
