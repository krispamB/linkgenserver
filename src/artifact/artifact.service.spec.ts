jest.mock(
  'src/database/schemas',
  () => ({
    Artifact: { name: 'Artifact' },
    ArtifactType: { POST: 'POST', POLL: 'POLL', DOCUMENT: 'DOCUMENT' },
    VersionStatus: {
      GENERATING: 'GENERATING',
      READY: 'READY',
      FAILED: 'FAILED',
    },
    CarouselTheme: {
      BOLD: 'bold',
      MINIMAL: 'minimal',
      EDITORIAL: 'editorial',
      GRADIENT: 'gradient',
    },
  }),
  { virtual: true },
);

import { Types } from 'mongoose';
import { ArtifactType, VersionStatus } from 'src/database/schemas';
import { StylePreset } from '../agent/style-presets.config';
import { ArtifactService } from './artifact.service';

const makeService = () => {
  const artifactModel = {
    create: jest.fn(),
    findById: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
  };
  const service = new ArtifactService(artifactModel as any);

  const userId = new Types.ObjectId().toString();
  const artifactId = new Types.ObjectId().toString();
  const fixtures = {
    userId,
    artifactId,
    createInput: {
      type: ArtifactType.POST,
      prompt: 'Write about TDD',
      withResearch: false,
    },
  };
  return { service, mocks: { artifactModel }, fixtures };
};

let service: ArtifactService;
let mocks: ReturnType<typeof makeService>['mocks'];
let fixtures: ReturnType<typeof makeService>['fixtures'];

beforeEach(() => {
  jest.clearAllMocks();
  ({ service, mocks, fixtures } = makeService());
});

