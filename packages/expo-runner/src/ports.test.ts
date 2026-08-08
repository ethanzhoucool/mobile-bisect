import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { PortAllocator, PortRangeExhaustedError, isPortFree } from './ports.js';

const openServers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    openServers.push(server);
    server.once('error', reject);
    server.listen(port, () => resolve());
  });
}

describe('PortAllocator', () => {
  it('hands out distinct ports to concurrent callers', async () => {
    const alloc = new PortAllocator({ min: 41000, max: 41060 });
    const ports = await Promise.all(Array.from({ length: 8 }, () => alloc.allocate()));
    expect(new Set(ports).size).toBe(8);
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(41000);
      expect(p).toBeLessThanOrEqual(41060);
      expect(alloc.isReserved(p)).toBe(true);
    }
  });

  it('reuses a port after release', async () => {
    const wide = new PortAllocator({ min: 41100, max: 41160 });
    const port = await wide.allocate();
    wide.release(port);
    expect(wide.isReserved(port)).toBe(false);

    const pinned = new PortAllocator({ min: port, max: port });
    expect(await pinned.allocate()).toBe(port);
    pinned.release(port);
    expect(await pinned.allocate()).toBe(port);
  });

  it('throws once the range is exhausted', async () => {
    const alloc = new PortAllocator({ min: 41200, max: 41203 });
    const handed: number[] = [];
    let thrown: unknown;
    for (let i = 0; i < 10; i++) {
      try {
        handed.push(await alloc.allocate());
      } catch (err) {
        thrown = err;
        break;
      }
    }
    expect(thrown).toBeInstanceOf(PortRangeExhaustedError);
    expect((thrown as Error).message).toMatch(/no free port in 41200-41203/);
    expect(handed.length).toBeLessThanOrEqual(4);
    expect(new Set(handed).size).toBe(handed.length);
  });

  it('skips a port that another process already holds', async () => {
    const probe = new PortAllocator({ min: 41300, max: 41360 });
    const taken = await probe.allocate();
    probe.release(taken);
    await occupy(taken);

    const alloc = new PortAllocator({ min: taken, max: taken + 5 });
    const got = await alloc.allocate();
    expect(got).not.toBe(taken);
  });

  it('rejects a nonsensical range', () => {
    expect(() => new PortAllocator({ min: 9000, max: 8000 })).toThrow(/min 9000 > max 8000/);
  });
});

describe('isPortFree', () => {
  it('is false for a bound port and true afterwards', async () => {
    const alloc = new PortAllocator({ min: 41400, max: 41460 });
    const port = await alloc.allocate();
    alloc.release(port);

    await occupy(port);
    expect(await isPortFree(port)).toBe(false);

    await Promise.all(
      openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    expect(await isPortFree(port)).toBe(true);
  });
});
