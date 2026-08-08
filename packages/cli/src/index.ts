/**
 * Library surface. The CLI is the product; this exists so a project's
 * `expo-bisect.config.ts` can `import { defineConfig } from 'expo-bisect'`,
 * and so tooling can reuse the flow parser.
 */

export { defineConfig, type ExpoBisectConfig } from './config.js';
export { parseFlow, loadFlow, findFlowFile, FlowError } from './flow.js';
export { parseArgs, helpText, type ParsedArgs } from './args.js';
export { main } from './main.js';
export type { FlowDefinition, FlowStep } from '@expo-bisect/core';
