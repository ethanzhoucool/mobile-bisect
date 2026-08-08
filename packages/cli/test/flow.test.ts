import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowError, findFlowFile, loadFlow, parseFlow } from '../src/flow.js';
import { EXAMPLE_FLOW, tempDir } from './helpers.js';

async function expectFlowError(source: string, file = 'flows/checkout.yaml'): Promise<FlowError> {
  try {
    parseFlow(source, file);
  } catch (e) {
    expect(e).toBeInstanceOf(FlowError);
    return e as FlowError;
  }
  throw new Error('expected the flow to be rejected');
}

describe('parseFlow', () => {
  it('parses the shipped example', async () => {
    const flow = parseFlow(await readFile(EXAMPLE_FLOW, 'utf8'), 'examples/flows/checkout.yaml');

    expect(flow.name).toBe('checkout-flow');
    expect(flow.appId).toBe('com.orbit.store');
    expect(flow.expect).toBe('the order confirmation screen appears');
    expect(flow.steps).toHaveLength(7);
    expect(flow.steps.map((s) => s.label)).toEqual([
      'Launch Orbit Store',
      'Open featured product',
      'Tap "Add to cart"',
      'Open cart',
      'Apply coupon SAVE10',
      'Tap "Place order"',
      'Assert order confirmation',
    ]);
  });

  it('passes the Revyl-native step body through untouched', () => {
    const flow = parseFlow(
      [
        'name: f',
        'steps:',
        '  - label: Apply coupon',
        '    type:',
        '      target: the coupon field',
        '      text: SAVE10',
        '      submit: true',
        '    retries: 2',
      ].join('\n'),
      'f.yaml',
    );

    expect(flow.steps[0]).toEqual({
      label: 'Apply coupon',
      type: { target: 'the coupon field', text: 'SAVE10', submit: true },
      retries: 2,
    });
  });

  it('points at the line of a step with no label', async () => {
    const error = await expectFlowError(
      ['name: f', 'steps:', '  - label: Open cart', '    tap: Cart', '  - tap: Place order'].join(
        '\n',
      ),
    );

    expect(error.line).toBe(5);
    expect(error.message).toContain('flows/checkout.yaml:5');
    expect(error.message).toContain('step 2 is missing a `label`');
    // the excerpt shows the offending source line
    expect(error.message).toContain('- tap: Place order');
  });

  it('rejects a step that has a label but no action', async () => {
    const error = await expectFlowError(['name: f', 'steps:', '  - label: Open cart'].join('\n'));
    expect(error.message).toContain('has a label but no action');
    expect(error.line).toBe(3);
  });

  it('rejects an unknown top-level key and lists the valid ones', async () => {
    const error = await expectFlowError(
      ['name: f', 'device: iPhone 15', 'steps:', '  - label: a', '    tap: b'].join('\n'),
    );
    expect(error.message).toContain('unknown key `device`');
    expect(error.hint).toContain('name, appId, expect, steps');
    expect(error.line).toBe(2);
  });

  it('requires a name', async () => {
    const error = await expectFlowError(['steps:', '  - label: a', '    tap: b'].join('\n'));
    expect(error.message).toContain('`name` is required');
  });

  it('requires steps to be a non-empty list', async () => {
    expect((await expectFlowError('name: f\nsteps: nope')).message).toContain('must be a list');
    expect((await expectFlowError('name: f\nsteps: []')).message).toContain('`steps` is empty');
    expect((await expectFlowError('name: f')).message).toContain('`steps` is required');
  });

  it('reports a YAML syntax error with its line', async () => {
    const error = await expectFlowError(
      ['name: f', 'steps:', '  - label: a', '   tap: b'].join('\n'),
    );
    expect(error.line).toBeGreaterThan(1);
    expect(error.hint).toContain('not valid YAML');
  });

  it('rejects a flow that is not a mapping', async () => {
    expect((await expectFlowError('- just\n- a\n- list')).message).toContain('YAML mapping');
  });
});

describe('loadFlow', () => {
  it('explains itself when the file is missing', async () => {
    await expect(loadFlow('/nope/definitely-not-here.yaml')).rejects.toThrow(
      /Can't read the flow file/,
    );
  });
});

describe('findFlowFile', () => {
  it('finds flows/checkout.yaml', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'flows'), { recursive: true });
    await writeFile(path.join(dir, 'flows', 'checkout.yaml'), 'name: f\n');
    expect(await findFlowFile(dir)).toBe(path.join(dir, 'flows', 'checkout.yaml'));
  });

  it('returns undefined when there is nothing to find', async () => {
    expect(await findFlowFile(await tempDir())).toBeUndefined();
  });
});
