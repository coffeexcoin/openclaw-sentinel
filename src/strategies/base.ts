import { WatcherDefinition } from "../types.js";

export interface StrategyCallbacks {
  onConnect?: () => void;
}

export type StrategyHandler = (
  watcher: WatcherDefinition,
  onPayload: (payload: unknown) => Promise<void>,
  onError: (error: unknown) => Promise<void>,
  callbacks?: StrategyCallbacks,
) => Promise<() => void>;
