import { StrategyHandler } from './base.js';

export const httpLongPollStrategy: StrategyHandler = async (watcher, onPayload) => {
  let active = true;

  const loop = async () => {
    while (active) {
      const response = await fetch(watcher.endpoint, {
        method: watcher.method ?? 'GET',
        headers: watcher.headers,
        body: watcher.body,
        signal: AbortSignal.timeout(watcher.timeoutMs ?? 60000)
      });
      if (!response.ok) throw new Error(`http-long-poll non-2xx: ${response.status}`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('json')) throw new Error(`http-long-poll expected JSON, got: ${contentType || 'unknown'}`);
      await onPayload(await response.json());
    }
  };

  await loop();
  return async () => { active = false; };
};
