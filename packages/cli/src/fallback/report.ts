/**
 * Built-in fallback for `@mobile-bisect/report`, used when the sibling package is
 * unbuilt or absent. Zero dependencies, node builtins only: the event stream is
 * folded into a small view model and rendered as one self-contained HTML file,
 * which `serve` reuses as the live page (SSE tails events.jsonl).
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import * as path from 'node:path';

import type {
  ActiveRange,
  BisectEvent,
  BisectMeta,
  CommitResult,
  CommitState,
  CommitSummary,
} from '@mobile-bisect/core';

const DEFAULT_PORT = 4785;
const PORT_TRIES = 8;
const POLL_MS = 400;
const HEARTBEAT_MS = 15_000;

// ---------------------------------------------------------------------------
// Event stream -> view model
// ---------------------------------------------------------------------------

interface RoundView {
  round: number;
  range: ActiveRange;
  candidateSha: string;
  result?: CommitResult;
  remaining?: number;
}

interface View {
  meta?: BisectMeta;
  commits: CommitSummary[];
  results: Map<string, CommitResult>;
  rounds: RoundView[];
  culprit?: { goodSha: string; badSha: string; diagnosis?: string };
  failure?: string;
  eventCount: number;
}

function parseEvent(line: string): BisectEvent | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string') {
      return value as BisectEvent;
    }
  } catch {
    /* a trailing partial line while a run is in flight — ignore it */
  }
  return null;
}

function parseEvents(text: string): BisectEvent[] {
  const out: BisectEvent[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const ev = parseEvent(line);
    if (ev) out.push(ev);
  }
  return out;
}

