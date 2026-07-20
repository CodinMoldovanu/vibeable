import { EventEmitter } from "node:events";

export interface RunEvent {
  id: number;
  runId: string;
  sequence: number;
  type: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(500);

export function publishRunEvent(event: RunEvent) {
  emitter.emit(event.runId, event);
}

export function subscribeToRun(runId: string, listener: (event: RunEvent) => void) {
  emitter.on(runId, listener);
  return () => emitter.off(runId, listener);
}
