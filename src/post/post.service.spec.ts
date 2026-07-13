import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';

jest.mock(
  'src/database/schemas',
  () => ({
    AccountProvider: { LINKEDIN: 'LINKEDIN' },
    LinkedinAccountType: { PERSON: 'PERSON', ORGANIZATION: 'ORGANIZATION' },
    ConnectedAccount: { name: 'ConnectedAccount' },
    Artifact: { name: 'Artifact' },
    ArtifactType: { POST: 'POST', POLL: 'POLL', DOCUMENT: 'DOCUMENT' },
    VersionStatus: {
      GENERATING: 'GENERATING',
      READY: 'READY',
      FAILED: 'FAILED',
    },
    Post: { name: 'Post' },
    PostStatus: {
      SCHEDULED: 'SCHEDULED',
      PUBLISHED: 'PUBLISHED',
      FAILED: 'FAILED',
    },
    PostDraft: { name: 'PostDraft' },
    PostDraftStatus: {
      DRAFT: 'DRAFT',
      SCHEDULED: 'SCHEDULED',
      PUBLISHED: 'PUBLISHED',
    },
    User: { name: 'User' },
  }),
  { virtual: true },
);
jest.mock(
  'src/common/HelperFn/apiFetch.helper',
  () => ({
    apiFetch: jest.fn(),
    ApiError: class ApiError extends Error {},
  }),
  { virtual: true },
);
jest.mock('src/common/HelperFn', () => ({ formatLinkedinContent: jest.fn() }), {
  virtual: true,
});
jest.mock(
  'src/encryption/encryption.service',
  () => ({ EncryptionService: class EncryptionService {} }),
  { virtual: true },
);
jest.mock(
  '../feature-gating/feature-gating.service',
  () => ({ FeatureGatingService: class FeatureGatingService {} }),
  { virtual: true },
);
jest.mock(
  'src/s3',
  () => ({
    uploadFile: jest.fn(),
    deleteFile: jest.fn(),
    getSignedUploadUrl: jest.fn(),
    headFile: jest.fn(),
    getFile: jest.fn(),
  }),
  { virtual: true },
);
jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('file-bytes')),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

import { PostService } from './post.service';
import { deleteFile, getSignedUploadUrl, headFile, uploadFile } from 'src/s3';
import { getFile } from 'src/s3';
import { unlink } from 'fs/promises';
import { apiFetch } from 'src/common/HelperFn/apiFetch.helper';
import { formatLinkedinContent } from 'src/common/HelperFn';

describe('PostService.getPosts', () => {
  const createService = () => {
    const service = Object.create(PostService.prototype) as PostService;

    const exec = jest.fn();
    const lean = jest.fn().mockReturnValue({ exec });
    const limit = jest.fn().mockReturnValue({ lean });
    const skip = jest.fn().mockReturnValue({ limit });
    const sort = jest.fn().mockReturnValue({ skip });
    const find = jest.fn().mockReturnValue({ sort });
    const aggregate = jest.fn();
    const distinct = jest.fn();

    (service as any).postModel = {
      find,
      aggregate,
      distinct,
    };

    return {
      service,
      mocks: {
        find,
        sort,
        skip,
        limit,
        lean,
        exec,
        aggregate,
        distinct,
      },
    };
  };

  it('returns filtered posts in data and filter metadata for the user', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const connectedAccountId = new Types.ObjectId();

    const posts = [{ _id: new Types.ObjectId(), content: 'post 1' }] as any[];
    mocks.exec.mockResolvedValue(posts);
    mocks.aggregate.mockResolvedValue([
      { month: '2026-02' },
      { month: '2026-01' },
    ]);
    mocks.distinct.mockResolvedValue([connectedAccountId]);

    const result = await service.getPosts(
      { _id: userId } as any,
      connectedAccountId.toString(),
      'SCHEDULED',
      '2026-01',
      2,
    );

    expect(mocks.find).toHaveBeenCalledTimes(1);
    expect(mocks.skip).toHaveBeenCalledWith(20);
    expect(mocks.limit).toHaveBeenCalledWith(20);
    expect(mocks.lean).toHaveBeenCalledTimes(1);
    const filter = mocks.find.mock.calls[0][0];
    expect(filter.user).toEqual(userId);
    expect(filter.status).toBe('SCHEDULED');
    expect(filter.connectedAccount).toEqual(connectedAccountId);
    expect(filter.updatedAt.$gte).toEqual(new Date(2026, 0, 1));
    expect(filter.updatedAt.$lt).toEqual(new Date(2026, 1, 1));

    expect(mocks.aggregate).toHaveBeenCalledWith([
      { $match: { user: userId } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m',
              date: '$createdAt',
            },
          },
        },
      },
      { $sort: { _id: -1 } },
      { $project: { _id: 0, month: '$_id' } },
    ]);
    expect(mocks.distinct).toHaveBeenCalledWith('connectedAccount', {
      user: userId,
    });

    expect(result).toEqual({
      data: posts,
      filters: {
        availableMonths: ['2026-02', '2026-01'],
        connectedAccountIds: [connectedAccountId.toString()],
      },
    });
  });

  it('returns empty lists when user has no posts', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();

    mocks.exec.mockResolvedValue([]);
    mocks.aggregate.mockResolvedValue([]);
    mocks.distinct.mockResolvedValue([]);

    const result = await service.getPosts({ _id: userId } as any);

    expect(result).toEqual({
      data: [],
      filters: {
        availableMonths: [],
        connectedAccountIds: [],
      },
    });
  });
});

describe('PostService.getPost', () => {
  it('should resolve the pinned artifact version when the post is owned', async () => {
    const service = Object.create(PostService.prototype) as PostService;
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const artifactId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      artifacts: [{ artifact: artifactId, version: 1 }],
      toObject: () => ({
        _id: postId,
        user: userId,
        artifacts: [{ artifact: artifactId, version: 1 }],
      }),
    };
    const approvedVersion = {
      version: 1,
      status: 'READY',
      content: { commentary: 'Approved copy' },
    };
    const artifact = {
      _id: artifactId,
      type: 'POST',
      versions: [
        approvedVersion,
        { version: 2, status: 'READY', content: { commentary: 'New copy' } },
      ],
      toObject: () => ({
        _id: artifactId,
        type: 'POST',
        versions: [approvedVersion],
      }),
    };
    const findPostById = jest.fn().mockResolvedValue(post);
    const findArtifactById = jest.fn().mockResolvedValue(artifact);
    Object.assign(service as any, {
      postModel: { findById: findPostById },
      artifactModel: { findById: findArtifactById },
    });

    const result = await service.getPost(
      { _id: userId } as any,
      postId.toString(),
    );

    expect(findArtifactById).toHaveBeenCalledWith(artifactId);
    expect(result.artifacts).toEqual([
      {
        artifact: { _id: artifactId, type: 'POST' },
        version: approvedVersion,
      },
    ]);
  });
});

