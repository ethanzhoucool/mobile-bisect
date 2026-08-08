import type { BisectEvent } from '@expo-bisect/core';

/** Anything that can watch a run: the live view, plain logs, the SSE server. */
export interface EventSink {
  handle(e: BisectEvent): void;
  /** A one-off line that is not part of the event stream (notices, warnings). */
  note?(text: string): void;
  close?(): Promise<void> | void;
}

export function fanout(sinks: EventSink[]): Required<Pick<EventSink, 'handle' | 'note'>> & {
  close(): Promise<void>;
} {
  return {
    handle(e: BisectEvent) {
      for (const s of sinks) s.handle(e);
    },
    note(text: string) {
      for (const s of sinks) s.note?.(text);
    },
    async close() {
      for (const s of sinks) await s.close?.();
    },
  };
}
