import { StrategyHandler } from './base.js';

export const httpLongPollStrategy: StrategyHandler = async (watcher, onPayload, onError) => {
  let active = true;

  const loop = async () => {
    while (active) {
      try {
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
      } catch (err) {
        await onError(err);
        return;
      }
    }
  };

  void loop();
  return async () => { active = false; };
};