describe('PostService.getPostMetrics', () => {
  it('should aggregate post counts when the connected account is owned', async () => {
    const service = Object.create(PostService.prototype) as PostService;
    const userId = new Types.ObjectId();
    const accountId = new Types.ObjectId();
    const aggregate = jest.fn().mockResolvedValue([
      { month: '2026-05', count: 2 },
      { month: '2026-06', count: 1 },
    ]);
    Object.assign(service as any, {
      connectedAccountModel: {
        findById: jest.fn().mockResolvedValue({ user: userId }),
      },
      postModel: { aggregate },
    });

    const result = await service.getPostMetrics(
      { _id: userId } as any,
      accountId.toString(),
    );

    expect(aggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          $match: expect.objectContaining({
            user: userId,
            connectedAccount: accountId,
          }),
        }),
      ]),
    );
    expect(result).toEqual({
      total: 3,
      monthly: [
        { month: '2026-05', count: 2 },
        { month: '2026-06', count: 1 },
      ],
    });
  });
});

describe('PostService.createDraft', () => {
  it('checks AI draft quota and increments usage after successful creation', async () => {
    const service = Object.create(PostService.prototype) as PostService;
    const userId = new Types.ObjectId();
    const save = jest.fn().mockResolvedValue(undefined);
    const draftId = new Types.ObjectId();
    const postDraftModel = jest.fn().mockImplementation(() => ({
      _id: draftId,
      save,
    }));
    const addWorkflowJob = jest.fn().mockResolvedValue(undefined);
    const connectedAccountFindById = jest.fn().mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
    });

    (service as any).postDraftModel = postDraftModel;
    (service as any).connectedAccountModel = {
      findById: connectedAccountFindById,
    };
    (service as any).workflowQueue = { addWorkflowJob };

    const user = { _id: userId } as any;
    const accountId = new Types.ObjectId().toString();
    const dto = {
      input: 'test prompt',
      contentType: 'quickPostLinkedin',
    } as any;

    const workflowId = await service.createDraft(user, accountId, dto);

    expect(addWorkflowJob).toHaveBeenCalledWith(workflowId, {
      workflowName: dto.contentType,
      input: dto,
    });
    expect(save).toHaveBeenCalled();
  });

  it('propagates the failure when draft creation workflow enqueue fails', async () => {
    const service = Object.create(PostService.prototype) as PostService;
    const save = jest.fn().mockResolvedValue(undefined);
    const draftId = new Types.ObjectId();
    const postDraftModel = jest.fn().mockImplementation(() => ({
      _id: draftId,
      save,
    }));
    const addWorkflowJob = jest
      .fn()
      .mockRejectedValue(new Error('queue unavailable'));
    const userId = new Types.ObjectId();
    const connectedAccountFindById = jest.fn().mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
    });

    (service as any).postDraftModel = postDraftModel;
    (service as any).connectedAccountModel = {
      findById: connectedAccountFindById,
    };
    (service as any).workflowQueue = { addWorkflowJob };

    const user = { _id: userId } as any;
    const accountId = new Types.ObjectId().toString();
    const dto = {
      input: 'test prompt',
      contentType: 'quickPostLinkedin',
    } as any;

    await expect(service.createDraft(user, accountId, dto)).rejects.toThrow(
      'queue unavailable',
    );
  });

  it('persists provided style preset on draft creation', async () => {
    const service = Object.create(PostService.prototype) as PostService;
    const userId = new Types.ObjectId();
    const draftId = new Types.ObjectId();
    const save = jest.fn().mockResolvedValue(undefined);
    const postDraftModel = jest.fn().mockImplementation(() => ({
      _id: draftId,
      save,
    }));
    const addWorkflowJob = jest.fn().mockResolvedValue(undefined);
    const connectedAccountFindById = jest.fn().mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
    });

    (service as any).postDraftModel = postDraftModel;
    (service as any).connectedAccountModel = {
      findById: connectedAccountFindById,
    };
    (service as any).workflowQueue = { addWorkflowJob };

    const user = { _id: userId } as any;
    const accountId = new Types.ObjectId().toString();
    const dto = {
      input: 'test prompt',
      contentType: 'quickPostLinkedin',
      stylePreset: 'storytelling',
    } as any;

    await service.createDraft(user, accountId, dto);

    expect(postDraftModel).toHaveBeenCalledWith(
      expect.objectContaining({
        stylePreset: 'storytelling',
      }),
    );
  });
});

