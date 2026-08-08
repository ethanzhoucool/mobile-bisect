import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const FIXTURE = resolve(__dirname, '../../fixtures/demo-runs/orbit-checkout.jsonl');

/** During `vite dev` only: inline the demo fixture so the app has data to render. */
function devFixture(): Plugin {
  return {
    name: 'expo-bisect-dev-fixture',
    apply: 'serve',
    transformIndexHtml(html) {
      const events = readFileSync(FIXTURE, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      return html
        .replace('"__EXPO_BISECT_FRAMES__"', '{}')
        .replace('"__EXPO_BISECT_EVENTS__"', JSON.stringify(events))
        .replace('"__EXPO_BISECT_CONFIG__"', JSON.stringify({ mode: 'replay', runId: 'dev' }));
    },
  };
}

export default defineConfig({
  plugins: [react(), devFixture(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: 'es2020',
    outDir: 'dist',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 8000,
    reportCompressedSize: false,
  },
});
