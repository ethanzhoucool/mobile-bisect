/**
 * The commit rail: one cell per commit, oldest on the left.
 *
 * Pure and colour-free so it can be unit tested; painting happens in live.ts.
 */

export type RailCellState = 'untested' | 'running' | 'good' | 'bad' | 'skipped' | 'culprit';

export const RAIL_CHARS: Record<RailCellState, string> = {
  untested: '·',
  running: '◍',
  good: '●',
  bad: '●',
  skipped: '◌',
  culprit: '◉',
};

/** Which state wins when several commits share one cell. */
const PRIORITY: RailCellState[] = ['culprit', 'running', 'bad', 'good', 'skipped', 'untested'];

/**
 * Squeeze n cells into `width` columns. 64 commits fit an 80-column terminal
 * one-to-one; anything longer buckets, and the most interesting state in a
 * bucket is the one you see.
 */
export function collapse(cells: RailCellState[], width: number): RailCellState[] {
  if (width <= 0) return [];
  if (cells.length <= width) return cells.slice();

  const out: RailCellState[] = [];
  for (let col = 0; col < width; col++) {
    const start = Math.floor((col * cells.length) / width);
    const end = Math.max(start + 1, Math.floor(((col + 1) * cells.length) / width));
    let best: RailCellState = 'untested';
    let bestRank = PRIORITY.length;
    for (let i = start; i < end && i < cells.length; i++) {
      const rank = PRIORITY.indexOf(cells[i]!);
      if (rank < bestRank) {
        bestRank = rank;
        best = cells[i]!;
      }
    }
    out.push(best);
  }
  return out;
}

/** Column a commit index lands on once the rail is collapsed to `width`. */
export function columnOf(index: number, total: number, width: number): number {
  if (total <= width) return Math.max(0, Math.min(index, width - 1));
  return Math.max(0, Math.min(width - 1, Math.floor((index * width) / total)));
}

export function railText(cells: RailCellState[]): string {
  return cells.map((c) => RAIL_CHARS[c]).join('');
}

/**
 * The bracket that sits under the still-unknown range. Collapses to a single
 * tick when the range is one commit wide, and to nothing when the search is
 * over (lo > hi).
 */
export function bracketLine(
  range: [number, number],
  total: number,
  width: number,
): string {
  const [lo, hi] = range;
  if (total === 0 || lo > hi) return '';
  const start = columnOf(lo, total, width);
  const end = columnOf(hi, total, width);
  if (end <= start) return `${' '.repeat(start)}╵`;
  return `${' '.repeat(start)}╰${'─'.repeat(Math.max(0, end - start - 1))}╯`;
}
