import { describe, expect, it } from 'vitest';
import { FakeAdapter } from './fake-adapter.js';

const SHA = 'a'.repeat(40);

describe('FakeAdapter', () => {
  it('prepares a bundle candidate by default', async () => {
    const adapter = new FakeAdapter();
    const c = await adapter.prepare(SHA, '/tmp/wt', { platform: 'ios' });

    expect(c.kind).toBe('bundle');
    expect(c.bundleUrl).toContain(SHA);
    expect(c.appPath).toBeUndefined();
    expect(c.platform).toBe('ios');
  });

  it('prepares a binary candidate when asked, so the upload path is exercisable', async () => {
    const adapter = new FakeAdapter({ candidateKind: 'binary' });
    const c = await adapter.prepare(SHA, '/tmp/wt', { platform: 'android' });

    expect(c.kind).toBe('binary');
    expect(c.appPath).toContain(SHA);
    expect(c.bundleUrl).toBeUndefined();
  });

  it('counts disposals so a leaked candidate is visible to tests', async () => {
    const adapter = new FakeAdapter();
    const c = await adapter.prepare(SHA, '/tmp/wt', { platform: 'ios' });
    expect(adapter.disposals).toBe(0);
    await c.dispose();
    expect(adapter.disposals).toBe(1);
  });

  it('fails the commits it was told to fail', async () => {
    const adapter = new FakeAdapter({ unpreparableShas: [SHA] });
    await expect(adapter.prepare(SHA, '/tmp/wt', { platform: 'ios' })).rejects.toThrow(
      /simulated preparation failure/,
    );
  });

  it('forwards log lines to the context sink', async () => {
    const lines: string[] = [];
    const adapter = new FakeAdapter();
    await adapter.prepare(SHA, '/tmp/wt', { platform: 'ios', onLog: (l) => lines.push(l) });
    expect(lines).toEqual([`[${SHA.slice(0, 7)}] prepared (fake)`]);
  });
});
