import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { RunKind, RunStatus, WorkflowRun } from '../database/schemas';
import type { ResearchResult } from '../agent/agent-runner.interface';
import type { BuildInput, RunRecordHandle } from './engine/workflow.types';
import { WorkflowStep } from './workflow.constants';

export interface CreateRunInput {
  userId: string;
  artifactId: string;
  targetVersion: number;
  kind: RunKind;
  input: BuildInput;
}

@Injectable()
export class WorkflowRunService {
  constructor(
    @InjectModel(WorkflowRun.name)
    private readonly workflowRunModel: Model<WorkflowRun>,
  ) {}

  async createRun(input: CreateRunInput): Promise<WorkflowRun> {
    return this.workflowRunModel.create({
      user: new Types.ObjectId(input.userId),
      artifact: new Types.ObjectId(input.artifactId),
      targetVersion: input.targetVersion,
      kind: input.kind,
      status: RunStatus.RUNNING,
      input: input.input,
      creditsUsed: 0,
    });
  }

  /**
   * The engine depends on `RunRecordHandle`, not on this service. Binding the
   * runId here keeps every call site from re-threading it.
   */
  handleFor(runId: string): RunRecordHandle {
    return {
      runId,
      setCurrentStep: (step: WorkflowStep) =>
        this.patch(runId, { currentStep: step }),
      saveResearchContext: (research: ResearchResult) =>
        this.patch(runId, { researchContext: research }),
      complete: (creditsUsed: number) =>
        this.patch(runId, { status: RunStatus.COMPLETED, creditsUsed }),
      fail: (failureReason: string) =>
        this.patch(runId, { status: RunStatus.FAILED, failureReason }),
    };
  }

  private async patch(
    runId: string,
    fields: Partial<WorkflowRun>,
  ): Promise<void> {
    await this.workflowRunModel.updateOne(
      { _id: new Types.ObjectId(runId) },
      { $set: fields },
    );
  }
}