describe('PostService.schedulePost', () => {
  const createService = () => {
    const service = Object.create(PostService.prototype) as PostService;
    const findById = jest.fn();
    const findConnectedAccountById = jest.fn();
    const save = jest.fn().mockResolvedValue(undefined);
    const addScheduleJob = jest.fn().mockResolvedValue(undefined);
    const getJob = jest.fn();
    const assertScheduledPostQuota = jest.fn().mockResolvedValue(undefined);
    const incrementScheduledPostUsage = jest.fn().mockResolvedValue(undefined);
    const hasScheduledPostUsage = jest.fn().mockResolvedValue(false);

    (service as any).postModel = {
      findById,
    };
    (service as any).scheduleQueue = {
      addScheduleJob,
      queue: {
        getJob,
      },
    };
    (service as any).connectedAccountModel = {
      findById: findConnectedAccountById,
    };
    (service as any).featureGatingService = {
      assertScheduledPostQuota,
      incrementScheduledPostUsage,
      hasScheduledPostUsage,
    };

    return {
      service,
      mocks: {
        findById,
        findConnectedAccountById,
        save,
        addScheduleJob,
        getJob,
        assertScheduledPostQuota,
        incrementScheduledPostUsage,
        hasScheduledPostUsage,
      },
    };
  };

  it('should charge first-time scheduling usage when a FAILED post is scheduled', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const scheduledAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'FAILED',
      scheduledPostUsageCounted: false,
      save: mocks.save,
    } as any;

    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
    });

    const result = await service.schedulePost(
      { _id: userId } as any,
      postId.toString(),
      { scheduledAt } as any,
    );

    expect(mocks.getJob).toHaveBeenCalledWith(postId.toString());
    expect(mocks.assertScheduledPostQuota).toHaveBeenCalledWith(
      userId.toString(),
    );
    expect(mocks.addScheduleJob).toHaveBeenCalledWith(
      postId.toString(),
      userId.toString(),
      expect.any(Number),
    );
    expect(mocks.incrementScheduledPostUsage).toHaveBeenCalledWith(
      userId.toString(),
      postId.toString(),
    );
    expect(post.status).toBe('SCHEDULED');
    expect(post.scheduledAt).toEqual(new Date(scheduledAt));
    expect(post.scheduledPostUsageCounted).toBe(true);
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(result).toBe(post);
  });

  it('should avoid recharging when prior usage exists without a persisted post marker', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const scheduledAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'FAILED',
      scheduledPostUsageCounted: false,
      save: mocks.save,
    } as any;
    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
    });
    mocks.hasScheduledPostUsage.mockResolvedValue(true);

    await service.schedulePost({ _id: userId } as any, postId.toString(), {
      scheduledAt,
    } as any);

    expect(mocks.assertScheduledPostQuota).not.toHaveBeenCalled();
    expect(mocks.incrementScheduledPostUsage).not.toHaveBeenCalled();
    expect(post.scheduledPostUsageCounted).toBe(true);
  });

  it('reschedules a scheduled post by removing the existing job first', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const remove = jest.fn().mockResolvedValue(undefined);
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'SCHEDULED',
      save: mocks.save,
    } as any;

    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
    });
    mocks.getJob.mockResolvedValue({ remove });

    await service.schedulePost({ _id: userId } as any, postId.toString(), {
      scheduledAt,
    } as any);

    expect(mocks.assertScheduledPostQuota).not.toHaveBeenCalled();
    expect(mocks.getJob).toHaveBeenCalledWith(postId.toString());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(mocks.addScheduleJob).toHaveBeenCalledWith(
      postId.toString(),
      userId.toString(),
      expect.any(Number),
    );
    expect(mocks.incrementScheduledPostUsage).not.toHaveBeenCalled();
    expect(post.scheduledAt).toEqual(new Date(scheduledAt));
  });

  it('reschedules even when the old scheduled job is already missing', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'SCHEDULED',
      scheduledPostUsageCounted: true,
      save: mocks.save,
    } as any;

    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
    });
    mocks.getJob.mockResolvedValue(null);

    await service.schedulePost({ _id: userId } as any, postId.toString(), {
      scheduledAt,
    } as any);

    expect(mocks.assertScheduledPostQuota).not.toHaveBeenCalled();
    expect(mocks.getJob).toHaveBeenCalledWith(postId.toString());
    expect(mocks.addScheduleJob).toHaveBeenCalledTimes(1);
    expect(mocks.incrementScheduledPostUsage).not.toHaveBeenCalled();
  });

  it('fails rescheduling if removing previous scheduled job throws', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const remove = jest.fn().mockRejectedValue(new Error('remove failed'));
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'SCHEDULED',
      scheduledPostUsageCounted: true,
      save: mocks.save,
    } as any;

    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
    });
    mocks.getJob.mockResolvedValue({ remove });

    await expect(
      service.schedulePost({ _id: userId } as any, postId.toString(), {
        scheduledAt,
      } as any),
    ).rejects.toThrow('remove failed');
    expect(mocks.assertScheduledPostQuota).not.toHaveBeenCalled();
    expect(mocks.addScheduleJob).not.toHaveBeenCalled();
    expect(mocks.incrementScheduledPostUsage).not.toHaveBeenCalled();
  });

  it('still rejects scheduling for published posts', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'PUBLISHED',
      save: mocks.save,
    } as any;

    mocks.findById.mockResolvedValue(post);

    await expect(
      service.schedulePost({ _id: userId } as any, postId.toString(), {
        scheduledAt,
      } as any),
    ).rejects.toThrow('Post is already published');
    expect(mocks.assertScheduledPostQuota).not.toHaveBeenCalled();
    expect(mocks.addScheduleJob).not.toHaveBeenCalled();
    expect(mocks.incrementScheduledPostUsage).not.toHaveBeenCalled();
  });

  it('still rejects scheduling in the past', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const scheduledAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'FAILED',
      scheduledPostUsageCounted: false,
      save: mocks.save,
    } as any;

    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
    });

    await expect(
      service.schedulePost({ _id: userId } as any, postId.toString(), {
        scheduledAt,
      } as any),
    ).rejects.toThrow('Scheduled time must be in the future');
    expect(mocks.assertScheduledPostQuota).not.toHaveBeenCalled();
    expect(mocks.addScheduleJob).not.toHaveBeenCalled();
    expect(mocks.incrementScheduledPostUsage).not.toHaveBeenCalled();
  });

  it('does not increment scheduling usage when queue enqueue fails', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'FAILED',
      scheduledPostUsageCounted: false,
      save: mocks.save,
    } as any;

    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
    });
    mocks.addScheduleJob.mockRejectedValue(new Error('queue unavailable'));

    await expect(
      service.schedulePost({ _id: userId } as any, postId.toString(), {
        scheduledAt,
      } as any),
    ).rejects.toThrow('queue unavailable');
    expect(mocks.assertScheduledPostQuota).toHaveBeenCalledWith(
      userId.toString(),
    );
    expect(mocks.incrementScheduledPostUsage).not.toHaveBeenCalled();
  });
});

