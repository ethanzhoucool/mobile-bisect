/**
 * A `FrameworkAdapter` that prepares nothing.
 *
 * `--dry-run` pairs it with `FakeRunner` so the whole search, rounds, retries,
 * skips, the report, runs offline with no toolchain installed. It also stands
 * in for the real adapters in the CLI's tests, where spawning `xcodebuild`
 * would be absurd.
 */

import type {
  AdapterDetection,
  CandidateKind,
  FrameworkAdapter,
  PrepareContext,
  PreparedCandidate,
} from './adapter.js';
import type { Platform } from './types.js';

export interface FakeAdapterOptions {
  name?: string;
  displayName?: string;
  /** Default `bundle`; set `binary` to exercise the upload-and-install path. */
  candidateKind?: CandidateKind;
  platforms?: Platform[];
  /** Commits that cannot be prepared, so the search has to skip them. */
  unpreparableShas?: string[];
  /** Wall-clock cost per prepare, for demo pacing. Default 0. */
  prepareDelayMs?: number;
}

export class FakeAdapter implements FrameworkAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly candidateKind: CandidateKind;

  private readonly platforms: Platform[];
  private readonly unpreparable: Set<string>;
  private readonly delayMs: number;
  /** Every candidate handed out, so tests can assert each one was disposed. */
  readonly prepared: PreparedCandidate[] = [];
  private disposeCount = 0;

  constructor(opts: FakeAdapterOptions = {}) {
    this.name = opts.name ?? 'fake';
    this.displayName = opts.displayName ?? 'Fake (dry run)';
    this.candidateKind = opts.candidateKind ?? 'bundle';
    this.platforms = opts.platforms ?? ['ios', 'android'];
    this.unpreparable = new Set(opts.unpreparableShas ?? []);
    this.delayMs = opts.prepareDelayMs ?? 0;
  }

  /** How many prepared candidates have been disposed. */
  get disposals(): number {
    return this.disposeCount;
  }

  async detect(): Promise<AdapterDetection> {
    return { ok: true, confidence: 0, platforms: [...this.platforms], summary: 'simulated project' };
  }

  async prepare(sha: string, worktreePath: string, ctx: PrepareContext): Promise<PreparedCandidate> {
    if (this.unpreparable.has(sha)) {
      throw new Error(`simulated preparation failure for ${sha.slice(0, 7)}`);
    }
    const started = Date.now();
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    ctx.onLog?.(`[${sha.slice(0, 7)}] prepared (fake)`);

    const candidate: PreparedCandidate = {
      kind: this.candidateKind,
      sha,
      worktreePath,
      platform: ctx.platform,
      ...(this.candidateKind === 'bundle'
        ? { bundleUrl: `http://127.0.0.1:8081/${sha}` }
        : { appPath: `${worktreePath}/build/${sha}.app.zip` }),
      durationMs: Date.now() - started,
      dispose: async () => {
        this.disposeCount++;
      },
    };
    this.prepared.push(candidate);
    return candidate;
  }
}
