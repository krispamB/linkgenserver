import { WorkflowStep } from '../workflow.constants';
import type { StepHandlerMap } from '../engine/workflow.types';
import { generateStep } from './generate.step';
import { persistVersionStep } from './persist-version.step';
import { researchStep } from './research.step';
import { resolveInputStep } from './resolve-input.step';

export * from './generate.step';
export * from './persist-version.step';
export * from './research.step';
export * from './resolve-input.step';

/**
 * `RENDER_PDF` is deliberately absent until the carousel slice lands. The builder
 * emits it only for DOCUMENT runs, and the engine fails such a run terminally
 * rather than silently skipping a step the client's progress bar is already
 * counting.
 */
export const artifactStepHandlers: StepHandlerMap = {
  [WorkflowStep.RESOLVE_INPUT]: resolveInputStep,
  [WorkflowStep.RESEARCH]: researchStep,
  [WorkflowStep.GENERATE]: generateStep,
  [WorkflowStep.PERSIST_VERSION]: persistVersionStep,
};