describe('PostService artifact publishing', () => {
  const makeService = () => {
    const service = Object.create(PostService.prototype) as PostService;
    const userId = new Types.ObjectId();
    const artifactId = new Types.ObjectId();
    const accountId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const save = jest.fn().mockResolvedValue(undefined);
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: accountId,
      artifacts: [{ artifact: artifactId, version: 1 }],
      status: 'SCHEDULED',
      save,
    } as any;
    const artifact = {
      _id: artifactId,
      user: userId,
      type: 'POST',
      currentVersion: 1,
      versions: [
        {
          version: 1,
          status: 'READY',
          content: { commentary: 'Approved text' },
        },
      ],
    } as any;
    const account = {
      _id: accountId,
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted',
      accountType: 'PERSON',
      externalId: 'person-1',
      profileMetadata: {},
    };
    const mocks = {
      postModel: jest
        .fn()
        .mockImplementation((values) => Object.assign(post, values)),
      findPostById: jest.fn().mockResolvedValue(post),
      findArtifactById: jest.fn().mockResolvedValue(artifact),
      findAccountById: jest.fn().mockResolvedValue(account),
      addScheduleJob: jest.fn().mockResolvedValue(undefined),
      getScheduleJob: jest.fn().mockResolvedValue(null),
      assertScheduledPostQuota: jest.fn().mockResolvedValue(undefined),
      incrementScheduledPostUsage: jest.fn().mockResolvedValue(undefined),
      hasScheduledPostUsage: jest.fn().mockResolvedValue(false),
      assertCompanyPagesAccess: jest.fn().mockResolvedValue(undefined),
      decrypt: jest.fn().mockResolvedValue('token'),
      uploadDocument: jest.fn().mockResolvedValue('urn:li:document:1'),
    };
    Object.assign(service as any, {
      postModel: Object.assign(mocks.postModel, {
        findById: mocks.findPostById,
      }),
      artifactModel: { findById: mocks.findArtifactById },
      connectedAccountModel: { findById: mocks.findAccountById },
      scheduleQueue: {
        addScheduleJob: mocks.addScheduleJob,
        queue: { getJob: mocks.getScheduleJob },
      },
      featureGatingService: {
        assertScheduledPostQuota: mocks.assertScheduledPostQuota,
        incrementScheduledPostUsage: mocks.incrementScheduledPostUsage,
        hasScheduledPostUsage: mocks.hasScheduledPostUsage,
        assertCompanyPagesAccess: mocks.assertCompanyPagesAccess,
      },
      encryptionService: { decrypt: mocks.decrypt },
      linkedinMediaService: { uploadDocument: mocks.uploadDocument },
      LINKEDIN_API_BASE: 'https://api.linkedin.com/rest',
      logger: { error: jest.fn() },
    });
    return {
      service,
      mocks,
      fixtures: { userId, artifactId, accountId, postId, post, artifact },
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (apiFetch as jest.Mock).mockResolvedValue({
      response: {
        headers: { get: jest.fn().mockReturnValue('urn:li:share:123') },
      },
    });
    (formatLinkedinContent as jest.Mock).mockImplementation(
      (value: string) => value,
    );
  });

  describe('createPost', () => {
    it('should pin and publish the READY artifact version when scheduledAt is absent', async () => {
      const { service, mocks, fixtures } = makeService();
      const publishedDocument = {
        ...fixtures.post,
        save: jest.fn().mockResolvedValue(undefined),
      };
      mocks.findPostById.mockResolvedValueOnce(publishedDocument);

      const result = await service.createPost({ _id: fixtures.userId } as any, {
        artifactId: fixtures.artifactId.toString(),
        connectedAccount: fixtures.accountId.toString(),
      });

      expect(mocks.postModel).toHaveBeenCalledWith(
        expect.objectContaining({
          artifacts: [{ artifact: fixtures.artifactId, version: 1 }],
          connectedAccount: fixtures.accountId,
        }),
      );
      expect(result.status).toBe('PUBLISHED');
      expect(result.channelPostId).toBe('urn:li:share:123');
      expect(result).toBe(publishedDocument);
      expect(mocks.assertScheduledPostQuota).not.toHaveBeenCalled();
      expect(mocks.incrementScheduledPostUsage).not.toHaveBeenCalled();
    });

    it('should reject a GENERATING artifact version', async () => {
      const { service, fixtures } = makeService();
      fixtures.artifact.versions[0].status = 'GENERATING';

      await expect(
        service.createPost({ _id: fixtures.userId } as any, {
          artifactId: fixtures.artifactId.toString(),
          connectedAccount: fixtures.accountId.toString(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should reject an artifact owned by another user', async () => {
      const { service, fixtures } = makeService();
      fixtures.artifact.user = new Types.ObjectId();

      await expect(
        service.createPost({ _id: fixtures.userId } as any, {
          artifactId: fixtures.artifactId.toString(),
          connectedAccount: fixtures.accountId.toString(),
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('should schedule a pinned version and count usage when scheduledAt is present', async () => {
      const { service, mocks, fixtures } = makeService();
      const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const result = await service.createPost({ _id: fixtures.userId } as any, {
        artifactId: fixtures.artifactId.toString(),
        connectedAccount: fixtures.accountId.toString(),
        scheduledAt,
      });

      expect(mocks.assertScheduledPostQuota).toHaveBeenCalledWith(
        fixtures.userId.toString(),
      );
      expect(mocks.addScheduleJob).toHaveBeenCalledWith(
        fixtures.postId.toString(),
        fixtures.userId.toString(),
        expect.any(Number),
      );
      expect(mocks.incrementScheduledPostUsage).toHaveBeenCalledWith(
        fixtures.userId.toString(),
        fixtures.postId.toString(),
      );
      expect(result.scheduledPostUsageCounted).toBe(true);
      expect(apiFetch).not.toHaveBeenCalled();
    });
  });

  describe('publishPost', () => {
    it('should publish commentary from the pinned POST version without a content object', async () => {
      const { service, fixtures } = makeService();

      await service.publishPost(fixtures.postId.toString());

      const request = (apiFetch as jest.Mock).mock.calls[0][1];
      expect(JSON.parse(request.body)).toMatchObject({
        commentary: 'Approved text',
      });
      expect(JSON.parse(request.body).content).toBeUndefined();
      expect(fixtures.post.status).toBe('PUBLISHED');
    });

    it('should publish inline poll content without uploading media when the artifact is a POLL', async () => {
      const { service, mocks, fixtures } = makeService();
      fixtures.artifact.type = 'POLL';
      fixtures.artifact.versions[0].content = {
        commentary: 'Choose one',
        poll: {
          question: 'Best day?',
          options: ['Monday', 'Friday'],
          durationDays: 7,
        },
      };

      await service.publishPost(fixtures.postId.toString());

      const body = JSON.parse((apiFetch as jest.Mock).mock.calls[0][1].body);
      expect(body.content).toEqual({
        poll: {
          question: 'Best day?',
          options: [{ text: 'Monday' }, { text: 'Friday' }],
          settings: {
            duration: 'SEVEN_DAYS',
            voteSelectionType: 'SINGLE_VOTE',
            isVoterVisibleToAuthor: true,
          },
        },
      });
      expect(mocks.uploadDocument).not.toHaveBeenCalled();
    });

    it('should upload pinned PDF bytes and publish the returned urn when the artifact is a DOCUMENT', async () => {
      const { service, mocks, fixtures } = makeService();
      const pdf = Buffer.from('rendered-pdf');
      fixtures.artifact.type = 'DOCUMENT';
      fixtures.artifact.versions[0].content = {
        commentary: 'Swipe through',
        document: {
          templateId: 'bold',
          slides: [
            { type: 'cover', fields: { title: 'First slide' } },
            { type: 'cta', fields: { headline: 'Go', action: 'Try it' } },
          ],
          pdfKey: 'artifacts/deck/1/document.pdf',
          pageCount: 8,
        },
      };
      (getFile as jest.Mock).mockResolvedValue(pdf);

      await service.publishPost(fixtures.postId.toString());

      expect(getFile).toHaveBeenCalledWith('artifacts/deck/1/document.pdf');
      expect(mocks.uploadDocument).toHaveBeenCalledWith(
        'urn:li:person:person-1',
        'token',
        pdf,
        8,
      );
      const postCall = (apiFetch as jest.Mock).mock.calls.at(-1);
      expect(JSON.parse(postCall[1].body).content).toEqual({
        media: { id: 'urn:li:document:1', title: 'First slide' },
      });
    });

    it('should fail safely when the pinned version is unavailable', async () => {
      const { service, fixtures } = makeService();
      fixtures.artifact.versions = [];

      await expect(
        service.publishPost(fixtures.postId.toString()),
      ).rejects.toThrow('source artifact unavailable');
      expect(fixtures.post.status).toBe('FAILED');
      expect(fixtures.post.failureReason).toBe('source artifact unavailable');
      expect(apiFetch).not.toHaveBeenCalled();
    });

    it('should persist FAILED when account token decryption fails', async () => {
      const { service, mocks, fixtures } = makeService();
      mocks.decrypt.mockRejectedValue(new Error('decrypt failed'));

      await expect(
        service.publishPost(fixtures.postId.toString()),
      ).rejects.toThrow('Failed to publish post');
      expect(fixtures.post.status).toBe('FAILED');
      expect(fixtures.post.failureReason).toBe('Failed to publish post');
    });
  });

  describe('publishPostNow', () => {
    it('should remove the pending job when publishing an owned SCHEDULED post', async () => {
      const { service, mocks, fixtures } = makeService();
      const remove = jest.fn().mockResolvedValue(undefined);
      mocks.getScheduleJob.mockResolvedValue({ remove });

      const result = await service.publishPostNow(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
      );

      expect(mocks.getScheduleJob).toHaveBeenCalledWith(
        fixtures.postId.toString(),
      );
      expect(remove).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('PUBLISHED');
    });

    it('should reject publish-now when the post belongs to another user', async () => {
      const { service, mocks, fixtures } = makeService();

      await expect(
        service.publishPostNow(
          { _id: new Types.ObjectId() } as any,
          fixtures.postId.toString(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.getScheduleJob).not.toHaveBeenCalled();
      expect(apiFetch).not.toHaveBeenCalled();
    });
  });
});

describe('PostService.publishOnLinkedIn', () => {
  const createService = () => {
    const service = Object.create(PostService.prototype) as PostService;
    const findById = jest.fn();
    const save = jest.fn().mockResolvedValue(undefined);
    const findConnectedAccountById = jest.fn().mockResolvedValue({
      user: new Types.ObjectId(),
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
      accountType: 'PERSON',
      impersonatorUrn: 'urn:li:person:abc',
      profileMetadata: {},
    });
    const decrypt = jest.fn().mockResolvedValue('token');
    const mockedApiFetch = apiFetch as jest.Mock;

    mockedApiFetch.mockResolvedValue({
      response: {
        headers: {
          get: jest.fn().mockReturnValue('urn:li:share:123'),
        },
      },
    });
    (formatLinkedinContent as jest.Mock).mockImplementation(
      (text: string) => text,
    );

    (service as any).postDraftModel = {
      findById,
    };
    (service as any).connectedAccountModel = {
      findById: findConnectedAccountById,
    };
    (service as any).encryptionService = {
      decrypt,
    };
    (service as any).LINKEDIN_API_BASE = 'https://api.linkedin.com/rest';

    return {
      service,
      mocks: {
        findById,
        save,
        findConnectedAccountById,
        decrypt,
        mockedApiFetch,
      },
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('publishes successfully when media is an empty array', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'SCHEDULED',
      content: 'text only',
      media: [],
      save: mocks.save,
    } as any;
    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
      accountType: 'PERSON',
      impersonatorUrn: 'urn:li:person:abc',
      profileMetadata: {},
    });

    await expect(
      service.publishOnLinkedIn({ _id: userId } as any, postId.toString()),
    ).resolves.toBeUndefined();

    expect(mocks.mockedApiFetch).toHaveBeenCalledTimes(1);
    const request = mocks.mockedApiFetch.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body.content).toBeUndefined();
    expect(body.commentary).toBe('text only');
    expect(post.status).toBe('PUBLISHED');
  });

  it('publishes successfully when media is undefined', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'SCHEDULED',
      content: 'text only',
      save: mocks.save,
    } as any;
    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
      accountType: 'PERSON',
      impersonatorUrn: 'urn:li:person:abc',
      profileMetadata: {},
    });

    await expect(
      service.publishOnLinkedIn({ _id: userId } as any, postId.toString()),
    ).resolves.toBeUndefined();

    expect(mocks.mockedApiFetch).toHaveBeenCalledTimes(1);
    const request = mocks.mockedApiFetch.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body.content).toBeUndefined();
    expect(body.commentary).toBe('text only');
  });

  it('should reject publishing when media uploads are still in progress', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'DRAFT',
      content: 'with media',
      media: [{ id: 'media-1', type: 'IMAGE', status: 'UPLOADING' }],
      save: mocks.save,
    } as any;
    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
      accountType: 'PERSON',
      impersonatorUrn: 'urn:li:person:abc',
      profileMetadata: {},
    });

    await expect(
      service.publishOnLinkedIn({ _id: userId } as any, postId.toString()),
    ).rejects.toThrow('Media uploads are still in progress');
    expect(mocks.mockedApiFetch).not.toHaveBeenCalled();
  });

  it('should reject publishing when a pending upload slot has not expired', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'DRAFT',
      content: 'with media',
      media: [
        {
          id: 'media-1',
          type: 'IMAGE',
          status: 'PENDING',
          pendingExpiresAt: new Date(Date.now() + 60_000),
        },
      ],
      save: mocks.save,
    } as any;
    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
      accountType: 'PERSON',
      impersonatorUrn: 'urn:li:person:abc',
      profileMetadata: {},
    });

    await expect(
      service.publishOnLinkedIn({ _id: userId } as any, postId.toString()),
    ).rejects.toThrow('Media uploads are still in progress');
    expect(mocks.mockedApiFetch).not.toHaveBeenCalled();
  });

  it('should purge expired pending slots and publish without them', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'DRAFT',
      content: 'with media',
      media: [
        { id: 'urn:li:image:1', title: 'ok', type: 'IMAGE', status: 'READY' },
        {
          id: 'media-2',
          type: 'IMAGE',
          status: 'PENDING',
          pendingExpiresAt: new Date(Date.now() - 60_000),
        },
      ],
      save: mocks.save,
    } as any;
    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
      accountType: 'PERSON',
      impersonatorUrn: 'urn:li:person:abc',
      profileMetadata: {},
    });

    await service.publishOnLinkedIn({ _id: userId } as any, postId.toString());

    expect(post.media).toHaveLength(1);
    const request = mocks.mockedApiFetch.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body.content).toEqual({
      media: { id: 'urn:li:image:1', title: 'ok' },
    });
  });

  it('should exclude failed media from the publish payload', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'DRAFT',
      content: 'with media',
      media: [
        { id: 'urn:li:image:1', title: 'ok', type: 'IMAGE', status: 'READY' },
        { id: 'media-2', title: 'broken', type: 'IMAGE', status: 'FAILED' },
      ],
      save: mocks.save,
    } as any;
    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
      accountType: 'PERSON',
      impersonatorUrn: 'urn:li:person:abc',
      profileMetadata: {},
    });

    await service.publishOnLinkedIn({ _id: userId } as any, postId.toString());

    const request = mocks.mockedApiFetch.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body.content).toEqual({
      media: {
        id: 'urn:li:image:1',
        title: 'ok',
      },
    });
  });

  it('includes media payload when media exists', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'SCHEDULED',
      content: 'with media',
      media: [{ id: 'urn:li:image:1', title: 'image-1', type: 'IMAGE' }],
      save: mocks.save,
    } as any;
    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
      accountType: 'PERSON',
      impersonatorUrn: 'urn:li:person:abc',
      profileMetadata: {},
    });

    await service.publishOnLinkedIn({ _id: userId } as any, postId.toString());

    const request = mocks.mockedApiFetch.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body.content).toEqual({
      media: {
        id: 'urn:li:image:1',
        title: 'image-1',
      },
    });
  });
});

