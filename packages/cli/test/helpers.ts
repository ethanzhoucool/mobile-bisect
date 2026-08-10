import { execFile as execFileCb, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
export const EXAMPLE_FLOW = fileURLToPath(
  new URL('../examples/flows/checkout.yaml', import.meta.url),
);

export async function tempDir(prefix = 'mobile-bisect-test-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd: repo, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * A throwaway Expo-shaped repo: `commits` commits, tagged `v1.0` at the first,
 * with a real edit on the commit at `culpritIndex` so the diff has something to
 * say. Returns the shas oldest-first.
 */
export async function makeRepo(
  opts: { commits: number; culpritIndex?: number } = { commits: 8 },
): Promise<{ dir: string; shas: string[] }> {
  const dir = await tempDir();
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.name', 'Test Bot']);
  await git(dir, ['config', 'user.email', 'test@example.com']);

  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'orbit-store', dependencies: { expo: '51.0.0' } }, null, 2),
  );
  await writeFile(
    path.join(dir, 'app.json'),
    JSON.stringify({ expo: { name: 'Orbit Store', slug: 'orbit-store' } }, null, 2),
  );
  await mkdir(path.join(dir, 'flows'), { recursive: true });
  await writeFile(path.join(dir, 'flows', 'checkout.yaml'), await readFile(EXAMPLE_FLOW, 'utf8'));
  await mkdir(path.join(dir, 'app'), { recursive: true });
  await writeFile(path.join(dir, 'app', 'index.ts'), 'export const version = 1;\n');

  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'Release v1.0']);
  await git(dir, ['tag', 'v1.0']);

  for (let i = 1; i < opts.commits; i++) {
    if (i === opts.culpritIndex) {
      await mkdir(path.join(dir, 'app', 'checkout'), { recursive: true });
      await writeFile(
        path.join(dir, 'app', 'checkout', 'order.ts'),
        [
          'export async function placeOrder(cart) {',
          "  const response = await api.post('/orders', cart);",
          '  const order = parseOrder(response.data);',
          '  if (!order) return null;',
          '  router.replace(`/confirmation/${order.id}`);',
          '}',
          '',
        ].join('\n'),
      );
    } else {
      await writeFile(path.join(dir, 'app', 'index.ts'), `export const version = ${i + 1};\n`);
    }
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-qm', `commit ${i}`]);
  }

  const shas = (await git(dir, ['rev-list', '--reverse', 'HEAD'])).split('\n');
  return { dir, shas };
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Run the built CLI. `onStdout` can interrupt a long run mid-flight. */
export function runCli(
  args: string[],
  opts: {
    cwd: string;
    env?: Record<string, string>;
    onStdout?: (chunk: string, child: ReturnType<typeof spawn>) => void;
    timeoutMs?: number;
  },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1', ...opts.env },
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000);

    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      opts.onStdout?.(text, child);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

export async function readEvents(runDir: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path.join(runDir, 'events.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export async function latestRunDir(repo: string): Promise<string> {
  const runs = path.join(repo, '.mobile-bisect', 'runs');
  const { readdir } = await import('node:fs/promises');
  const entries = (await readdir(runs)).sort();
  return path.join(runs, entries[entries.length - 1]!);
}
