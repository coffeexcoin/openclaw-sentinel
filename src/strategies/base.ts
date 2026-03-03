import { WatcherDefinition } from '../types.js';

export type StrategyHandler = (
  watcher: WatcherDefinition,
  onPayload: (payload: unknown) => Promise<void>,
  onError: (error: unknown) => Promise<void>
) => Promise<() => void>;
