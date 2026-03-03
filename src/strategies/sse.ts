import { StrategyHandler } from './base.js';

export const sseStrategy: StrategyHandler = async (watcher, onPayload, onError) => {
  let active = true;

  const loop = async () => {
    while (active) {
      try {
        const response = await fetch(watcher.endpoint, {
          headers: { Accept: 'text/event-stream', ...(watcher.headers ?? {}) },
          signal: AbortSignal.timeout(watcher.timeoutMs ?? 60000)
        });
        if (!response.ok) throw new Error(`sse non-2xx: ${response.status}`);
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().includes('text/event-stream')) throw new Error(`sse expected text/event-stream, got: ${contentType || 'unknown'}`);
        const text = await response.text();
        for (const line of text.split('\n')) {
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              await onPayload(JSON.parse(raw));
            } catch {
              await onPayload({ message: raw });
            }
          }
        }
        await new Promise((r) => setTimeout(r, watcher.intervalMs ?? 1000));
      } catch (err) {
        await onError(err);
        return;
      }
    }
  };

  void loop();
  return async () => { active = false; };
};
