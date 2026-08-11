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
        '    type: manual',
        '    step_type: type',
        '    target: the coupon field',
        '    text: SAVE10',
        '    retries: 2',
      ].join('\n'),
      'f.yaml',
    );

    // Keys we have no opinion about, like `retries`, reach the runner as-is.
    expect(flow.steps[0]).toEqual({
      label: 'Apply coupon',
      type: 'manual',
      step_type: 'type',
      target: 'the coupon field',
      text: 'SAVE10',
      retries: 2,
    });
  });

  it('points at the line of a step with no label', async () => {
    const error = await expectFlowError(
      [
        'name: f',
        'steps:',
        '  - label: Open cart',
        '    type: instructions',
        '    step_description: tap the cart icon',
        '  - type: instructions',
        '    step_description: tap Place order',
      ].join('\n'),
    );

    expect(error.line).toBe(6);
    expect(error.message).toContain('flows/checkout.yaml:6');
    expect(error.message).toContain('step 2 is missing a `label`');
    // the excerpt shows the offending source line
    expect(error.message).toContain('- type: instructions');
  });

  describe('a step body the runner cannot execute', () => {
    // These used to load. `type` defaulted to `instructions` and the text fell
    // back to the label, so the step ran as an agent instruction reading
    // "Assert the order was placed" and the search blamed a commit for the
    // result. A rejected file is recoverable; a wrong culprit is not.
    it('rejects a step that never says what kind of step it is', async () => {
      const error = await expectFlowError(
        ['name: f', 'steps:', '  - label: Open cart', '    tap: the cart icon'].join('\n'),
      );
      expect(error.message).toContain('does not say what kind of step it is');
      expect(error.hint).toContain('step_description');
    });

    it('rejects a described step with an unknown type', async () => {
      const error = await expectFlowError(
        ['name: f', 'steps:', '  - label: a', '    type: assert', '    step_description: b'].join(
          '\n',
        ),
      );
      expect(error.message).toContain('unsupported `type: assert`');
      expect(error.hint).toContain('validation');
    });

    it('rejects a step whose only text is its own label', async () => {
      const error = await expectFlowError(
        ['name: f', 'steps:', '  - label: Assert the order was placed', '    type: validation'].join(
          '\n',
        ),
      );
      expect(error.message).toContain('no `step_description`');
      expect(error.hint).toContain('fall back to the label');
    });

    it('rejects a manual step that does not say which action to take', async () => {
      const error = await expectFlowError(
        ['name: f', 'steps:', '  - label: a', '    type: manual', '    target: b'].join('\n'),
      );
      expect(error.message).toContain('does not say which action to take');
    });

    it('rejects an unsupported manual action and lists the real ones', async () => {
      const error = await expectFlowError(
        ['name: f', 'steps:', '  - label: a', '    type: manual', '    step_type: pinch'].join(
          '\n',
        ),
      );
      expect(error.message).toContain('unsupported `step_type: pinch`');
      expect(error.hint).toContain('swipe');
    });

    it('accepts every shape the runner does', () => {
      const flow = parseFlow(
        [
          'name: f',
          'steps:',
          '  - label: a',
          '    type: validation',
          '    step_description: the home screen is showing',
          '  - label: b',
          '    type: instructions',
          '    step_description: tap the cart icon',
          '  - label: c',
          '    type: extraction',
          '    step_description: the order total',
          '  - label: d',
          '    type: manual',
          '    step_type: tap',
          '    target: cart.icon',
        ].join('\n'),
        'f.yaml',
      );
      expect(flow.steps).toHaveLength(4);
    });
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
