import { transport, type BridgeEvent } from "./transport";

export type UnlistenFn = () => void;
export type Event<T> = BridgeEvent<T>;

export function listen<T>(
  event: string,
  handler: (event: BridgeEvent<T>) => void,
): Promise<UnlistenFn> {
  return transport.listen<T>(event, handler);
}

export function emit(event: string, payload?: unknown): Promise<void> {
  return transport.emit(event, payload);
}
