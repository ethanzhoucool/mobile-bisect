import { join } from 'node:path';
export interface ServeOptions {
    /** Run directory containing events.jsonl, or the .jsonl file itself. */
    runDir: string;
    port?: number;
    open?: boolean;
    allowRemoteMedia?: boolean;
}
export interface ServeHandle {
    url: string;
    close(): Promise<void>;
}
/** Serves the report at `/` and streams new events over SSE at `/events`. */
export declare function serve(opts: ServeOptions): Promise<ServeHandle>;
export { join as _join };
