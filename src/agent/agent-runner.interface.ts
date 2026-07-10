import type { ArtifactType, CarouselTheme } from '../database/schemas';
import type { ArtifactContent } from '../artifact/schemas';
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

// Narrow role interface consumed by the workflow engine's StepContext. Steps
// depend on this; `AgentRunner`'s implementation lands with #116.
export interface AgentRunner {
  research(input: ResearchInput): Promise<ResearchResult>;
  generate(input: GenerateInput): Promise<ArtifactContent>;
}
