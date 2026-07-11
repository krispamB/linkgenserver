jest.mock(
  '../auth/clerk/clerk-auth.guard',
  () => ({
    ClerkAuthGuard: class ClerkAuthGuard {},
  }),
  { virtual: true },
);
jest.mock('../common/decorators', () => ({ GetUser: () => () => undefined }), {
  virtual: true,
});
jest.mock('../database/schemas', () => ({ User: class User {} }), {
  virtual: true,
});
jest.mock(
  './artifact-generation.service',
  () => ({
    ArtifactGenerationService: class ArtifactGenerationService {},
  }),
  { virtual: true },
);
jest.mock(
  './dto',
  () => ({
    CreateArtifactDto: class CreateArtifactDto {},
    RefineArtifactDto: class RefineArtifactDto {},
  }),
  { virtual: true },
);

import { ArtifactController } from './artifact.controller';

describe('ArtifactController', () => {
  describe('refine', () => {
    it('should delegate the owner, artifact, and feedback when refining', async () => {
      const generation = {
        launchRefineRun: jest.fn().mockResolvedValue({
          artifactId: 'artifact-1',
          version: 2,
          runId: 'run-2',
        }),
      };
      const controller = new ArtifactController(generation as any);
      const user = { _id: { toString: () => 'user-1' } };

      await expect(
        controller.refine(user as any, 'artifact-1', {
          feedback: 'Make the hook sharper',
        }),
      ).resolves.toEqual({
        artifactId: 'artifact-1',
        version: 2,
        runId: 'run-2',
      });

      expect(generation.launchRefineRun).toHaveBeenCalledWith(
        'user-1',
        'artifact-1',
        'Make the hook sharper',
      );
    });
  });
});