describe('ArtifactService', () => {
  describe('createArtifact', () => {
    it('should create the artifact with version 1 GENERATING when given a prompt', async () => {
      const created = { _id: new Types.ObjectId() };
      mocks.artifactModel.create.mockResolvedValue(created);

      await expect(
        service.createArtifact(fixtures.userId, fixtures.createInput),
      ).resolves.toBe(created);

      expect(mocks.artifactModel.create).toHaveBeenCalledTimes(1);
      expect(mocks.artifactModel.create).toHaveBeenCalledWith({
        user: new Types.ObjectId(fixtures.userId),
        type: ArtifactType.POST,
        source: { prompt: 'Write about TDD', withResearch: false },
        currentVersion: 1,
        versions: [
          { version: 1, status: VersionStatus.GENERATING, content: {} },
        ],
      });
    });

    it('should stamp stylePreset onto the source when provided', async () => {
      mocks.artifactModel.create.mockResolvedValue({});

      await service.createArtifact(fixtures.userId, {
        ...fixtures.createInput,
        stylePreset: StylePreset.BOLD,
      });

      expect(mocks.artifactModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          source: {
            prompt: 'Write about TDD',
            withResearch: false,
            stylePreset: 'bold',
          },
        }),
      );
    });
  });

  describe('setVersionContent', () => {
    const generatingArtifact = () => ({
      _id: fixtures.artifactId,
      type: ArtifactType.POST,
      versions: [{ version: 1, status: VersionStatus.GENERATING, content: {} }],
    });

    it('should validate the content and flip the version to READY when the version exists', async () => {
      mocks.artifactModel.findById.mockResolvedValue(generatingArtifact());

      await service.setVersionContent(fixtures.artifactId, 1, {
        commentary: 'A finished post 🎉',
      });

      expect(mocks.artifactModel.updateOne).toHaveBeenCalledWith(
        { _id: fixtures.artifactId, 'versions.version': 1 },
        {
          $set: {
            'versions.$.content': { commentary: 'A finished post 🎉' },
            'versions.$.status': VersionStatus.READY,
          },
        },
      );
    });

    it('should reject with a ZodError and not write when the commentary exceeds 3000 characters', async () => {
      mocks.artifactModel.findById.mockResolvedValue(generatingArtifact());

      await expect(
        service.setVersionContent(fixtures.artifactId, 1, {
          commentary: 'a'.repeat(3001),
        }),
      ).rejects.toMatchObject({ name: 'ZodError' });
      expect(mocks.artifactModel.updateOne).not.toHaveBeenCalled();
    });

    it('should ignore render when the artifact is not a DOCUMENT', async () => {
      mocks.artifactModel.findById.mockResolvedValue(generatingArtifact());

      await service.setVersionContent(
        fixtures.artifactId,
        1,
        { commentary: 'Plain post' },
        { pdfKey: 'renders/x.pdf', pageCount: 5 },
      );

      expect(mocks.artifactModel.updateOne).toHaveBeenCalledWith(
        expect.anything(),
        {
          $set: {
            'versions.$.content': { commentary: 'Plain post' },
            'versions.$.status': VersionStatus.READY,
          },
        },
      );
    });

    it('should throw NotFoundException when the artifact does not exist', async () => {
      mocks.artifactModel.findById.mockResolvedValue(null);

      await expect(
        service.setVersionContent(fixtures.artifactId, 1, {
          commentary: 'x',
        }),
      ).rejects.toMatchObject({ name: 'NotFoundException' });
      expect(mocks.artifactModel.updateOne).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when the artifact is soft-deleted', async () => {
      mocks.artifactModel.findById.mockResolvedValue({
        ...generatingArtifact(),
        deletedAt: new Date(),
      });

      await expect(
        service.setVersionContent(fixtures.artifactId, 1, {
          commentary: 'x',
        }),
      ).rejects.toMatchObject({ name: 'NotFoundException' });
      expect(mocks.artifactModel.updateOne).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when the version does not exist on the artifact', async () => {
      mocks.artifactModel.findById.mockResolvedValue(generatingArtifact());

      await expect(
        service.setVersionContent(fixtures.artifactId, 2, {
          commentary: 'x',
        }),
      ).rejects.toMatchObject({ name: 'NotFoundException' });
      expect(mocks.artifactModel.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('failVersion', () => {
    const generatingArtifact = () => ({
      _id: fixtures.artifactId,
      type: ArtifactType.POST,
      versions: [{ version: 1, status: VersionStatus.GENERATING, content: {} }],
    });

    it('should flip the version to FAILED with the reason when the version exists', async () => {
      mocks.artifactModel.findById.mockResolvedValue(generatingArtifact());

      await service.failVersion(fixtures.artifactId, 1, 'insufficient credits');

      expect(mocks.artifactModel.updateOne).toHaveBeenCalledWith(
        { _id: fixtures.artifactId, 'versions.version': 1 },
        {
          $set: {
            'versions.$.status': VersionStatus.FAILED,
            'versions.$.failureReason': 'insufficient credits',
          },
        },
      );
    });

    it('should preserve the version rather than remove it, so the user can refine from it', async () => {
      mocks.artifactModel.findById.mockResolvedValue(generatingArtifact());

      await service.failVersion(fixtures.artifactId, 1, 'zod invalid');

      const [, update] = mocks.artifactModel.updateOne.mock.calls[0] as [
        unknown,
        { $set: Record<string, unknown> },
      ];
      expect(update.$set).not.toHaveProperty('versions.$.content');
    });

    it('should throw NotFoundException when the artifact does not exist', async () => {
      mocks.artifactModel.findById.mockResolvedValue(null);

      await expect(
        service.failVersion(fixtures.artifactId, 1, 'boom'),
      ).rejects.toMatchObject({ name: 'NotFoundException' });
      expect(mocks.artifactModel.updateOne).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when the version does not exist on the artifact', async () => {
      mocks.artifactModel.findById.mockResolvedValue(generatingArtifact());

      await expect(
        service.failVersion(fixtures.artifactId, 2, 'boom'),
      ).rejects.toMatchObject({ name: 'NotFoundException' });
      expect(mocks.artifactModel.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('readCurrent', () => {
    it('should return the current version content when the artifact exists', async () => {
      mocks.artifactModel.findById.mockResolvedValue({
        _id: fixtures.artifactId,
        type: ArtifactType.POST,
        currentVersion: 2,
        versions: [
          {
            version: 1,
            status: VersionStatus.READY,
            content: { commentary: 'old' },
          },
          {
            version: 2,
            status: VersionStatus.READY,
            content: { commentary: 'new' },
          },
        ],
      });

      await expect(service.readCurrent(fixtures.artifactId)).resolves.toEqual({
        type: ArtifactType.POST,
        version: 2,
        content: { commentary: 'new' },
      });
    });

    it('should throw NotFoundException when the artifact does not exist', async () => {
      mocks.artifactModel.findById.mockResolvedValue(null);

      await expect(
        service.readCurrent(fixtures.artifactId),
      ).rejects.toMatchObject({ name: 'NotFoundException' });
    });

    it('should throw NotFoundException when the artifact is soft-deleted', async () => {
      mocks.artifactModel.findById.mockResolvedValue({
        _id: fixtures.artifactId,
        type: ArtifactType.POST,
        currentVersion: 1,
        versions: [
          {
            version: 1,
            status: VersionStatus.READY,
            content: { commentary: 'x' },
          },
        ],
        deletedAt: new Date(),
      });

      await expect(
        service.readCurrent(fixtures.artifactId),
      ).rejects.toMatchObject({ name: 'NotFoundException' });
    });
  });
});