describe('PostService.deletePost', () => {
  const createService = () => {
    const service = Object.create(PostService.prototype) as PostService;
    const findById = jest.fn();
    const deleteExec = jest.fn().mockResolvedValue({ deletedCount: 1 });
    const deleteOne = jest.fn().mockReturnValue({ exec: deleteExec });
    const findConnectedAccountById = jest.fn();
    const decrypt = jest.fn().mockResolvedValue('token');
    const getJob = jest.fn();
    const decrementScheduledPostUsage = jest.fn();

    (service as any).postModel = {
      findById,
      deleteOne,
    };
    (service as any).connectedAccountModel = {
      findById: findConnectedAccountById,
    };
    (service as any).encryptionService = {
      decrypt,
    };
    (service as any).scheduleQueue = {
      queue: {
        getJob,
      },
    };
    (service as any).featureGatingService = {
      decrementScheduledPostUsage,
    };
    (service as any).LINKEDIN_API_BASE = 'https://api.linkedin.com/rest';

    return {
      service,
      mocks: {
        findById,
        deleteOne,
        deleteExec,
        findConnectedAccountById,
        decrypt,
        getJob,
        decrementScheduledPostUsage,
      },
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('removes scheduled queue job before deleting the post when job exists', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const remove = jest.fn().mockResolvedValue(undefined);
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'SCHEDULED',
    } as any;

    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
    });
    mocks.getJob.mockResolvedValue({ remove });

    await service.deletePost({ _id: userId } as any, postId.toString());

    expect(mocks.getJob).toHaveBeenCalledWith(postId.toString());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(mocks.deleteOne).toHaveBeenCalledTimes(1);
    expect(mocks.decrementScheduledPostUsage).not.toHaveBeenCalled();
    const deleteArg = mocks.deleteOne.mock.calls[0][0];
    expect(deleteArg._id.toString()).toBe(postId.toString());
  });

  it('deletes scheduled post when queue job is already missing', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'SCHEDULED',
    } as any;

    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
    });
    mocks.getJob.mockResolvedValue(null);

    await service.deletePost({ _id: userId } as any, postId.toString());

    expect(mocks.getJob).toHaveBeenCalledWith(postId.toString());
    expect(mocks.deleteOne).toHaveBeenCalledTimes(1);
  });

  it('fails deletion if scheduled queue job removal throws', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const remove = jest.fn().mockRejectedValue(new Error('remove failed'));
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'SCHEDULED',
    } as any;

    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
    });
    mocks.getJob.mockResolvedValue({ remove });

    await expect(
      service.deletePost({ _id: userId } as any, postId.toString()),
    ).rejects.toThrow('remove failed');
    expect(mocks.deleteOne).not.toHaveBeenCalled();
  });

  it('should avoid queue lookup when deleting a FAILED post', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'FAILED',
    } as any;

    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
    });

    await service.deletePost({ _id: userId } as any, postId.toString());

    expect(mocks.getJob).not.toHaveBeenCalled();
    expect(mocks.deleteOne).toHaveBeenCalledTimes(1);
  });

  it('should delete the LinkedIn post when deleting a published record', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'PUBLISHED',
      channelPostId: 'urn:li:share:123',
    } as any;
    const mockedApiFetch = apiFetch as jest.Mock;
    mockedApiFetch.mockResolvedValue({ data: {}, response: {} });

    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
    });

    await service.deletePost({ _id: userId } as any, postId.toString());

    expect(mocks.getJob).not.toHaveBeenCalled();
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.deleteOne).toHaveBeenCalledTimes(1);
  });

  it('should block deletion when a published post account is disconnected', async () => {
    const { service, mocks } = createService();
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: new Types.ObjectId(),
      status: 'PUBLISHED',
      channelPostId: 'urn:li:share:123',
    } as any;

    mocks.findById.mockResolvedValue(post);
    mocks.findConnectedAccountById.mockResolvedValue({
      user: userId,
      provider: 'LINKEDIN',
      isActive: false,
      accessToken: null,
    });

    await expect(
      service.deletePost({ _id: userId } as any, postId.toString()),
    ).rejects.toThrow(
      'Reconnect account to delete published posts from LinkedIn safely.',
    );
    expect(mocks.deleteOne).not.toHaveBeenCalled();
  });
});

