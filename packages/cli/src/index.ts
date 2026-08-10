/**
 * Library surface. The CLI is the product; this exists so a project's
 * `mobile-bisect.config.ts` can `import { defineConfig } from 'mobile-bisect'`,
 * and so tooling can reuse the flow parser.
 */

export { defineConfig, type MobileBisectConfig } from './config.js';
export { parseFlow, loadFlow, findFlowFile, FlowError } from './flow.js';
export { parseArgs, helpText, type ParsedArgs } from './args.js';
export { main } from './main.js';
export type { FlowDefinition, FlowStep } from '@mobile-bisect/core';
