import type { ArtifactType, CarouselTheme } from '../database/schemas';
import type { ArtifactContent } from '../artifact/schemas';
import type { Usage } from '../llm/interfaces';
import type { StylePreset } from './style-presets.config';

export interface ResearchSource {
  title: string;
  url: string;
}

// `findings` is the agent's own synthesis after searching, not a dump of raw
// search bodies. Stored verbatim on WorkflowRun.researchContext so a refine
// reuses it with zero re-search.
export interface ResearchResult {
  findings: string;
  sources: ResearchSource[];
}

export interface ResearchInput {
  prompt: string;
  type: ArtifactType;
  stylePreset?: StylePreset;
}

export interface GenerateInput {
  type: ArtifactType;
  prompt: string;
  stylePreset?: StylePreset;
  theme?: CarouselTheme;
  research?: ResearchResult;
  refine?: { priorContent: ArtifactContent; feedback: string };
}

// One LLM turn's usage, tagged with the model that produced it. The step needs
// the model to fill `UsageDetail`, and Layer 1's `Usage` does not carry it.
export interface AgentTurnUsage extends Usage {
  model: string;
}

/**
 * `AgentRunner` must not hold the meter, so usage leaves it through hooks the
 * step bridges to `ctx.meter`. Live per-turn emission is what lets the SSE
 * stream show a climbing credit count during a long run.
 */
export interface AgentHooks {
  onUsage?: (usage: AgentTurnUsage) => void;
  // Fired by the research tool loop (#117); `generate` calls no tools.
  onToolCall?: (tool: { name: string }) => void;
}

// Narrow role interface consumed by the workflow engine's StepContext. Steps
// depend on this, not on `AgentRunnerService`.
export interface AgentRunner {
  research(input: ResearchInput, hooks?: AgentHooks): Promise<ResearchResult>;
  generate(input: GenerateInput, hooks?: AgentHooks): Promise<ArtifactContent>;
}
