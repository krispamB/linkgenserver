jest.mock(
  '../database/schemas',
  () => ({
    WorkflowRun: { name: 'WorkflowRun' },
    RunKind: { INITIAL: 'INITIAL', REFINE: 'REFINE' },
    RunStatus: {
      RUNNING: 'RUNNING',
      COMPLETED: 'COMPLETED',
      FAILED: 'FAILED',
    },
  }),
  { virtual: true },
);

import { Types } from 'mongoose';
import { RunKind, RunStatus } from '../database/schemas';
import { WorkflowStep } from './workflow.constants';
import { WorkflowRunService } from './workflow-run.service';

describe('WorkflowRunService', () => {
  const makeService = () => {
    const workflowRunModel = {
      create: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      findById: jest.fn(),
    };
    const service = new WorkflowRunService(workflowRunModel as any);

    const userId = new Types.ObjectId().toString();
    const artifactId = new Types.ObjectId().toString();
    const runId = new Types.ObjectId().toString();

    const fixtures = {
      userId,
      artifactId,
      runId,
      input: {
        type: 'POST',
        withResearch: false,
        kind: RunKind.INITIAL,
        prompt: 'why staff engineers write',
        userId,
        artifactId,
        version: 1,
      },
    };

    return { service, mocks: { workflowRunModel }, fixtures };
  };

  let service: WorkflowRunService;
  let mocks: ReturnType<typeof makeService>['mocks'];
  let fixtures: ReturnType<typeof makeService>['fixtures'];

  beforeEach(() => {
    jest.clearAllMocks();
    ({ service, mocks, fixtures } = makeService());
  });

  describe('createRun', () => {
    it('should create a RUNNING run with a zeroed credit accumulator', async () => {
      await service.createRun({
        userId: fixtures.userId,
        artifactId: fixtures.artifactId,
        targetVersion: 1,
        kind: RunKind.INITIAL,
        input: fixtures.input as any,
      });

      expect(mocks.workflowRunModel.create).toHaveBeenCalledWith({
        user: expect.any(Types.ObjectId),
        artifact: expect.any(Types.ObjectId),
        targetVersion: 1,
        kind: RunKind.INITIAL,
        status: RunStatus.RUNNING,
        input: fixtures.input,
        creditsUsed: 0,
      });
    });
  });

  describe('getRun', () => {
    it('should load the run by id when the id is a valid ObjectId', async () => {
      const run = { _id: fixtures.runId };
      mocks.workflowRunModel.findById.mockResolvedValue(run);

      await expect(service.getRun(fixtures.runId)).resolves.toBe(run);
      expect(mocks.workflowRunModel.findById).toHaveBeenCalledWith(
        fixtures.runId,
      );
    });

    it('should return null without touching the model for a malformed id', async () => {
      await expect(service.getRun('not-an-object-id')).resolves.toBeNull();
      expect(mocks.workflowRunModel.findById).not.toHaveBeenCalled();
    });
  });

  describe('handleFor', () => {
    it('should bind the runId onto the handle', () => {
      expect(service.handleFor(fixtures.runId).runId).toBe(fixtures.runId);
    });

    it('should persist the current step at a boundary', async () => {
      await service
        .handleFor(fixtures.runId)
        .setCurrentStep(WorkflowStep.GENERATE);

      expect(mocks.workflowRunModel.updateOne).toHaveBeenCalledWith(
        { _id: expect.any(Types.ObjectId) },
        { $set: { currentStep: WorkflowStep.GENERATE } },
      );
    });

    it('should persist the research context so a later refine reuses it', async () => {
      const research = { findings: 'f', sources: [] };

      await service.handleFor(fixtures.runId).saveResearchContext(research);

      expect(mocks.workflowRunModel.updateOne).toHaveBeenCalledWith(
        { _id: expect.any(Types.ObjectId) },
        { $set: { researchContext: research } },
      );
    });

    it('should mark the run COMPLETED with the winning attempt total', async () => {
      await service.handleFor(fixtures.runId).complete(38);

      expect(mocks.workflowRunModel.updateOne).toHaveBeenCalledWith(
        { _id: expect.any(Types.ObjectId) },
        { $set: { status: RunStatus.COMPLETED, creditsUsed: 38 } },
      );
    });

    it('should mark the run FAILED with the reason', async () => {
      await service.handleFor(fixtures.runId).fail('insufficient credits');

      expect(mocks.workflowRunModel.updateOne).toHaveBeenCalledWith(
        { _id: expect.any(Types.ObjectId) },
        {
          $set: {
            status: RunStatus.FAILED,
            failureReason: 'insufficient credits',
          },
        },
      );
    });
  });
});
