/**
 * The one-sentence diagnostic rendered under the two phones.
 *
 * The bar for asserting a root cause is deliberately high: a single changed
 * file, a navigation call that was removed or newly gated, and a corroborating
 * runner reason. Anything less comes back hedged with `likely: true` so the UI
 * can label the section LIKELY CAUSE instead of claiming certainty.
 */

import type { CommitResult } from './types.js';

export interface SuspectLine {
  file: string;
  line: number;
}

export interface DiagnoseInput {
  /** The last commit where the assertion held. */
  lastGood: CommitResult;
  /** The first commit where it stopped holding. */
  firstBad: CommitResult;
  /** Unified diff for the first-bad commit (`git show <sha>`). */
  diff: string;
  /** Assertion text, when it isn't already on the results. */
  expect?: string;
}

export interface Diagnosis {
  sentence: string;
  /** True when the sentence is a hypothesis rather than an assertion. */
  likely: boolean;
  suspectLines?: SuspectLine[];
}

type Kind = '+' | '-';

interface ChangedLine {
  file: string;
  line: number;
  kind: Kind;
  text: string;
}

const NAV =
  /\b(?:router\s*\.\s*(?:push|replace|navigate|back)|navigation\s*\.\s*(?:navigate|replace|push|goBack)|Linking\s*\.\s*openURL|redirect\s*\(|<Redirect\b|setScreen\s*\(|history\s*\.\s*push)/;
const PARSE =
  /(?:\.\s*json\s*\(\s*\)|JSON\s*\.\s*parse\s*\(|\.\s*data\b|\bparse[A-Z]\w*\s*\(|\bfromJson\b|\btoJson\b|\bnormalize\w*\s*\(|\bmapResponse\w*\s*\(|\bdeserialize\w*\s*\()/;
const GUARD = /(?:\bif\s*\(|\?\?|&&|\?\.|\breturn\s+null\b|\breturn;)/;

/**
 * A renamed response-envelope key (`order:` -> `data:`) breaks every reader
 * downstream while the request itself still succeeds. PARSE only catches
 * property *access*, so the declaration side needs its own pattern, scoped to
 * API-ish files, since a bare `data:` is far too common to trust anywhere else.
 */
const ENVELOPE_KEY =
  /^\s*(?:data|payload|result|body|attributes|order|item|items|records?)\s*:\s*[{[]?\s*$/;
const API_FILE = /(?:^|\/)(?:api|client|clients|services?|network|http|requests?|orders?)(?:\/|\.|$)/i;

const REQUEST = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s,;]*)\s+returned\s+(\d{3})/i;

export function diagnose(input: DiagnoseInput): Diagnosis {
  const changed = parseDiff(input.diff ?? '');
  const files = [...new Set(changed.map((c) => c.file))];
  const suspects = rankSuspects(changed);
  const shared = sharedRequestClause(input.lastGood.reason, input.firstBad.reason);
  const expect = input.expect ?? input.firstBad.assertion ?? input.lastGood.assertion;

  const boundariesTrusted = input.firstBad.state === 'bad' && input.lastGood.state === 'good';
  const nav = navEvidence(changed);
  const parseChanged = changed.some(
    (c) => PARSE.test(c.text) || (API_FILE.test(c.file) && ENVELOPE_KEY.test(c.text)),
  );

  const out = (sentence: string, likely: boolean): Diagnosis =>
    suspects.length > 0 ? { sentence, likely, suspectLines: suspects } : { sentence, likely };

  // Assert only when one file changed, the boundaries are real verdicts, and the
  // diff shows navigation actually losing its path.
  if (boundariesTrusted && files.length === 1) {
    if (nav.gatedByParsedValue && parseChanged) {
      return out(`${shared}Navigation stopped after the response parser returned undefined.`, false);
    }
    if (nav.removed) {
      const at = nav.removedAt ? ` (${nav.removedAt.file}:${nav.removedAt.line})` : '';
      return out(
        `${shared}The navigation call${at} was removed, so the flow never advances past that step.`,
        false,
      );
    }
  }

  // Everything below is a hypothesis.
  const subject = input.firstBad.subject ? `"${input.firstBad.subject}"` : 'the first bad commit';
  const assertionClause = expect ? `the assertion "${expect}"` : 'the assertion';

  if (!boundariesTrusted) {
    return out(
      `${shared}${subject} is the first commit where ${assertionClause} stopped holding, but one of the boundary runs was not a clean verdict. Re-run those two commits before trusting this.`,
      true,
    );
  }

  if (suspects.length === 0) {
    return out(
      `${shared}${subject} is the first commit where ${assertionClause} stopped holding, but its diff does not point at a single cause.`,
      true,
    );
  }

  const top = suspects[0]!;
  const where =
    files.length === 1
      ? `${top.file}:${top.line}`
      : `${top.file}:${top.line} (${files.length} files changed)`;
  const what = nav.touched
    ? 'it changes navigation'
    : parseChanged
      ? 'it changes how the response is parsed'
      : 'that is the closest change to the failing step';
  return out(
    `${shared}${subject} is the first commit where ${assertionClause} stopped holding. Start at ${where}: ${what}.`,
    true,
  );
}

// ---------------------------------------------------------------------------

/** `POST /orders returned 200 in both builds. ` when both runs agree. */
function sharedRequestClause(goodReason?: string, badReason?: string): string {
  if (!goodReason || !badReason) return '';
  const a = REQUEST.exec(goodReason);
  const b = REQUEST.exec(badReason);
  if (!a || !b) return '';
  if (a[1]!.toUpperCase() !== b[1]!.toUpperCase() || a[2] !== b[2] || a[3] !== b[3]) return '';
  return `${a[1]!.toUpperCase()} ${a[2]} returned ${a[3]} in both builds. `;
}

interface NavEvidence {
  touched: boolean;
  removed: boolean;
  removedAt?: SuspectLine;
  /** A surviving nav call now sits behind a check on a freshly-parsed value. */
  gatedByParsedValue: boolean;
}

function navEvidence(changed: ChangedLine[]): NavEvidence {
  const removedNav = changed.filter((c) => c.kind === '-' && NAV.test(c.text));
  const addedNav = changed.filter((c) => c.kind === '+' && NAV.test(c.text));
  const touched = removedNav.length > 0 || addedNav.length > 0;
  const removed = removedNav.length > 0 && addedNav.length === 0;

  // Identifiers that this commit newly binds from a parse-ish expression.
  const parsedIdents = new Set<string>();
  for (const c of changed) {
    if (c.kind !== '+' || !PARSE.test(c.text)) continue;
    for (const id of assignedIdents(c.text)) parsedIdents.add(id);
  }

  let gated = false;
  for (const navLine of addedNav) {
    const guards = changed.filter(
      (c) =>
        c.kind === '+' &&
        c.file === navLine.file &&
        c.line <= navLine.line &&
        navLine.line - c.line <= 6 &&
        GUARD.test(c.text),
    );
    for (const g of guards) {
      if ([...parsedIdents].some((id) => wordIn(g.text, id))) gated = true;
      // A nav call that is itself newly optional-chained is the same failure.
      if (/\?\./.test(navLine.text)) gated = true;
    }
    if (!gated && /\?\./.test(navLine.text) && parsedIdents.size > 0) gated = true;
  }
  // A removed unconditional nav replaced by a guarded one shows up here too.
  if (!gated && removedNav.length > 0 && addedNav.length > 0) {
    gated = addedNav.some((n) => GUARD.test(n.text)) || parsedIdents.size > 0;
  }

  const ev: NavEvidence = { touched, removed, gatedByParsedValue: gated };
  if (removedNav[0]) ev.removedAt = { file: removedNav[0].file, line: removedNav[0].line };
  return ev;
}

function assignedIdents(text: string): string[] {
  const out: string[] = [];
  const destructured = /(?:const|let|var)\s*\{([^}]*)\}\s*=/.exec(text);
  if (destructured) {
    for (const part of destructured[1]!.split(',')) {
      const name = part.split(':').pop()!.trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
    }
  }
  const single = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(text);
  if (single) out.push(single[1]!);
  return out;
}

function wordIn(text: string, ident: string): boolean {
  return new RegExp(`\\b${ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
}

function rankSuspects(changed: ChangedLine[]): SuspectLine[] {
  const scored = changed
    .map((c) => ({ c, score: scoreLine(c) }))
    .filter((s) => s.score > 0)
    // On a tie prefer the added line: "start at file:line" is read against the
    // checked-out bad commit, where a removed line's old number points at
    // whatever now sits there.
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.c.kind === b.c.kind ? a.c.line - b.c.line : a.c.kind === '+' ? -1 : 1),
    );
  const seen = new Set<string>();
  const out: SuspectLine[] = [];
  for (const { c } of scored) {
    const key = `${c.file}:${c.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file: c.file, line: c.line });
    if (out.length === 5) break;
  }
  return out;
}

function scoreLine(c: ChangedLine): number {
  let score = 0;
  if (NAV.test(c.text)) score += c.kind === '-' ? 6 : 4;
  if (PARSE.test(c.text)) score += 3;
  if (GUARD.test(c.text)) score += 2;
  if (API_FILE.test(c.file) && ENVELOPE_KEY.test(c.text)) score += 3;
  return score;
}

/** Minimal unified-diff reader: file paths plus 1-based line numbers. */
function parseDiff(diff: string): ChangedLine[] {
  const out: ChangedLine[] = [];
  let file = '';
  let inHunk = false;
  let oldLn = 0;
  let newLn = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHunk = false;
      const m = /\sb\/(.+)$/.exec(raw);
      file = m ? m[1]! : '';
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      if (p !== '/dev/null') file = p.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldLn = Number(m[1]);
        newLn = Number(m[2]);
        inHunk = true;
      }
      continue;
    }
    if (!inHunk) continue; // commit header / message lines
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw.startsWith('+')) {
      out.push({ file, line: newLn++, kind: '+', text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      out.push({ file, line: oldLn++, kind: '-', text: raw.slice(1) });
    } else {
      oldLn++;
      newLn++;
    }
  }
  return out;
}
