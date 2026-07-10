import { WorkflowStep } from '../workflow.constants';
import type { StepHandlerMap } from '../engine/workflow.types';
import { generateStep } from './generate.step';
import { persistVersionStep } from './persist-version.step';
import { resolveInputStep } from './resolve-input.step';

export * from './generate.step';
export * from './persist-version.step';
export * from './resolve-input.step';

/**
 * `RESEARCH` and `RENDER_PDF` are deliberately absent until their slices land.
 * The builder emits them only for research-on and DOCUMENT runs, and the engine
 * fails such a run terminally rather than silently skipping a step the client's
 * progress bar is already counting.
 */
export const artifactStepHandlers: StepHandlerMap = {
  [WorkflowStep.RESOLVE_INPUT]: resolveInputStep,
  [WorkflowStep.GENERATE]: generateStep,
  [WorkflowStep.PERSIST_VERSION]: persistVersionStep,
};
