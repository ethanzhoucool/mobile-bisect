#!/usr/bin/env node
/**
 * Entry point. Deliberately tiny: colour support is decided when picocolors is
 * first imported, so `--no-color` has to be honoured before anything else loads.
 */

if (process.argv.includes('--no-color') || process.argv.includes('--color=false')) {
  process.env.NO_COLOR = '1';
}

const { main } = await import('./main.js');
process.exitCode = await main(process.argv.slice(2));
