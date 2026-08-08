import { describe, expect, it } from 'vitest';
import { RAIL_CHARS, bracketLine, collapse, columnOf, railText } from '../src/ui/rail.js';
import { formatElapsed, truncate, visibleLength, wrap } from '../src/ui/live.js';

const cells = (spec: string) =>
  [...spec].map((c) =>
    c === 'g' ? 'good' : c === 'b' ? 'bad' : c === 'r' ? 'running' : c === 's' ? 'skipped' : c === 'c' ? 'culprit' : 'untested',
  ) as Parameters<typeof railText>[0];

describe('commit rail', () => {
  it('renders one character per commit', () => {
    expect(railText(cells('g..r..bc'))).toBe(
      `${RAIL_CHARS.good}${RAIL_CHARS.untested}${RAIL_CHARS.untested}${RAIL_CHARS.running}${RAIL_CHARS.untested}${RAIL_CHARS.untested}${RAIL_CHARS.bad}${RAIL_CHARS.culprit}`,
    );
    expect(railText(cells('.'.repeat(64)))).toHaveLength(64);
  });

  it('keeps the rail one-to-one when it fits', () => {
    const c = cells('g..b');
    expect(collapse(c, 80)).toEqual(c);
  });

  it('buckets a long history and keeps the most interesting state', () => {
    const c = cells('.'.repeat(200));
    c[150] = 'culprit';
    c[10] = 'good';
    const squeezed = collapse(c, 50);

    expect(squeezed).toHaveLength(50);
    expect(squeezed[columnOf(150, 200, 50)]).toBe('culprit');
    expect(squeezed[columnOf(10, 200, 50)]).toBe('good');
  });

  it('draws a bracket under the range still in play', () => {
    expect(bracketLine([2, 6], 10, 10)).toBe('  ╰───╯');
    expect(bracketLine([4, 4], 10, 10)).toBe('    ╵');
    // a finished search has nothing left to bracket
    expect(bracketLine([5, 4], 10, 10)).toBe('');
  });

  it('scales the bracket with the collapsed rail', () => {
    const line = bracketLine([100, 150], 200, 50);
    expect(line.indexOf('╰')).toBe(columnOf(100, 200, 50));
    expect(line.indexOf('╯')).toBe(columnOf(150, 200, 50));
  });
});

describe('live view helpers', () => {
  it('formats the elapsed clock', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(12_400)).toBe('0:12');
    expect(formatElapsed(75_000)).toBe('1:15');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
  });

  it('measures visible width ignoring colour codes', () => {
    expect(visibleLength('\x1b[32m●\x1b[39m ok')).toBe(4);
  });

  it('truncates with an ellipsis and wraps on words', () => {
    expect(truncate('Refactor order response handling', 12)).toBe('Refactor or…');
    expect(truncate('short', 12)).toBe('short');
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });
});
