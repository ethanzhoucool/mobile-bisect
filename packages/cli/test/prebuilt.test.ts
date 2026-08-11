import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appIdFromRevylConfig,
  buildChain,
  narrowedRange,
  narrowByBuilds,
  resolveBuildCommits,
  shaCandidates,
} from '../src/prebuilt.js';
import { makeRepo, tempDir } from './helpers.js';
import type { CommitSummary } from '@mobile-bisect/core';

function summaries(shas: string[]): CommitSummary[] {
  return shas.map((sha, index) => ({
    sha,
    shortSha: sha.slice(0, 7),
    subject: `commit ${index}`,
    author: 'test',
    authoredAt: new Date(index * 1000).toISOString(),
    index,
  }));
}

describe('shaCandidates', () => {
  it('finds a bare short sha', () => {
    expect(shaCandidates('c801b0b')).toEqual(['c801b0b']);
  });

  it('finds a sha inside a CI-style label', () => {
    expect(shaCandidates('main-3efb0b3')).toContain('3efb0b3');
  });

  it('yields nothing for a label with no hex run', () => {
    expect(shaCandidates('verify-head')).toEqual([]);
  });

  it('still yields a date-shaped token, which git is left to reject', () => {
    // 20260731 is hex-legal and not a commit; the filter is git, not the regex.
    expect(shaCandidates('revyl-dark-20260731')).toContain('20260731');
  });

  it('deduplicates repeats', () => {
    expect(shaCandidates('c801b0b-c801b0b')).toEqual(['c801b0b']);
  });
});

