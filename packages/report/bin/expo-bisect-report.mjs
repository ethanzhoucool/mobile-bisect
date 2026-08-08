#!/usr/bin/env node
import { renderReport, serve } from '../dist-node/index.js';

const [cmd, target, out] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

if (cmd === 'render') {
  if (!target) {
    console.error('usage: expo-bisect-report render <runDir|events.jsonl> [out.html]');
    process.exit(1);
  }
  const path = await renderReport({ runDir: target, outPath: out });
  console.log(path);
} else if (cmd === 'serve') {
  if (!target) {
    console.error('usage: expo-bisect-report serve <runDir|events.jsonl> [--port 4713] [--open]');
    process.exit(1);
  }
  const handle = await serve({
    runDir: target,
    port: Number(flag('port', 4713)),
    open: process.argv.includes('--open'),
  });
  console.log(`expo-bisect report → ${handle.url}`);
  process.on('SIGINT', async () => {
    await handle.close();
    process.exit(0);
  });
} else {
  console.error('usage: expo-bisect-report <render|serve> <runDir|events.jsonl>');
  process.exit(1);
}
