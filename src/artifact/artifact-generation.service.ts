import { Injectable } from '@nestjs/common';
import { RunKind } from 'src/database/schemas';
import { CreditMeterService } from 'src/feature-gating/credit-meter.service';
import { WorkflowRunService } from 'src/workflow/workflow-run.service';
import { WorkflowQueue } from 'src/workflow/workflow.queue';
import type { BuildInput } from 'src/workflow/engine/workflow.types';
import { ArtifactService, CreateArtifactInput } from './artifact.service';

export interface LaunchResult {
  artifactId: string;
  runId: string;
}

/**
 * Orchestrates artifact creation over HTTP: a fast balance pre-check, then the
 * `Artifact` → `WorkflowRun` → BullMQ-job chain that a single 202 hands to the
 * client as `{ artifactId, runId }`. The run is filled asynchronously by the
 * worker and watched over SSE — synchronous creation was rejected because
 * research + LLM + render take tens of seconds.
 */
@Injectable()
export class ArtifactGenerationService {
  constructor(
    private readonly artifactService: ArtifactService,
    private readonly workflowRunService: WorkflowRunService,
    private readonly creditMeter: CreditMeterService,
    private readonly workflowQueue: WorkflowQueue,
  ) {}

  async launchInitialRun(
    userId: string,
    input: CreateArtifactInput,
  ): Promise<LaunchResult> {
    // Pre-check the headroom so an out-of-credits user gets a fast 403 rather
    // than a queued run that fails after doing work.
    await this.creditMeter.assertBalance(userId);

    const artifact = await this.artifactService.createArtifact(userId, input);
    const artifactId = artifact._id.toString();

    // The run's `input` and the BullMQ job payload are the same `BuildInput`:
    // the worker reads the job, an SSE cold start re-derives the step list from
    // the run's copy.
    const buildInput: BuildInput = {
      type: input.type,
      prompt: input.prompt,
      withResearch: input.withResearch,
      stylePreset: input.stylePreset,
      theme: input.theme,
      kind: RunKind.INITIAL,
      userId,
      artifactId,
      version: 1,
    };

    const run = await this.workflowRunService.createRun({
      userId,
      artifactId,
      targetVersion: 1,
      kind: RunKind.INITIAL,
      input: buildInput,
    });
    const runId = run._id.toString();

    await this.workflowQueue.addArtifactRunJob(runId, buildInput);

    return { artifactId, runId };
  }
}