function fold(events: BisectEvent[]): View {
  const view: View = { commits: [], results: new Map(), rounds: [], eventCount: events.length };
  for (const ev of events) {
    switch (ev.type) {
      case 'search.started':
        view.meta = ev.meta;
        view.commits = Array.isArray(ev.commits) ? ev.commits : [];
        break;
      case 'round.started':
        view.rounds.push({ round: ev.round, range: ev.activeRange, candidateSha: ev.candidateSha });
        break;
      case 'commit.completed': {
        view.results.set(ev.result.sha, ev.result);
        const open = [...view.rounds].reverse().find((r) => r.candidateSha === ev.result.sha && !r.result);
        if (open) open.result = ev.result;
        break;
      }
      case 'range.narrowed': {
        const round = view.rounds.find((r) => r.round === ev.round);
        if (round) round.remaining = ev.remaining;
        break;
      }
      case 'culprit.found':
        view.culprit = { goodSha: ev.goodSha, badSha: ev.badSha, diagnosis: ev.diagnosis };
        break;
      case 'search.failed':
        view.failure = ev.message;
        break;
      default:
        break;
    }
  }
  return view;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function duration(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const CELL_CLASS: Record<CommitState, string> = {
  good: 'good', bad: 'bad', skipped: 'skipped', inconclusive: 'skipped',
  running: 'running', scheduled: 'running', untested: 'untested',
};

function cellClass(state: CommitState, isCulprit: boolean): string {
  return isCulprit ? 'culprit' : (CELL_CLASS[state] ?? 'untested');
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const STYLE = `
:root{--bg:#fbfbf9;--fg:#1b1b19;--muted:#71716a;--line:#e5e5df;--card:#fff;
--good:#4a9c6d;--bad:#c34f3c;--skip:#c19a3a;--untested:#dcdcd5;--run:#3f7fb8;--culprit:#8c2c1c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:40px 24px 80px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
h1{font-size:19px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:36px 0 12px;font-weight:600}
p{margin:0 0 10px}
a{color:#22558a}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px 18px}
.cmd{white-space:pre-wrap;word-break:break-all;background:#f4f4f0;border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin:0 0 14px}
.facts{display:flex;flex-wrap:wrap;gap:6px 28px;color:var(--muted);font-size:13px}
.facts b{color:var(--fg);font-weight:600}
.rail{display:flex;flex-wrap:wrap;gap:3px;margin:0 0 12px}
.cell{width:14px;height:26px;border-radius:2px;background:var(--untested);display:block}
.cell.good{background:var(--good)}.cell.bad{background:var(--bad)}.cell.skipped{background:var(--skip)}
.cell.running{background:var(--run)}
.cell.culprit{background:var(--culprit);box-shadow:0 0 0 2px var(--bg),0 0 0 3px var(--culprit)}
.legend{display:flex;flex-wrap:wrap;gap:16px;color:var(--muted);font-size:12px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:10px;height:10px;border-radius:2px;display:inline-block;background:var(--untested)}
.sw.good{background:var(--good)}.sw.bad{background:var(--bad)}.sw.skipped{background:var(--skip)}.sw.culprit{background:var(--culprit)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:0 10px 8px 0;border-bottom:1px solid var(--line)}
td{padding:9px 10px 9px 0;border-bottom:1px solid var(--line);vertical-align:top}
td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:nowrap}
.v{font-weight:600}.v.good{color:var(--good)}.v.bad{color:var(--bad)}.v.skipped,.v.inconclusive{color:var(--skip)}
.verdict{border-left:3px solid var(--culprit)}
.verdict.incomplete{border-left-color:var(--skip)}
.sha{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
.pair{display:flex;flex-wrap:wrap;gap:10px 24px;margin:10px 0 0}
.pair div{min-width:220px}
.k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.note{color:var(--muted);font-size:13px}
ul.links{list-style:none;padding:0;margin:8px 0 0}
ul.links li{padding:3px 0}
.live{display:flex;flex-direction:column;gap:8px}
.track{height:4px;background:var(--line);border-radius:2px;overflow:hidden}
.track i{display:block;height:100%;width:0;background:var(--run);transition:width .25s ease}
footer{margin-top:44px;color:var(--muted);font-size:12px}
`;

const LIVE_JS = `
(function(){
  var tl=document.getElementById('tl');
  var rendered=tl?Number(tl.getAttribute('data-rounds')||0):0;
  var cur=null,reloading=false;
  function cell(sha){return document.querySelector('[data-sha="'+sha+'"]');}
  // Replaying a finished run must not repaint the culprit cell back to plain bad.
  function paint(sha,cls){var c=cell(sha);if(c&&c.className.indexOf('culprit')===-1)c.className='cell '+cls;}
  function status(t){var e=document.getElementById('livestatus');if(e)e.textContent=t;}
  function bar(p){var e=document.getElementById('livebar');if(e)e.style.width=p+'%';}
  function reload(){if(reloading)return;reloading=true;setTimeout(function(){location.reload();},300);}
  function td(t,c){var e=document.createElement('td');e.textContent=t;if(c)e.className=c;return e;}
  function addRow(r,res){
    var tr=document.createElement('tr');
    tr.appendChild(td(String(r.round)));
    tr.appendChild(td(r.activeRange[0]+'-'+r.activeRange[1],'mono'));
    tr.appendChild(td(res.sha.slice(0,7)+'  '+(res.subject||''),'mono'));
    tr.appendChild(td(res.state,'v '+res.state));
    tr.appendChild(td(res.reason||''));
    tr.appendChild(td(res.durationMs?Math.round(res.durationMs/1000)+'s':'','mono'));
    tl.appendChild(tr);
  }
  var es=new EventSource('/events');
  es.onmessage=function(m){
    var ev;try{ev=JSON.parse(m.data);}catch(e){return;}
    if(ev.type==='search.started'){if(!document.body.getAttribute('data-has-meta'))reload();return;}
    if(ev.type==='round.started'){
      cur=ev;paint(ev.candidateSha,'running');
      status('Round '+ev.round+' \\u00b7 candidate '+ev.candidateSha.slice(0,7)+' \\u00b7 range '+ev.activeRange[0]+'-'+ev.activeRange[1]);
      bar(0);return;
    }
    if(ev.type==='commit.running'){paint(ev.sha,'running');return;}
    if(ev.type==='flow.step'){status('Step '+ev.index+'/'+ev.total+' \\u00b7 '+ev.label);bar(Math.round(ev.index/ev.total*100));return;}
    if(ev.type==='commit.completed'){
      var res=ev.result;
      paint(res.sha,res.state==='inconclusive'?'skipped':res.state);
      if(tl&&cur&&cur.round>rendered){addRow(cur,res);rendered=cur.round;}
      bar(100);status('Completed '+res.sha.slice(0,7)+' \\u00b7 '+res.state);return;
    }
    // Terminal events fall back to a reload for the server-rendered verdict,
    // but only once: the replay of a finished run must not loop forever.
    if(ev.type==='culprit.found'||ev.type==='search.failed'){
      if(!document.body.getAttribute('data-done'))reload();
    }
  };
})();
`;

interface PageOpts {
  live: boolean;
  /** Maps a `localPaths` entry (relative to the run dir) to an href. */
  localHref: (p: string) => string;
}

function commandBar(view: View): string {
  const m = view.meta;
  if (!m) {
    return `<h1>mobile-bisect</h1><p class="facts">No <code>search.started</code> event yet — nothing to summarise.</p>`;
  }
  const facts: [string, string][] = [
    ['good', m.goodRef], ['bad', m.badRef], ['flow', m.flowName],
    ['commits', String(m.totalCommits || view.commits.length)],
    ['planned rounds', String(m.plannedRounds)], ['run', m.runId],
  ];
  return `<h1>mobile-bisect &mdash; ${esc(m.flowName)}</h1>
<p class="facts"><span>expect: <b>${esc(m.expect)}</b></span></p>
<div class="cmd mono">${esc(m.command)}</div>
<div class="facts">${facts.map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('')}</div>`;
}

function rail(view: View): string {
  if (!view.commits.length) return '';
  const badSha = view.culprit?.badSha;
  const counts = { good: 0, bad: 0, skipped: 0, untested: 0 };
  const cells = view.commits
    .map((c) => {
      const state = view.results.get(c.sha)?.state ?? 'untested';
      const cls = cellClass(state, c.sha === badSha);
      if (cls === 'good' || cls === 'bad' || cls === 'skipped') counts[cls] += 1;
      else if (cls === 'untested') counts.untested += 1;
      const title = `${c.shortSha} — ${c.subject} (${c.author})`;
      return `<i class="cell ${cls}" data-sha="${esc(c.sha)}" title="${esc(title)}"></i>`;
    })
    .join('');
  const legend: [string, string][] = [
    ['untested', `${counts.untested} untested`], ['good', `${counts.good} good`],
    ['bad', `${counts.bad} bad`], ['skipped', `${counts.skipped} skipped`],
    ['culprit', badSha ? `culprit ${short(badSha)}` : 'culprit'],
  ];
  return `<h2>Commit rail</h2><div class="rail">${cells}</div>
<div class="legend">${legend
    .map(([k, label]) => `<span><i class="sw ${esc(k)}"></i>${esc(label)}</span>`)
    .join('')}</div>`;
}

function timeline(view: View): string {
  const done = view.rounds.filter((r) => r.result).length;
  const rows = view.rounds
    .map((r) => {
      const res = r.result;
      const candidate = view.commits.find((c) => c.sha === r.candidateSha);
      const label = `${short(r.candidateSha)}  ${candidate?.subject ?? res?.subject ?? ''}`;
      return `<tr>
<td>${esc(r.round)}</td>
<td class="mono">${esc(r.range[0])}-${esc(r.range[1])}</td>
<td class="mono">${esc(label)}</td>
<td class="v ${esc(res?.state ?? 'running')}">${esc(res?.state ?? 'running')}</td>
<td>${esc(res?.reason ?? '')}</td>
<td class="mono">${esc(duration(res?.durationMs))}</td>
</tr>`;
    })
    .join('');
  if (!rows) return '';
  return `<h2>Rounds</h2><table>
<thead><tr><th>#</th><th>Range</th><th>Candidate</th><th>Verdict</th><th>Reason</th><th>Time</th></tr></thead>
<tbody id="tl" data-rounds="${done}">${rows}</tbody></table>`;
}

function artifacts(result: CommitResult | undefined, o: PageOpts): string {
  if (!result) return '';
  const links: string[] = [];
  if (result.videoUrl) links.push(`<li><a href="${esc(result.videoUrl)}">video</a></li>`);
  for (const [i, s] of (result.screenshots ?? []).entries()) {
    links.push(`<li><a href="${esc(s)}">screenshot ${i + 1}</a></li>`);
  }
  if (result.logsUrl) links.push(`<li><a href="${esc(result.logsUrl)}">logs</a></li>`);
  if (result.networkUrl) links.push(`<li><a href="${esc(result.networkUrl)}">network</a></li>`);
  for (const p of result.localPaths ?? []) {
    links.push(`<li><a href="${esc(o.localHref(p))}">${esc(p)}</a></li>`);
  }
  if (!links.length) return '';
  return `<h2>Artifacts &mdash; ${esc(short(result.sha))}</h2><ul class="links">${links.join('')}</ul>`;
}

function verdict(view: View, o: PageOpts): string {
  /** The rail is the only place a sha is guaranteed; results backfill a resumed run. */
  const who = (sha: string, label: string): string => {
    const c = view.commits.find((x) => x.sha === sha);
    const r = view.results.get(sha);
    return `<div><div class="k">${label}</div><div class="sha">${esc(short(sha))}</div>
<div>${esc(c?.subject ?? r?.subject ?? '')}</div><div class="k">${esc(c?.author ?? r?.author ?? '')}</div></div>`;
  };

  if (view.culprit) {
    const { goodSha, badSha, diagnosis } = view.culprit;
    const bad = view.results.get(badSha);
    return `<h2>Culprit</h2><div class="card verdict">
<div class="sha"><b>${esc(short(badSha))}</b> is the first bad commit &mdash; last good is ${esc(short(goodSha))}.</div>
<div class="pair">${who(badSha, 'first bad')}${who(goodSha, 'last good')}</div>
${diagnosis ? `<p style="margin-top:14px">${esc(diagnosis)}</p>` : ''}
${bad?.reason ? `<p class="note">${esc(bad.reason)}</p>` : ''}
</div>${artifacts(bad, o)}`;
  }

  const last = view.rounds[view.rounds.length - 1];
  const byState = (s: CommitState): CommitResult | undefined =>
    [...view.results.values()].filter((r) => r.state === s).pop();
  const good = byState('good');
  const bad = byState('bad');
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
  return `<h2>Search incomplete</h2><div class="card verdict incomplete">
${view.failure ? `<p><b>Search failed:</b> ${esc(view.failure)}</p>` : ''}
<p>${plural(view.rounds.length, 'round')} recorded, ${plural(view.results.size, 'commit')} classified. No culprit has been identified.</p>
${last ? `<p class="note">Active range ${esc(last.range[0])}-${esc(last.range[1])}, candidate ${esc(short(last.candidateSha))}.</p>` : ''}
${good ? `<p class="note">Newest known good: ${esc(short(good.sha))}</p>` : ''}
${bad ? `<p class="note">Oldest known bad: ${esc(short(bad.sha))}</p>` : ''}
</div>`;
}

function renderPage(view: View, o: PageOpts): string {
  const title = view.meta ? `mobile-bisect — ${view.meta.flowName}` : 'mobile-bisect';
  const livePanel =
    o.live && !view.culprit && !view.failure
      ? `<h2>Live</h2><div class="card live"><div id="livestatus" class="mono">waiting for events…</div><div class="track"><i id="livebar"></i></div></div>`
      : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body${view.meta ? ' data-has-meta="1"' : ''}${view.culprit || view.failure ? ' data-done="1"' : ''}>
<div class="wrap">
${commandBar(view)}
${livePanel}
${rail(view)}
${timeline(view)}
${verdict(view, o)}
<footer>${esc(view.eventCount)} events${view.meta ? ` · run ${esc(view.meta.runId)}` : ''} · rendered by the mobile-bisect built-in reporter</footer>
</div>
${o.live ? `<script>${LIVE_JS}</script>` : ''}
</body></html>
`;
}

// ---------------------------------------------------------------------------
// renderReport
// ---------------------------------------------------------------------------

async function readEvents(runDir: string): Promise<BisectEvent[]> {
  try {
    return parseEvents(await fsp.readFile(path.join(runDir, 'events.jsonl'), 'utf8'));
  } catch {
    return [];
  }
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

export async function renderReport(opts: { runDir: string; outPath?: string }): Promise<string> {
  const runDir = path.resolve(opts.runDir);
  const outFile = path.resolve(opts.outPath ?? path.join(runDir, 'report.html'));
  const outDir = path.dirname(outFile);
  const view = fold(await readEvents(runDir));
  const html = renderPage(view, {
    live: false,
    localHref: (p) => toPosix(path.relative(outDir, path.resolve(runDir, p))) || toPosix(p),
  });
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(outFile, html, 'utf8');
  return outFile;
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.json': 'application/json', '.har': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

/** Tails events.jsonl for one SSE client: replay first, then appended bytes. */
function startStream(res: ServerResponse, file: string): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let offset = 0;
  // Carry is a Buffer, not a string: a chunk boundary can split a UTF-8 code point.
  let carry = Buffer.alloc(0);
  let busy = false;
  let alive = true;

  const pump = async (): Promise<void> => {
    if (busy || !alive) return;
    busy = true;
    try {
      const stat = await fsp.stat(file);
      if (stat.size < offset) [offset, carry] = [0, Buffer.alloc(0)];
      if (stat.size > offset) {
        const fh = await fsp.open(file, 'r');
        try {
          const buf = Buffer.alloc(stat.size - offset);
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
          offset += bytesRead;
          carry = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
        } finally {
          await fh.close();
        }
        for (let nl = carry.indexOf(10); nl !== -1; nl = carry.indexOf(10)) {
          const line = carry.subarray(0, nl).toString('utf8').trim();
          carry = carry.subarray(nl + 1);
          if (line && alive) res.write(`data: ${line}\n\n`);
        }
      }
    } catch {
      /* the run may not have written events.jsonl yet */
    }
    busy = false;
  };

  void pump();
  const poll = setInterval(() => void pump(), POLL_MS);
  const beat = setInterval(() => {
    if (alive) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  return () => {
    if (!alive) return;
    alive = false;
    clearInterval(poll);
    clearInterval(beat);
    res.end();
  };
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* opening a browser is best-effort */
  }
}

export async function serve(
  opts: { runDir: string; port?: number; open?: boolean },
): Promise<{ url: string; close(): Promise<void> }> {
  const runDir = path.resolve(opts.runDir);
  const eventsFile = path.join(runDir, 'events.jsonl');
  const artifactsDir = path.resolve(runDir, 'artifacts');
  const sockets = new Set<Socket>();
  const streams = new Set<() => void>();

  const plain = (res: ServerResponse, code: number, body: string): void => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);

    if (pathname === '/' || pathname === '/index.html') {
      void readEvents(runDir).then((events) => {
        const html = renderPage(fold(events), {
          live: true,
          localHref: (p) => '/artifacts/' + toPosix(p).replace(/^artifacts\//, ''),
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      });
      return;
    }

    if (pathname === '/events') {
      const stop = startStream(res, eventsFile);
      streams.add(stop);
      const drop = (): void => {
        streams.delete(stop);
        stop();
      };
      req.on('close', drop);
      res.on('close', drop);
      return;
    }

    if (pathname.startsWith('/artifacts/')) {
      // Resolve then re-check the prefix: that also catches `..` and absolute
      // segments that survived URL normalisation as percent-escapes.
      const rel = pathname.slice('/artifacts/'.length);
      const full = path.resolve(artifactsDir, rel);
      if (rel.includes('\0') || !full.startsWith(artifactsDir + path.sep)) {
        plain(res, 403, 'forbidden');
        return;
      }
      void fsp
        .stat(full)
        .then((stat) => {
          if (!stat.isFile()) throw new Error('not a file');
          const type = CONTENT_TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(stat.size) });
          createReadStream(full).pipe(res);
        })
        .catch(() => plain(res, 404, 'not found'));
      return;
    }

    plain(res, 404, 'not found');
  });

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const bind = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const onError = (): void => {
        server.removeListener('listening', onOk);
        resolve(false);
      };
      const onOk = (): void => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError).once('listening', onOk).listen(port, '127.0.0.1');
    });

  const first = opts.port ?? DEFAULT_PORT;
  let bound = 0;
  for (let p = first; p < first + PORT_TRIES && !bound; p += 1) if (await bind(p)) bound = p;
  if (!bound) throw new Error(`mobile-bisect: no free port in ${first}-${first + PORT_TRIES - 1}`);

  const url = `http://127.0.0.1:${bound}`;
  if (opts.open) openBrowser(url);

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      for (const stop of streams) stop();
      streams.clear();
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    });
    return closing;
  };

  return { url, close };
}