describe('resolveBuildCommits', () => {
  let dir: string;
  let shas: string[];

  beforeEach(async () => {
    ({ dir, shas } = await makeRepo({ commits: 6 }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves labels that name a commit in the range', async () => {
    const commits = summaries(shas);
    const found = await resolveBuildCommits(
      dir,
      [
        { buildId: 'b2', version: shas[2]!.slice(0, 7) },
        { buildId: 'b4', version: `main-${shas[4]!.slice(0, 7)}` },
      ],
      commits,
    );

    expect(found.map((f) => f.buildId)).toEqual(['b2', 'b4']);
    expect(found[0]!.commit.sha).toBe(shas[2]);
  });

  it('returns them oldest commit first, whatever order the builds arrived in', async () => {
    const commits = summaries(shas);
    const found = await resolveBuildCommits(
      dir,
      [
        { buildId: 'b4', version: shas[4]!.slice(0, 7) },
        { buildId: 'b1', version: shas[1]!.slice(0, 7) },
      ],
      commits,
    );
    expect(found.map((f) => f.commit.index)).toEqual([1, 4]);
  });

  it('drops a label that names no commit', async () => {
    const found = await resolveBuildCommits(
      dir,
      [{ buildId: 'b', version: 'verify-head' }],
      summaries(shas),
    );
    expect(found).toEqual([]);
  });

  it('drops a date that only looks like a sha', async () => {
    const found = await resolveBuildCommits(
      dir,
      [{ buildId: 'b', version: 'revyl-dark-20260731' }],
      summaries(shas),
    );
    expect(found).toEqual([]);
  });

  it('drops a real commit that is outside the range', async () => {
    // Range covers the first three only; the build names the fifth.
    const found = await resolveBuildCommits(
      dir,
      [{ buildId: 'b', version: shas[5]!.slice(0, 7) }],
      summaries(shas.slice(0, 3)),
    );
    expect(found).toEqual([]);
  });

  it('keeps one build per commit, preferring the first it is given', async () => {
    const found = await resolveBuildCommits(
      dir,
      [
        { buildId: 'newest', version: shas[2]!.slice(0, 7) },
        { buildId: 'older', version: `rebuild-${shas[2]!.slice(0, 7)}` },
      ],
      summaries(shas),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.buildId).toBe('newest');
  });
});

describe('buildChain', () => {
  const commits = summaries(['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(40)));

  it('brackets the pre-built commits with both boundaries', () => {
    const chain = buildChain(commits, [
      { commit: commits[2]!, buildId: 'b2', version: 'v2' },
    ]);
    expect(chain?.map((c) => c.commit.index)).toEqual([0, 2, 4]);
  });

  it('gives the boundaries no build id, since their verdicts are given', () => {
    const chain = buildChain(commits, [{ commit: commits[2]!, buildId: 'b2', version: 'v2' }]);
    expect(chain?.[0]!.buildId).toBe('');
    expect(chain?.[chain.length - 1]!.buildId).toBe('');
  });

  it('is undefined when no pre-built commit sits between the boundaries', () => {
    expect(buildChain(commits, [])).toBeUndefined();
    // A build of a boundary adds nothing: that verdict is already known.
    expect(buildChain(commits, [{ commit: commits[0]!, buildId: 'b', version: 'v' }])).toBeUndefined();
  });

  it('is undefined for a range too short to have an interior', () => {
    expect(buildChain(commits.slice(0, 2), [])).toBeUndefined();
  });
});

describe('narrowedRange', () => {
  const commits = summaries(['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(40)));

  it('keeps both ends, which carry the verdicts the next search needs', () => {
    const range = narrowedRange(commits, commits[1]!.sha, commits[3]!.sha);
    expect(range.map((c) => c.index)).toEqual([1, 2, 3]);
  });

  it('falls back to the full range when the boundaries make no sense', () => {
    expect(narrowedRange(commits, commits[3]!.sha, commits[1]!.sha)).toHaveLength(5);
    expect(narrowedRange(commits, 'nope', commits[3]!.sha)).toHaveLength(5);
  });
});

describe('narrowByBuilds', () => {
  const commits = summaries(Array.from({ length: 9 }, (_, i) => String(i).repeat(40)));
  const chainOf = (indices: number[]) =>
    indices.map((i) => ({ commit: commits[i]!, buildId: `b${i}`, version: `v${i}` }));

  it('narrows to the two pre-built commits the culprit sits between', async () => {
    // Builds at 0, 2, 4, 6, 8. The regression really lands at commit 5.
    const chain = chainOf([0, 2, 4, 6, 8]);
    const result = await narrowByBuilds({
      chain,
      test: async (e) => (e.commit.index >= 5 ? 'bad' : 'good'),
    });

    expect(result.goodSha).toBe(commits[4]!.sha);
    expect(result.badSha).toBe(commits[6]!.sha);
  });

  it('never tests the boundaries, whose verdicts are already known', async () => {
    const seen: number[] = [];
    await narrowByBuilds({
      chain: chainOf([0, 2, 4, 6, 8]),
      test: async (e) => {
        seen.push(e.commit.index);
        return e.commit.index >= 5 ? 'bad' : 'good';
      },
    });
    expect(seen).not.toContain(0);
    expect(seen).not.toContain(8);
  });

  it('tests a logarithmic number of builds, not all of them', async () => {
    const chain = chainOf([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await narrowByBuilds({
      chain,
      test: async (e) => (e.commit.index >= 5 ? 'bad' : 'good'),
    });
    expect(result.tested).toBeLessThanOrEqual(3);
    expect(result.goodSha).toBe(commits[4]!.sha);
    expect(result.badSha).toBe(commits[5]!.sha);
  });

  it('drops a build it cannot classify and keeps going', async () => {
    const notes: string[] = [];
    const result = await narrowByBuilds({
      chain: chainOf([0, 2, 4, 6, 8]),
      test: async (e) => (e.commit.index === 4 ? 'skip' : e.commit.index >= 5 ? 'bad' : 'good'),
      onNote: (l) => notes.push(l),
    });

    expect(notes.join()).toMatch(/could not be classified/);
    // 4 told us nothing, so the answer is the next-widest pair it could prove.
    expect(result.goodSha).toBe(commits[2]!.sha);
    expect(result.badSha).toBe(commits[6]!.sha);
  });

  it('returns the original boundaries when every build is unusable', async () => {
    const result = await narrowByBuilds({
      chain: chainOf([0, 2, 4, 8]),
      test: async () => 'skip',
    });
    expect(result.goodSha).toBe(commits[0]!.sha);
    expect(result.badSha).toBe(commits[8]!.sha);
  });
});

describe('appIdFromRevylConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDir();
    await mkdir(join(dir, '.revyl'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (body: string) => writeFile(join(dir, '.revyl', 'config.yaml'), body, 'utf8');

  it('prefers the platform block over the shared id', async () => {
    await write(
      [
        'build:',
        '    app_id: 11111111-1111-1111-1111-111111111111',
        '    platforms:',
        '        ios:',
        '            app_id: 449ae04e-24b3-45a6-b125-c628092c441e',
        '',
      ].join('\n'),
    );
    expect(await appIdFromRevylConfig(dir, 'ios')).toBe('449ae04e-24b3-45a6-b125-c628092c441e');
  });

  it('falls back to the shared id when the platform has none', async () => {
    await write(['build:', '    app_id: 11111111-1111-1111-1111-111111111111', ''].join('\n'));
    expect(await appIdFromRevylConfig(dir, 'ios')).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('does not read another platform’s id', async () => {
    await write(
      [
        'build:',
        '    platforms:',
        '        android:',
        '            app_id: 4f1630f5-7259-41cd-8022-66276b53d6eb',
        '',
      ].join('\n'),
    );
    // No ios block and no shared id, so android's must not be borrowed.
    expect(await appIdFromRevylConfig(dir, 'ios')).toBeUndefined();
  });

  it('matches a build-variant key like ios-dev', async () => {
    await write(
      [
        'build:',
        '    platforms:',
        '        ios-dev:',
        '            app_id: 449ae04e-24b3-45a6-b125-c628092c441e',
        '',
      ].join('\n'),
    );
    expect(await appIdFromRevylConfig(dir, 'ios')).toBe('449ae04e-24b3-45a6-b125-c628092c441e');
  });

  it('is undefined when there is no config at all', async () => {
    expect(await appIdFromRevylConfig(dir, 'ios')).toBeUndefined();
  });
});
