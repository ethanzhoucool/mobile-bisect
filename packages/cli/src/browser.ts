import { spawn } from 'node:child_process';

/** Best-effort: opening a browser is never worth failing a command over. */
export function openInBrowser(target: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [target], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    }).unref();
  } catch {
    /* headless machine, no browser, the path is printed anyway */
  }
}
