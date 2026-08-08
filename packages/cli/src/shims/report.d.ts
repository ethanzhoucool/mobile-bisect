/** Compile-time shim for `@expo-bisect/report`. See src/shims/core.d.ts. */

export declare function serve(opts: {
  runDir: string;
  port?: number;
  open?: boolean;
}): Promise<{ url: string; close(): Promise<void> }>;

export declare function renderReport(opts: { runDir: string; outPath?: string }): Promise<string>;