describe('PostService.addLinkedinMedia', () => {
  const createService = () => {
    const service = Object.create(PostService.prototype) as PostService;
    const findById = jest.fn();
    const save = jest.fn().mockResolvedValue(undefined);
    const findConnectedAccountById = jest.fn();
    const addMediaUploadJob = jest.fn().mockResolvedValue(undefined);

    (service as any).postDraftModel = { findById };
    (service as any).connectedAccountModel = {
      findById: findConnectedAccountById,
    };
    (service as any).mediaUploadQueue = { addMediaUploadJob };

    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const connectedAccountId = new Types.ObjectId();
    const post = {
      _id: postId,
      user: userId,
      connectedAccount: connectedAccountId,
      status: 'DRAFT',
      media: [],
      save,
    } as any;
    const connectedAccount = {
      user: userId,
      provider: 'LINKEDIN',
      isActive: true,
      accessToken: 'encrypted-token',
      accountType: 'PERSON',
      profileMetadata: { sub: 'abc' },
    };

    return {
      service,
      mocks: { findById, save, findConnectedAccountById, addMediaUploadJob },
      fixtures: { userId, postId, connectedAccountId, post, connectedAccount },
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const imageFile = (name: string) =>
    ({
      path: `/tmp/${name}`,
      mimetype: 'image/jpeg',
      originalname: name,
    }) as any;

  it('should upload files to R2, append UPLOADING media, and enqueue a job when files are valid', async () => {
    const { service, mocks, fixtures } = createService();
    mocks.findById.mockResolvedValue(fixtures.post);
    mocks.findConnectedAccountById.mockResolvedValue(fixtures.connectedAccount);
    (uploadFile as jest.Mock).mockResolvedValue('https://r2/url');

    const result = await service.addLinkedinMedia(
      { _id: fixtures.userId } as any,
      fixtures.postId.toString(),
      [imageFile('a.jpg')],
    );

    expect(uploadFile).toHaveBeenCalledTimes(1);
    const [r2Key, body, mimeType] = (uploadFile as jest.Mock).mock.calls[0];
    expect(r2Key).toMatch(
      new RegExp(`^media-uploads/${fixtures.postId.toString()}/`),
    );
    expect(body).toEqual(Buffer.from('file-bytes'));
    expect(mimeType).toBe('image/jpeg');

    expect(mocks.addMediaUploadJob).toHaveBeenCalledWith({
      postId: fixtures.postId.toString(),
      connectedAccountId: fixtures.connectedAccountId.toString(),
      ownerUrn: 'urn:li:person:abc',
      items: [expect.objectContaining({ r2Key, mediaType: 'IMAGE' })],
    });

    expect(fixtures.post.media).toHaveLength(1);
    expect(fixtures.post.media[0]).toMatchObject({
      type: 'IMAGE',
      title: 'a.jpg',
      status: 'UPLOADING',
    });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith('/tmp/a.jpg');
    expect(result).toEqual(fixtures.post.media);
  });

  it('should reject when a media upload is already in progress', async () => {
    const { service, mocks, fixtures } = createService();
    fixtures.post.media = [
      { id: 'media-1', type: 'IMAGE', status: 'UPLOADING' },
    ];
    mocks.findById.mockResolvedValue(fixtures.post);

    await expect(
      service.addLinkedinMedia(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        [imageFile('a.jpg')],
      ),
    ).rejects.toThrow('A media upload is already in progress for this post');
    expect(uploadFile).not.toHaveBeenCalled();
    expect(mocks.addMediaUploadJob).not.toHaveBeenCalled();
  });

  it('should reject when images and videos are mixed', async () => {
    const { service, mocks, fixtures } = createService();
    mocks.findById.mockResolvedValue(fixtures.post);

    await expect(
      service.addLinkedinMedia(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        [
          imageFile('a.jpg'),
          {
            path: '/tmp/b.mp4',
            mimetype: 'video/mp4',
            originalname: 'b.mp4',
          } as any,
        ],
      ),
    ).rejects.toThrow('Cannot mix images and videos in one post');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('should delete already-uploaded R2 objects when a later upload fails', async () => {
    const { service, mocks, fixtures } = createService();
    mocks.findById.mockResolvedValue(fixtures.post);
    mocks.findConnectedAccountById.mockResolvedValue(fixtures.connectedAccount);
    (uploadFile as jest.Mock)
      .mockResolvedValueOnce('https://r2/url')
      .mockRejectedValueOnce(new Error('R2 unavailable'));

    await expect(
      service.addLinkedinMedia(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        [imageFile('a.jpg'), imageFile('b.jpg')],
      ),
    ).rejects.toThrow('R2 unavailable');

    const firstKey = (uploadFile as jest.Mock).mock.calls[0][0];
    expect(deleteFile).toHaveBeenCalledWith(firstKey);
    expect(mocks.addMediaUploadJob).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

const createMediaUploadService = () => {
  const service = Object.create(PostService.prototype) as PostService;
  const findById = jest.fn();
  const save = jest.fn().mockResolvedValue(undefined);
  const markModified = jest.fn();
  const findConnectedAccountById = jest.fn();
  const addMediaUploadJob = jest.fn().mockResolvedValue(undefined);

  (service as any).postDraftModel = { findById };
  (service as any).connectedAccountModel = {
    findById: findConnectedAccountById,
  };
  (service as any).mediaUploadQueue = { addMediaUploadJob };
  (service as any).MEDIA_UPLOAD_SLOT_TTL_MS = 30 * 60 * 1000;

  const userId = new Types.ObjectId();
  const postId = new Types.ObjectId();
  const connectedAccountId = new Types.ObjectId();
  const post = {
    _id: postId,
    user: userId,
    connectedAccount: connectedAccountId,
    status: 'DRAFT',
    media: [] as any[],
    save,
    markModified,
  } as any;
  const connectedAccount = {
    user: userId,
    provider: 'LINKEDIN',
    isActive: true,
    accessToken: 'encrypted-token',
    accountType: 'PERSON',
    profileMetadata: { sub: 'abc' },
  };
  findById.mockResolvedValue(post);
  findConnectedAccountById.mockResolvedValue(connectedAccount);

  return {
    service,
    mocks: {
      findById,
      save,
      markModified,
      findConnectedAccountById,
      addMediaUploadJob,
    },
    fixtures: { userId, postId, connectedAccountId, post, connectedAccount },
  };
};

describe('PostService.initiateMediaUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSignedUploadUrl as jest.Mock).mockResolvedValue(
      'https://r2-signed/put',
    );
  });

  const imageDto = (fileName = 'a.jpg') => ({
    fileName,
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
  });

  it('should create presigned slots and append PENDING media when files are valid', async () => {
    const { service, mocks, fixtures } = createMediaUploadService();

    const result = await service.initiateMediaUpload(
      { _id: fixtures.userId } as any,
      fixtures.postId.toString(),
      { files: [imageDto()] } as any,
    );

    expect(getSignedUploadUrl).toHaveBeenCalledTimes(1);
    const [r2Key, mimeType, sizeBytes, expiresIn] = (
      getSignedUploadUrl as jest.Mock
    ).mock.calls[0];
    expect(r2Key).toMatch(
      new RegExp(`^media-uploads/${fixtures.postId.toString()}/`),
    );
    expect(mimeType).toBe('image/jpeg');
    expect(sizeBytes).toBe(1024);
    expect(expiresIn).toBe(1800);

    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0]).toMatchObject({
      uploadUrl: 'https://r2-signed/put',
      requiredHeaders: {
        'Content-Type': 'image/jpeg',
        'Content-Length': '1024',
      },
    });
    expect(result.expiresAt).toBeInstanceOf(Date);

    expect(fixtures.post.media).toHaveLength(1);
    expect(fixtures.post.media[0]).toMatchObject({
      id: result.uploads[0].mediaId,
      type: 'IMAGE',
      title: 'a.jpg',
      status: 'PENDING',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
    });
    expect(fixtures.post.media[0].pendingExpiresAt).toBeInstanceOf(Date);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.addMediaUploadJob).not.toHaveBeenCalled();
  });

  it('should mark video slots as VIDEO without altText when a video is declared', async () => {
    const { service, fixtures } = createMediaUploadService();

    await service.initiateMediaUpload(
      { _id: fixtures.userId } as any,
      fixtures.postId.toString(),
      {
        files: [{ fileName: 'v.mp4', mimeType: 'video/mp4', sizeBytes: 5000 }],
      } as any,
    );

    expect(fixtures.post.media[0]).toMatchObject({
      type: 'VIDEO',
      title: 'v.mp4',
      altText: undefined,
      status: 'PENDING',
    });
  });

  it('should reject when images and videos are mixed', async () => {
    const { service, fixtures } = createMediaUploadService();

    await expect(
      service.initiateMediaUpload(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        {
          files: [
            imageDto(),
            { fileName: 'v.mp4', mimeType: 'video/mp4', sizeBytes: 1 },
          ],
        } as any,
      ),
    ).rejects.toThrow('Cannot mix images and videos in one post');
    expect(getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('should reject when more than one video is declared', async () => {
    const { service, fixtures } = createMediaUploadService();

    await expect(
      service.initiateMediaUpload(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        {
          files: [
            { fileName: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 1 },
            { fileName: 'b.mp4', mimeType: 'video/mp4', sizeBytes: 1 },
          ],
        } as any,
      ),
    ).rejects.toThrow('Only one video per post is allowed');
  });

  it('should reject an unsupported file type', async () => {
    const { service, fixtures } = createMediaUploadService();

    await expect(
      service.initiateMediaUpload(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        {
          files: [
            { fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 1 },
          ],
        } as any,
      ),
    ).rejects.toThrow('Unsupported file type: application/pdf');
  });

  it('should reject a non-JPEG/PNG image format', async () => {
    const { service, fixtures } = createMediaUploadService();

    await expect(
      service.initiateMediaUpload(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        {
          files: [{ fileName: 'a.gif', mimeType: 'image/gif', sizeBytes: 1 }],
        } as any,
      ),
    ).rejects.toThrow('Unsupported image format: image/gif. Use JPEG or PNG');
  });

  it('should reject when a media upload is already in progress', async () => {
    const { service, fixtures } = createMediaUploadService();
    fixtures.post.media = [
      { id: 'media-1', type: 'IMAGE', status: 'UPLOADING' },
    ];

    await expect(
      service.initiateMediaUpload(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        { files: [imageDto()] } as any,
      ),
    ).rejects.toThrow('A media upload is already in progress for this post');
  });

  it('should reject when an unexpired pending slot exists', async () => {
    const { service, fixtures } = createMediaUploadService();
    fixtures.post.media = [
      {
        id: 'media-1',
        type: 'IMAGE',
        status: 'PENDING',
        pendingExpiresAt: new Date(Date.now() + 60_000),
      },
    ];

    await expect(
      service.initiateMediaUpload(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        { files: [imageDto()] } as any,
      ),
    ).rejects.toThrow('A media upload is already in progress for this post');
  });

  it('should purge expired pending slots and proceed', async () => {
    const { service, mocks, fixtures } = createMediaUploadService();
    fixtures.post.media = [
      {
        id: 'stale-1',
        type: 'IMAGE',
        status: 'PENDING',
        pendingExpiresAt: new Date(Date.now() - 60_000),
      },
    ];

    const result = await service.initiateMediaUpload(
      { _id: fixtures.userId } as any,
      fixtures.postId.toString(),
      { files: [imageDto()] } as any,
    );

    expect(result.uploads).toHaveLength(1);
    expect(fixtures.post.media).toHaveLength(1);
    expect(fixtures.post.media[0].id).toBe(result.uploads[0].mediaId);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('should reject when the post is not owned by the user', async () => {
    const { service, fixtures } = createMediaUploadService();

    await expect(
      service.initiateMediaUpload(
        { _id: new Types.ObjectId() } as any,
        fixtures.postId.toString(),
        { files: [imageDto()] } as any,
      ),
    ).rejects.toThrow('You are not authorized to edit this post');
  });
});

describe('PostService.completeMediaUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (headFile as jest.Mock).mockResolvedValue({
      sizeBytes: 1024,
      mimeType: 'image/jpeg',
    });
  });

  const pendingEntry = (id = 'media-1') => ({
    id,
    type: 'IMAGE',
    title: 'a.jpg',
    status: 'PENDING',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    pendingExpiresAt: new Date(Date.now() + 60_000),
  });

  it('should verify the uploaded file, flip the entry to UPLOADING, and enqueue a job', async () => {
    const { service, mocks, fixtures } = createMediaUploadService();
    fixtures.post.media = [pendingEntry()];

    const result = await service.completeMediaUpload(
      { _id: fixtures.userId } as any,
      fixtures.postId.toString(),
      { mediaIds: ['media-1'] } as any,
    );

    const expectedKey = `media-uploads/${fixtures.postId.toString()}/media-1`;
    expect(headFile).toHaveBeenCalledWith(expectedKey);
    expect(fixtures.post.media[0].status).toBe('UPLOADING');
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.addMediaUploadJob).toHaveBeenCalledWith({
      postId: fixtures.postId.toString(),
      connectedAccountId: fixtures.connectedAccountId.toString(),
      ownerUrn: 'urn:li:person:abc',
      items: [{ mediaId: 'media-1', r2Key: expectedKey, mediaType: 'IMAGE' }],
    });
    expect(result).toEqual([fixtures.post.media[0]]);
  });

  it('should reject an unknown media id', async () => {
    const { service, mocks, fixtures } = createMediaUploadService();
    fixtures.post.media = [pendingEntry()];

    await expect(
      service.completeMediaUpload(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        { mediaIds: ['nope'] } as any,
      ),
    ).rejects.toThrow('Unknown media id: nope');
    expect(mocks.addMediaUploadJob).not.toHaveBeenCalled();
  });

  it('should reject a media entry that is not awaiting confirmation', async () => {
    const { service, fixtures } = createMediaUploadService();
    fixtures.post.media = [{ ...pendingEntry(), status: 'READY' }];

    await expect(
      service.completeMediaUpload(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        { mediaIds: ['media-1'] } as any,
      ),
    ).rejects.toThrow('Media media-1 is not awaiting upload confirmation');
  });

  it('should reject when the upload slot has expired', async () => {
    const { service, fixtures } = createMediaUploadService();
    fixtures.post.media = [
      { ...pendingEntry(), pendingExpiresAt: new Date(Date.now() - 60_000) },
    ];

    await expect(
      service.completeMediaUpload(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        { mediaIds: ['media-1'] } as any,
      ),
    ).rejects.toThrow('Upload slot expired. Re-initiate the upload.');
  });

  it('should reject when the file was never uploaded to R2', async () => {
    const { service, mocks, fixtures } = createMediaUploadService();
    fixtures.post.media = [pendingEntry()];
    (headFile as jest.Mock).mockResolvedValue(null);

    await expect(
      service.completeMediaUpload(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        { mediaIds: ['media-1'] } as any,
      ),
    ).rejects.toThrow('File for media media-1 was not uploaded');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.addMediaUploadJob).not.toHaveBeenCalled();
  });

  it('should reject when the uploaded file size does not match the declared size', async () => {
    const { service, fixtures } = createMediaUploadService();
    fixtures.post.media = [pendingEntry()];
    (headFile as jest.Mock).mockResolvedValue({
      sizeBytes: 999,
      mimeType: 'image/jpeg',
    });

    await expect(
      service.completeMediaUpload(
        { _id: fixtures.userId } as any,
        fixtures.postId.toString(),
        { mediaIds: ['media-1'] } as any,
      ),
    ).rejects.toThrow(
      'Uploaded file for media media-1 does not match the declared size or type',
    );
  });

  it('should deduplicate repeated media ids in the request', async () => {
    const { service, mocks, fixtures } = createMediaUploadService();
    fixtures.post.media = [pendingEntry()];

    await service.completeMediaUpload(
      { _id: fixtures.userId } as any,
      fixtures.postId.toString(),
      { mediaIds: ['media-1', 'media-1'] } as any,
    );

    expect(headFile).toHaveBeenCalledTimes(1);
    expect(mocks.addMediaUploadJob.mock.calls[0][0].items).toHaveLength(1);
  });
});
