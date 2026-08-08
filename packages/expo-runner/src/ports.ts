/**
 * Port allocation for concurrent candidates.
 *
 * `basePort + index` is not good enough: under `--concurrency 4` the candidates
 * are prepared and disposed out of order, and the machine may already be running
 * a Metro of its own. Every handout is proven free by actually binding it.
 */

import * as net from 'node:net';

export const DEFAULT_PORT_MIN = 8081;
export const DEFAULT_PORT_MAX = 8181;

export interface PortAllocatorOptions {
  /** Inclusive lower bound. Default 8081 (Metro's conventional port). */
  min?: number;
  /** Inclusive upper bound. Default 8181. */
  max?: number;
}

export class PortRangeExhaustedError extends Error {
  readonly min: number;
  readonly max: number;
  readonly reserved: number[];

  constructor(min: number, max: number, reserved: number[]) {
    super(
      `no free port in ${min}-${max} (${reserved.length} reserved by this process: ` +
        `${reserved.join(', ') || 'none'}). Widen the range with --port-range or lower --concurrency.`,
    );
    this.name = 'PortRangeExhaustedError';
    this.min = min;
    this.max = max;
    this.reserved = reserved;
  }
}

/** Binds the port for real, then releases it. `false` means someone else holds it. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const done = (free: boolean) => {
      server.removeAllListeners();
      if (free) server.close(() => resolve(true));
      else resolve(false);
    };
    server.once('error', () => done(false));
    // No host => all interfaces, so a port held only on 0.0.0.0 still reads as busy.
    server.listen({ port, exclusive: true }, () => done(true));
  });
}

export class PortAllocator {
  readonly min: number;
  readonly max: number;
  private readonly reserved = new Set<number>();

  constructor(opts: PortAllocatorOptions = {}) {
    this.min = opts.min ?? DEFAULT_PORT_MIN;
    this.max = opts.max ?? DEFAULT_PORT_MAX;
    if (!Number.isInteger(this.min) || !Number.isInteger(this.max) || this.min < 1 || this.max > 65535) {
      throw new Error(`invalid port range ${this.min}-${this.max}`);
    }
    if (this.min > this.max) throw new Error(`invalid port range: min ${this.min} > max ${this.max}`);
  }

  /**
   * The port is added to the reserved set BEFORE the bind probe, so two
   * concurrent callers can never race onto the same candidate in the window
   * between "probe succeeded" and "Metro actually bound it".
   */
  async allocate(): Promise<number> {
    for (let port = this.min; port <= this.max; port++) {
      if (this.reserved.has(port)) continue;
      this.reserved.add(port);
      let free = false;
      try {
        free = await isPortFree(port);
      } catch {
        free = false;
      }
      if (free) return port;
      this.reserved.delete(port);
    }
    throw new PortRangeExhaustedError(this.min, this.max, this.reservedPorts());
  }

  release(port: number): void {
    this.reserved.delete(port);
  }

  releaseAll(): void {
    this.reserved.clear();
  }

  isReserved(port: number): boolean {
    return this.reserved.has(port);
  }

  reservedPorts(): number[] {
    return [...this.reserved].sort((a, b) => a - b);
  }
}
