import { createRoot } from 'react-dom/client';
import { BisectReport } from './BisectReport.tsx';
import type { BisectEvent } from './types.ts';
import './styles/index.css';

interface InlineConfig {
  mode?: 'live' | 'replay';
  sseUrl?: string;
  runId?: string;
  allowRemoteMedia?: boolean;
}

function readJson<T>(id: string): T | undefined {
  const el = document.getElementById(id);
  if (!el?.textContent) return undefined;
  try {
    const v = JSON.parse(el.textContent);
    // Unreplaced build placeholder — treat as absent.
    return typeof v === 'string' && v.startsWith('__EXPO_BISECT') ? undefined : (v as T);
  } catch {
    return undefined;
  }
}

const params = new URLSearchParams(location.search);
const num = (k: string) => (params.has(k) ? Number(params.get(k)) : undefined);

const config = readJson<InlineConfig>('expo-bisect-config') ?? {};
const events = readJson<BisectEvent[]>('expo-bisect-events') ?? [];
const frames = readJson<Record<string, string>>('expo-bisect-frames') ?? {};

createRoot(document.getElementById('root')!).render(
  <BisectReport
    events={events}
    mode={config.mode ?? 'replay'}
    sseUrl={config.sseUrl}
    allowRemoteMedia={config.allowRemoteMedia ?? false}
    frameData={frames}
    chrome={params.get('chrome') !== 'off'}
    parallel={num('parallel') ?? 0}
    initialTime={num('t') ?? 0}
    initialSpeed={num('speed') ?? 1}
    autoplay={params.get('paused') !== '1'}
    initialTab={(params.get('tab') as 'visual' | 'network' | 'logs' | 'code') ?? undefined}
    initialDrawer={(params.get('drawer') as 'peek' | 'open') ?? null}
    initialDiff={params.get('diff') === '1'}
  />,
);
