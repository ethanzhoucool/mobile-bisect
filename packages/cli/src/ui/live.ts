/**
 * The live terminal view.
 *
 * Plain ANSI, repainted in place: a header that mirrors the web command bar, a
 * commit rail with a bracket under the range still in play, whatever candidates
 * are on a device right now, and the culprit block at the end. This is what
 * people who never open the browser see — and what gets screen-recorded.
 */

import pc from 'picocolors';
import type {
  ActiveRange,
  BisectEvent,
  BisectMeta,
  CommitResult,
  CommitSummary,
} from '@expo-bisect/core';
import { bracketLine, collapse, RAIL_CHARS, type RailCellState } from './rail.js';
import type { EventSink } from './sink.js';

const PAINT_INTERVAL_MS = 250;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

interface ActiveCandidate {
  sha: string;
  startedAt: number;
  step?: { index: number; total: number; label: string };
}

const PAINTERS: Record<RailCellState, (s: string) => string> = {
  untested: (s) => pc.dim(s),
  running: (s) => pc.blue(s),
  good: (s) => pc.green(s),
  bad: (s) => pc.red(s),
  skipped: (s) => pc.yellow(s),
  culprit: (s) => pc.bold(pc.red(s)),
};

export class LiveSink implements EventSink {
  private readonly stream: NodeJS.WriteStream;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private painted = 0;
  private closed = false;

  private meta?: BisectMeta;
  private commits: CommitSummary[] = [];
  private indexBySha = new Map<string, number>();
  private cells: RailCellState[] = [];
  private activeRange: ActiveRange = [0, 0];
  private round = 0;
  private remaining?: number;
  private active = new Map<string, ActiveCandidate>();
  private lastResult?: CommitResult;
  private culprit?: { goodSha: string; badSha: string; diagnosis?: string };
  private reportPath?: string;
  private failure?: string;

  constructor(opts: { stream?: NodeJS.WriteStream; now?: () => number } = {}) {
    this.stream = opts.stream ?? process.stdout;
    this.now = opts.now ?? Date.now;
  }

  handle(e: BisectEvent): void {
    switch (e.type) {
      case 'search.started': {
        this.meta = e.meta;
        this.commits = e.commits;
        this.indexBySha = new Map(e.commits.map((c, i) => [c.sha, i]));
        this.cells = e.commits.map(() => 'untested' as RailCellState);
        // The boundaries are known by definition — show them straight away.
        if (this.cells.length > 0) this.cells[0] = 'good';
        if (this.cells.length > 1) this.cells[this.cells.length - 1] = 'bad';
        this.activeRange = [1, Math.max(1, e.commits.length - 2)];
        this.start();
        break;
      }
      case 'round.started':
        this.round = e.round;
        this.activeRange = e.activeRange;
        break;
      case 'commit.running': {
        this.setCell(e.sha, 'running');
        this.active.set(e.sha, { sha: e.sha, startedAt: this.now() });
        break;
      }
      case 'flow.step': {
        const c = this.active.get(e.sha);
        if (c) c.step = { index: e.index, total: e.total, label: e.label };
        break;
      }
      case 'commit.completed': {
        this.active.delete(e.result.sha);
        this.lastResult = e.result;
        this.setCell(e.result.sha, cellFor(e.result.state));
        break;
      }
      case 'range.narrowed':
        this.activeRange = e.activeRange;
        this.remaining = e.remaining;
        break;
      case 'culprit.found':
        this.culprit = { goodSha: e.goodSha, badSha: e.badSha, diagnosis: e.diagnosis };
        this.setCell(e.badSha, 'culprit');
        this.setCell(e.goodSha, 'good');
        break;
      case 'report.ready':
        this.reportPath = e.reportPath;
        break;
      case 'search.failed':
        this.failure = e.message;
        break;
    }
    this.paint();
  }

  note(text: string): void {
    this.clear();
    this.stream.write(`${text}\n`);
    this.paint();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.repaintFinal();
    this.stream.write(SHOW_CURSOR);
  }

  // --- internals -----------------------------------------------------------

  private start(): void {
    if (this.timer || this.closed) return;
    this.stream.write(HIDE_CURSOR);
    // The clock in the candidate line has to keep moving between events.
    this.timer = setInterval(() => this.paint(), PAINT_INTERVAL_MS);
    this.timer.unref?.();
  }

  private setCell(sha: string, state: RailCellState): void {
    const i = this.indexBySha.get(sha);
    if (i !== undefined) this.cells[i] = state;
  }

  private clear(): void {
    if (this.painted > 0) {
      this.stream.write(`\x1b[${this.painted}A\x1b[0J`);
      this.painted = 0;
    }
  }

  private paint(): void {
    if (this.closed) return;
    const lines = this.render();
    this.clear();
    this.stream.write(`${lines.join('\n')}\n`);
    this.painted = lines.length;
  }

  private repaintFinal(): void {
    const lines = this.render();
    if (this.painted > 0) {
      this.stream.write(`\x1b[${this.painted}A\x1b[0J`);
      this.painted = 0;
    }
    this.stream.write(`${lines.join('\n')}\n`);
  }

  private get width(): number {
    return Math.max(48, Math.min(this.stream.columns ?? 80, 160));
  }

