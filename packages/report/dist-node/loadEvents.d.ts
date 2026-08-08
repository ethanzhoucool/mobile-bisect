export interface RunPaths {
    /** Directory artifacts are resolved against. */
    runDir: string;
    eventsPath: string;
}
/** Accepts a run directory or a path straight to an events .jsonl (handy for fixtures). */
export declare function resolveRun(runDirOrFile: string): Promise<RunPaths>;
export declare function parseLines(text: string): unknown[];
export declare function readEvents(eventsPath: string): Promise<unknown[]>;
