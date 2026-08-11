/**
 * What a flow step is allowed to say.
 *
 * This lives in core because two packages need the same answer and must not
 * drift: the CLI checks it when a flow file is loaded, and the Revyl runner
 * translates it into device commands.
 *
 * The reason it is checked at all is that an unrecognised step body used to be
 * accepted. `type` defaulted to `instructions` and the description fell back to
 * the step's own label, so a step written in some other vocabulary still ran,
 * as an agent instruction whose text was the label. A validation step became an
 * action, an assertion that should have read the screen instead wandered around
 * the app, and the search recorded whatever came of that against the commit.
 * The failure mode was a confident wrong answer, which is the one thing a
 * bisect must never produce.
 */

/** Block types the device-session runner can execute. */
export const STEP_TYPES = [
  'instructions',
  'instruction',
  'validation',
  'extraction',
  'extract',
  'manual',
] as const;

/** Low-level device verbs a `manual` step may drive directly, keyed by `step_type`. */
export const MANUAL_STEP_TYPES = [
  'wait',
  'navigate',
  'kill_app',
  'go_home',
  'open_app',
  'tap',
  'double_tap',
  'long_press',
  'type',
  'swipe',
  'clear_text',
  'back',
  'key',
  'shake',
  'set_location',
] as const;

/** Keys that carry a step's text, in the order the runner prefers them. */
export const DESCRIPTION_KEYS = ['step_description', 'description'] as const;

const TYPES = new Set<string>(STEP_TYPES);
const MANUAL = new Set<string>(MANUAL_STEP_TYPES);

export interface StepShapeProblem {
  message: string;
  hint: string;
}

/**
 * Checks one step body, without running it.
 *
 * Returns undefined when the runner will understand the step. The `label` is
 * only used to word the message.
 */
export function checkStepShape(
  body: Record<string, unknown>,
  label: string,
): StepShapeProblem | undefined {
  const type = typeof body.type === 'string' ? body.type.toLowerCase() : undefined;

  if (type === undefined) {
    return {
      message: `step "${label}" does not say what kind of step it is.`,
      hint:
        'Add `type:` and a `step_description:`, e.g. `type: instructions` / ' +
        '`step_description: tap the green "Start focus" button`. ' +
        `Supported types: ${STEP_TYPES.join(', ')}.`,
    };
  }

  if (!TYPES.has(type)) {
    return {
      message: `step "${label}" has an unsupported \`type: ${String(body.type)}\`.`,
      hint: `Supported types: ${STEP_TYPES.join(', ')}.`,
    };
  }

  if (type === 'manual') {
    const stepType =
      typeof body.step_type === 'string' ? body.step_type.toLowerCase() : undefined;
    if (!stepType) {
      return {
        message: `step "${label}" is \`type: manual\` but does not say which action to take.`,
        hint: `Add \`step_type:\`, one of: ${[...MANUAL_STEP_TYPES].sort().join(', ')}.`,
      };
    }
    if (!MANUAL.has(stepType)) {
      return {
        message: `step "${label}" has an unsupported \`step_type: ${String(body.step_type)}\`.`,
        hint: `Supported: ${[...MANUAL_STEP_TYPES].sort().join(', ')}.`,
      };
    }
    return undefined;
  }

  const described = DESCRIPTION_KEYS.some(
    (k) => typeof body[k] === 'string' && (body[k] as string).length > 0,
  );
  if (!described) {
    return {
      message: `step "${label}" has \`type: ${type}\` but no \`step_description\`.`,
      hint:
        'The description is the text the device runs, or the claim it checks. ' +
        'Without it the step would fall back to the label, which describes the step ' +
        'to a human rather than telling the device what to do.',
    };
  }

  return undefined;
}
