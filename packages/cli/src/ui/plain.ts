/**
 * Line-per-event output: the fallback when stdout is not a TTY, when NO_COLOR
 * is set, or when the user asked for --no-ui. Also what CI reads.
 */

import pc from 'picocolors';
import type { BisectEvent, CommitSummary } from '@mobile-bisect/core';
import type { EventSink } from './sink.js';

type Write = (text: string) => void;

const defaultWrite: Write = (text) => process.stdout.write(text);

function clock(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toISOString().slice(11, 19);
}

export class PlainSink implements EventSink {
  private readonly write: Write;
  private commits = new Map<string, CommitSummary>();

  constructor(opts: { write?: Write } = {}) {
    this.write = opts.write ?? defaultWrite;
  }

  private line(at: string, tag: string, text: string): void {
    this.write(`${pc.dim(`[${clock(at)}]`)} ${tag.padEnd(8)} ${text}\n`);
  }

  note(text: string): void {
    this.write(`${text}\n`);
  }

  handle(e: BisectEvent): void {
    switch (e.type) {
      case 'search.started': {
        for (const c of e.commits) this.commits.set(c.sha, c);
        this.line(
          e.at,
          'search',
          `${e.meta.totalCommits} commits from ${e.meta.goodRef} to ${e.meta.badRef} · flow ${e.meta.flowName} · ${e.meta.plannedRounds} rounds planned`,
        );
        this.line(e.at, 'expect', `"${e.meta.expect}"`);
        break;
      }
      case 'round.started':
        this.line(
          e.at,
          'round',
          `${e.round} · range ${e.activeRange[0]}..${e.activeRange[1]} · candidate ${short(e.candidateSha)}`,
        );
        break;
      case 'commit.running':
        this.line(
          e.at,
          'run',
          `${short(e.sha)}  ${this.commits.get(e.sha)?.subject ?? ''}`.trimEnd(),
        );
        break;
      case 'flow.step':
        this.line(e.at, 'step', `${e.index}/${e.total}  ${e.label}`);
        break;
      case 'commit.completed': {
        const r = e.result;
        const secs = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '';
        const attempt = r.attempt && r.attempt > 1 ? ` (attempt ${r.attempt})` : '';
        this.line(e.at, r.state, `${short(r.sha)}  ${secs}${attempt}  ${r.reason ?? ''}`.trimEnd());
        break;
      }
      case 'range.narrowed':
        this.line(
          e.at,
          'narrow',
          `${e.remaining} candidate${e.remaining === 1 ? '' : 's'} left · range ${e.activeRange[0]}..${e.activeRange[1]}`,
        );
        break;
      case 'culprit.found': {
        const bad = this.commits.get(e.badSha);
        this.line(
          e.at,
          'culprit',
          `${short(e.badSha)}  ${bad?.subject ?? ''}${bad?.author ? ` · ${bad.author}` : ''}`.trimEnd(),
        );
        this.line(e.at, '', `last good ${short(e.goodSha)} → first bad ${short(e.badSha)}`);
        if (e.diagnosis) this.line(e.at, '', e.diagnosis);
        break;
      }
      case 'report.ready':
        this.line(e.at, 'report', e.reportPath);
        break;
      case 'search.failed':
        this.line(e.at, 'failed', e.message);
        break;
    }
  }
}

/** Machine mode: the event stream verbatim, one JSON object per line. */
export class JsonSink implements EventSink {
  private readonly write: Write;

  constructor(opts: { write?: Write } = {}) {
    this.write = opts.write ?? defaultWrite;
  }

  handle(e: BisectEvent): void {
    this.write(`${JSON.stringify(e)}\n`);
  }
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