  private render(): string[] {
    const width = this.width;
    const inner = width - 4;
    const out: string[] = [''];

    if (this.meta) {
      const m = this.meta;
      out.push(
        `  ${pc.bold('expo-bisect')}  ${pc.cyan(m.goodRef)} ${pc.dim('→')} ${pc.cyan(m.badRef)}  ` +
          pc.dim(
            `${m.flowName} · ${m.totalCommits} commits · ${m.plannedRounds} rounds · ${m.runId}`,
          ),
      );
      out.push(`  ${pc.dim('expect')}  ${truncate(`"${m.expect}"`, inner - 9)}`);
    } else {
      out.push(`  ${pc.bold('expo-bisect')}  ${pc.dim('starting…')}`);
      out.push('');
    }

    out.push('');
    out.push(...this.renderRail(inner));
    out.push('');
    out.push(...this.renderActive(inner));

    if (this.culprit || this.failure) {
      out.push('');
      out.push(...this.renderOutcome(inner));
    }
    out.push('');
    return out;
  }

  private renderRail(inner: number): string[] {
    if (this.cells.length === 0) return ['', ''];
    const cells = collapse(this.cells, inner);
    const rail = cells.map((c) => PAINTERS[c](RAIL_CHARS[c])).join('');

    const bracket = bracketLine(this.activeRange, this.cells.length, inner);
    const status = this.culprit
      ? ''
      : this.remaining !== undefined
        ? `round ${this.round}${this.meta ? `/${this.meta.plannedRounds}` : ''} · ${this.remaining} left`
        : this.round > 0
          ? `round ${this.round}${this.meta ? `/${this.meta.plannedRounds}` : ''}`
          : '';

    const fits = status.length > 0 && bracket.length + status.length + 3 <= inner;
    const lines = [
      `  ${rail}`,
      fits ? `  ${pc.dim(`${bracket}  ${status}`)}` : `  ${pc.dim(bracket)}`,
    ];
    if (status.length > 0 && !fits) lines.push(`  ${pc.dim(status)}`);
    return lines;
  }

  private renderActive(inner: number): string[] {
    const out: string[] = [];

    for (const candidate of this.active.values()) {
      const commit = this.commits[this.indexBySha.get(candidate.sha) ?? -1];
      const subject = commit?.subject ?? '';
      out.push(
        `  ${pc.blue('→')} ${pc.bold(candidate.sha.slice(0, 7))}  ${truncate(subject, inner - 12)}`,
      );

      const elapsed = formatElapsed(this.now() - candidate.startedAt);
      const step = candidate.step;
      const left = step
        ? `    ${pc.dim(`step ${step.index}/${step.total}`)}  ${truncate(step.label, inner - 24)}`
        : `    ${pc.dim('starting the device session…')}`;
      out.push(padRight(left, inner + 2, pc.dim(elapsed), elapsed.length));
    }

    // The block keeps a stable height so repaints don't jitter.
    if (this.culprit || this.failure) return [];

    if (this.active.size === 0) {
      out.push(`  ${pc.dim('preparing the next candidate…')}`);
      out.push('');
    }

    const r = this.lastResult;
    if (r) {
      const mark = PAINTERS[cellFor(r.state)](RAIL_CHARS[cellFor(r.state)]);
      const secs = r.durationMs ? ` ${(r.durationMs / 1000).toFixed(1)}s` : '';
      out.push(
        `  ${mark} ${pc.dim(`${r.sha.slice(0, 7)} ${r.state}${secs}`)}  ${pc.dim(truncate(r.reason ?? '', inner - 28))}`,
      );
    } else {
      out.push('');
    }
    return out;
  }

  private renderOutcome(inner: number): string[] {
    const out: string[] = [];
    if (this.failure && !this.culprit) {
      out.push(`  ${pc.red('✗')} ${pc.bold('search stopped')}  ${truncate(this.failure, inner - 20)}`);
    }

    if (this.culprit) {
      const bad = this.commits[this.indexBySha.get(this.culprit.badSha) ?? -1];
      out.push(
        `  ${pc.bold(pc.red('◉ culprit'))}  ${pc.bold(this.culprit.badSha.slice(0, 7))}  ` +
          `${truncate(bad?.subject ?? '', inner - 30)}${bad?.author ? pc.dim(`  ${bad.author}`) : ''}`,
      );
      out.push(
        `    ${pc.dim('last good')} ${pc.green(this.culprit.goodSha.slice(0, 7))}  ${pc.dim('first bad')} ${pc.red(this.culprit.badSha.slice(0, 7))}`,
      );
      if (this.culprit.diagnosis) {
        out.push('');
        for (const line of wrap(this.culprit.diagnosis, inner - 4)) out.push(`    ${line}`);
      }
    }

    if (this.reportPath) {
      out.push('');
      out.push(`    ${pc.dim('report')}  ${pc.cyan(this.reportPath)}`);
    }
    return out;
  }
}

function cellFor(state: CommitResult['state']): RailCellState {
  switch (state) {
    case 'good':
      return 'good';
    case 'bad':
      return 'bad';
    case 'skipped':
    case 'inconclusive':
      return 'skipped';
    case 'running':
      return 'running';
    default:
      return 'untested';
  }
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

/** Right-align `right` at `width`, given the visible length of `left`'s text. */
function padRight(left: string, width: number, right: string, rightLen: number): string {
  const leftLen = visibleLength(left);
  const gap = Math.max(1, width - leftLen - rightLen);
  return `${left}${' '.repeat(gap)}${right}`;
}

const ANSI = /\x1b\[[0-9;]*m/g;

export function visibleLength(text: string): number {
  return text.replace(ANSI, '').length;
}

export function truncate(text: string, max: number): string {
  if (max <= 1) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}
