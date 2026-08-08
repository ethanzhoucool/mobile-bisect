/** The single-file app bundle both outputs are built from. */
export declare function templatePath(): string;
/** Safe to embed inside <script type="application/json">. */
export declare function inlineJson(value: unknown): string;
export interface RenderOptions {
    events: unknown[];
    config: Record<string, unknown>;
    /** originalUrl -> data: URI. Emitted once per asset, not once per reference. */
    frames?: Record<string, string>;
}
export declare function renderHtml({ events, config, frames }: RenderOptions): Promise<string>;
