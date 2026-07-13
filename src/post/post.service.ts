import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ScheduleQueue } from '../workflow/schedule.queue';
import { SchedulePostDto, CreatePostDto } from './dto';
import {
  AccountProvider,
  Artifact,
  ArtifactType,
  ConnectedAccount,
  LinkedinAccountType,
  Post,
  PostStatus,
  User,
  VersionStatus,
} from 'src/database/schemas';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types } from 'mongoose';
import { ApiError, apiFetch } from 'src/common/HelperFn/apiFetch.helper';
import { EncryptionService } from 'src/encryption/encryption.service';
import { IContent, ILinkedInPost } from './post.interface';
import { formatLinkedinContent } from 'src/common/HelperFn';
import { FeatureGatingService } from '../feature-gating/feature-gating.service';
import { getFile } from 'src/s3';
import { LinkedinMediaService } from './linkedin-media.service';
import type { DocumentContent, PollContent } from '../artifact/schemas';

interface PostFilters {
  availableMonths: string[];
  connectedAccountIds: string[];
}

const POST_PAGE_SIZE = 20;

export interface GetPostsResult {
  data: Post[];
  filters: PostFilters;
}

@Injectable()
export class PostService {
  private readonly logger = new Logger(PostService.name);
  private readonly LINKEDIN_API_BASE = 'https://api.linkedin.com/rest';

  private referenceId(
    reference: User | ConnectedAccount | Types.ObjectId,
  ): string {
    if (reference instanceof Types.ObjectId) return reference.toHexString();
    return reference._id.toHexString();
  }

  constructor(
    private readonly scheduleQueue: ScheduleQueue,
    @InjectModel(Post.name)
    private readonly postModel: Model<Post>,
    @InjectModel(Artifact.name)
    private readonly artifactModel: Model<Artifact>,
    @InjectModel(ConnectedAccount.name)
    private readonly connectedAccountModel: Model<ConnectedAccount>,
    private readonly encryptionService: EncryptionService,
    private readonly featureGatingService: FeatureGatingService,
    private readonly linkedinMediaService: LinkedinMediaService,
  ) {}

  async createPost(user: User, dto: CreatePostDto): Promise<Post> {
    const artifact = await this.artifactModel.findById(dto.artifactId);
    if (!artifact) throw new NotFoundException('Artifact not found');
    if (this.referenceId(artifact.user) !== user._id.toString()) {
      throw new ForbiddenException(
        'You are not authorized to publish this artifact',
      );
    }

    const versionNumber = dto.version ?? artifact.currentVersion;
    const version = artifact.versions.find(
      (candidate) => candidate.version === versionNumber,
    );
    if (!version || version.status !== VersionStatus.READY) {
      throw new BadRequestException(
        'Artifact version must be READY to publish',
      );
    }

    const connectedAccount = await this.getOwnedUsableLinkedinConnectedAccount(
      user._id.toString(),
      dto.connectedAccount,
      dto.scheduledAt ? 'schedule posts' : 'publish posts',
    );
    if (connectedAccount.accountType === LinkedinAccountType.ORGANIZATION) {
      await this.featureGatingService.assertCompanyPagesAccess(
        user._id.toString(),
      );
    }

    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;
    if (scheduledAt && scheduledAt.getTime() <= Date.now()) {
      throw new BadRequestException('Scheduled time must be in the future');
    }
    if (scheduledAt) {
      await this.featureGatingService.assertScheduledPostQuota(
        user._id.toString(),
      );
    }

    const post = new this.postModel({
      user: user._id,
      connectedAccount: new Types.ObjectId(dto.connectedAccount),
      artifacts: [
        {
          artifact: new Types.ObjectId(dto.artifactId),
          version: versionNumber,
        },
      ],
      status: PostStatus.SCHEDULED,
      ...(scheduledAt ? { scheduledAt } : {}),
    });
    await post.save();

    if (!scheduledAt) {
      return this.publishPost(post._id.toString());
    }

    await this.scheduleQueue.addScheduleJob(
      post._id.toString(),
      user._id.toString(),
      scheduledAt.getTime() - Date.now(),
    );
    await this.featureGatingService.incrementScheduledPostUsage(
      user._id.toString(),
      post._id.toString(),
    );
    post.scheduledPostUsageCounted = true;
    await post.save();
    return post;
  }

  async publishPost(postId: string): Promise<Post> {
    const post = await this.postModel.findById(postId);
    if (!post) throw new NotFoundException('Post not found');
    if (post.status === PostStatus.PUBLISHED) {
      throw new BadRequestException('Post is already published');
    }

    const source = post.artifacts[0];
    const artifact = source
      ? await this.artifactModel.findById(source.artifact)
      : null;
    const version = artifact?.versions.find(
      (candidate) => candidate.version === source?.version,
    );
    if (
      !artifact ||
      artifact.deletedAt ||
      !Object.values(ArtifactType).includes(artifact.type) ||
      !version ||
      version.status !== VersionStatus.READY
    ) {
      await this.failPost(post, 'source artifact unavailable');
      throw new BadRequestException('source artifact unavailable');
    }

    try {
      const connectedAccount =
        await this.getOwnedUsableLinkedinConnectedAccount(
          this.referenceId(post.user),
          this.referenceId(post.connectedAccount),
          'publish posts',
        );
      const accessToken = await this.encryptionService.decrypt(
        connectedAccount.accessToken!,
      );
      const author = this.resolveLinkedinAuthorUrn(connectedAccount);
      let content: IContent | undefined;
      if (artifact.type === ArtifactType.POLL) {
        const pollContent = version.content as unknown as PollContent;
        const durationByDays = {
          1: 'ONE_DAY',
          3: 'THREE_DAYS',
          7: 'SEVEN_DAYS',
          14: 'FOURTEEN_DAYS',
        } as const;
        content = {
          poll: {
            question: pollContent.poll.question,
            options: pollContent.poll.options.map((text) => ({ text })),
            settings: {
              duration: durationByDays[pollContent.poll.durationDays],
              voteSelectionType: 'SINGLE_VOTE',
              isVoterVisibleToAuthor: true,
            },
          },
        };
      } else if (artifact.type === ArtifactType.DOCUMENT) {
        const documentContent = version.content as unknown as DocumentContent;
        const { pdfKey, pageCount, slides } = documentContent.document;
        if (!pdfKey || !pageCount) {
          throw new BadRequestException('source artifact unavailable');
        }
        const bytes = await getFile(pdfKey);
        const documentUrn = await this.linkedinMediaService.uploadDocument(
          author,
          accessToken,
          bytes,
          pageCount,
        );
        const cover = slides[0];
        const title =
          cover?.type === 'cover' ? cover.fields.title : 'LinkedIn document';
        content = { media: { id: documentUrn, title } };
      }
      const data: ILinkedInPost = {
        author,
        ...(typeof version.content.commentary === 'string'
          ? { commentary: formatLinkedinContent(version.content.commentary) }
          : {}),
        ...(content ? { content } : {}),
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      };
      const { response } = await apiFetch<unknown>(
        `${this.LINKEDIN_API_BASE}/posts`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202601',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(data),
        },
      );
      const channelPostId = response.headers.get('x-restli-id');
      if (channelPostId) post.channelPostId = channelPostId;
      post.status = PostStatus.PUBLISHED;
      post.publishedAt = new Date();
      post.failureReason = undefined;
      await post.save();
      return post;
    } catch (error) {
      this.logger.error(error);
      const reconnectRequired =
        error instanceof ApiError &&
        error.statusCode === 400 &&
        typeof error.data?.message === 'string' &&
        error.data.message.includes('Organization permissions must be used');
      const failureReason = reconnectRequired
        ? 'Your LinkedIn account needs to be reconnected to enable company page posting. Please disconnect and reconnect your LinkedIn account.'
        : 'Failed to publish post';
      await this.failPost(post, failureReason);
      if (reconnectRequired) throw new BadRequestException(failureReason);
      throw new InternalServerErrorException(failureReason);
    }
  }

  private async failPost(post: Post, reason: string): Promise<void> {
    post.status = PostStatus.FAILED;
    post.failureReason = reason;
    await post.save();
  }

  async publishPostNow(user: User, postId: string): Promise<Post> {
    const post = await this.postModel.findById(postId);
    if (!post) throw new NotFoundException('Post not found');
    if (this.referenceId(post.user) !== user._id.toString()) {
      throw new ForbiddenException(
        'You are not authorized to publish this post',
      );
    }
    if (
      post.status !== PostStatus.SCHEDULED &&
      post.status !== PostStatus.FAILED
    ) {
      throw new BadRequestException('Post cannot be published');
    }

    const scheduledJob = await this.scheduleQueue.queue.getJob(postId);
    if (scheduledJob) await scheduledJob.remove();

    return this.publishPost(postId);
  }

  async getPosts(
    user: User,
    connectedAccount?: string,
    status?: string,
    month?: string,
    page = 1,
  ): Promise<GetPostsResult> {
    const filter: QueryFilter<Post> = { user: user._id };

    if (connectedAccount) {
      filter.connectedAccount = new Types.ObjectId(connectedAccount);
    }

    if (status) {
      filter.status = status;
    }

    if (month) {
      const [year, monthNum] = month.split('-').map(Number);
      if (!isNaN(year) && !isNaN(monthNum)) {
        const start = new Date(year, monthNum - 1, 1);
        const end = new Date(year, monthNum, 1);
        filter.updatedAt = { $gte: start, $lt: end };
      }
    }

    const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
    const postsQuery = this.postModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((normalizedPage - 1) * POST_PAGE_SIZE)
      .limit(POST_PAGE_SIZE)
      .lean()
      .exec();

    const availableMonthsQuery = this.postModel.aggregate<{
      month: string;
    }>([
      {
        $match: {
          user: user._id,
        },
      },
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
      {
        $sort: { _id: -1 },
      },
      {
        $project: {
          _id: 0,
          month: '$_id',
        },
      },
    ]);

    const connectedAccountIdsQuery = this.postModel.distinct(
      'connectedAccount',
      { user: user._id },
    );

    const [posts, availableMonthsResult, connectedAccountIds] =
      await Promise.all([
        postsQuery,
        availableMonthsQuery,
        connectedAccountIdsQuery,
      ]);

    return {
      data: posts,
      filters: {
        availableMonths: availableMonthsResult.map((item) => item.month),
        connectedAccountIds: (
          connectedAccountIds as unknown as Array<
            ConnectedAccount | Types.ObjectId
          >
        ).map((id) => this.referenceId(id)),
      },
    };
  }

  async deletePost(user: User, postId: string) {
    const post = await this.postModel.findById(postId);
    if (!post) {
      throw new NotFoundException('Post not found');
    }

    if (this.referenceId(post.user) !== user._id.toString()) {
      throw new ForbiddenException(
        'You are not authorized to delete this post',
      );
    }

    const connectedAccount = await this.getOwnedLinkedinConnectedAccount(
      user._id.toString(),
      this.referenceId(post.connectedAccount),
    );
    const canUseLinkedinAccount =
      this.isLinkedinAccountUsable(connectedAccount);
    if (post.status === PostStatus.PUBLISHED && !canUseLinkedinAccount) {
      throw new ConflictException(
        'Reconnect account to delete published posts from LinkedIn safely.',
      );
    }

    if (post.status === PostStatus.SCHEDULED) {
      const scheduledJob = await this.scheduleQueue.queue.getJob(
        post._id.toString(),
      );
      if (scheduledJob) {
        await scheduledJob.remove();
      }
    }

    if (post.status === PostStatus.PUBLISHED && post.channelPostId) {
      const accessToken = await this.encryptionService.decrypt(
        connectedAccount.accessToken!,
      );
      const externalUrl = `${this.LINKEDIN_API_BASE}/posts/${encodeURIComponent(post.channelPostId)}`;
      await apiFetch(externalUrl, {
        method: 'DELETE',
        headers: {
          'X-Restli-Protocol-Version': '2.0.0',
          'LinkedIn-Version': '202601',
          Authorization: `Bearer ${accessToken}`,
        },
      });
    }

    return this.postModel.deleteOne({ _id: new Types.ObjectId(postId) }).exec();
  }

  async getPost(user: User, postId: string) {
    const post = await this.postModel.findById(postId);
    if (!post) {
      throw new NotFoundException('Post not found');
    }

    if (this.referenceId(post.user) !== user._id.toString()) {
      throw new ForbiddenException('You are not authorized to view this post');
    }

    const artifacts = await Promise.all(
      post.artifacts.map(async (reference) => {
        const artifact = await this.artifactModel.findById(reference.artifact);
        const version = artifact?.versions.find(
          (candidate) => candidate.version === reference.version,
        );
        if (!artifact || !version) {
          throw new NotFoundException('Source artifact version not found');
        }

        const artifactObject = artifact.toObject() as unknown as Record<
          string,
          unknown
        >;
        const artifactMetadata = { ...artifactObject };
        delete artifactMetadata.versions;
        return { artifact: artifactMetadata, version };
      }),
    );

    return {
      ...(post.toObject() as unknown as Record<string, unknown>),
      artifacts,
    };
  }

  async schedulePost(user: User, postId: string, dto: SchedulePostDto) {
    const post = await this.postModel.findById(postId);
    if (!post) {
      throw new NotFoundException('Post not found');
    }

    if (this.referenceId(post.user) !== user._id.toString()) {
      throw new ForbiddenException(
        'You are not authorized to schedule this post',
      );
    }

    if (post.status === PostStatus.PUBLISHED) {
      throw new BadRequestException('Post is already published');
    }

    if (
      post.status !== PostStatus.SCHEDULED &&
      post.status !== PostStatus.FAILED
    ) {
      throw new BadRequestException('Post cannot be scheduled');
    }

    const scheduledDate = new Date(dto.scheduledAt);
    const delay = scheduledDate.getTime() - Date.now();
    if (delay <= 0) {
      throw new BadRequestException('Scheduled time must be in the future');
    }

    await this.getOwnedUsableLinkedinConnectedAccount(
      user._id.toString(),
      this.referenceId(post.connectedAccount),
      'schedule posts',
    );

    const legacyScheduleWasCounted =
      post.scheduledPostUsageCounted === undefined &&
      (post.status === PostStatus.SCHEDULED || Boolean(post.scheduledAt));
    const usageWasCounted =
      post.scheduledPostUsageCounted === true ||
      legacyScheduleWasCounted ||
      (await this.featureGatingService.hasScheduledPostUsage(
        user._id.toString(),
        post._id.toString(),
      ));
    const isFirstTimeSchedule = !usageWasCounted;
    if (isFirstTimeSchedule) {
      await this.featureGatingService.assertScheduledPostQuota(
        user._id.toString(),
      );
    }

    const scheduledJob = await this.scheduleQueue.queue.getJob(
      post._id.toString(),
    );
    if (scheduledJob) {
      await scheduledJob.remove();
    }

    post.status = PostStatus.SCHEDULED;
    post.scheduledAt = scheduledDate;
    post.failureReason = undefined;
    await post.save();

    await this.scheduleQueue.addScheduleJob(
      post._id.toString(),
      user._id.toString(),
      delay,
    );

    if (isFirstTimeSchedule) {
      await this.featureGatingService.incrementScheduledPostUsage(
        user._id.toString(),
        post._id.toString(),
      );
    }

    if (!post.scheduledPostUsageCounted) {
      post.scheduledPostUsageCounted = true;
      await post.save();
    }

    return post;
  }

  async getLinkedinImage(user: User, urn: string) {
    const connectedAccount = await this.connectedAccountModel.findOne({
      user: user._id,
      provider: AccountProvider.LINKEDIN,
    });

    if (!connectedAccount) {
      throw new NotFoundException('Connected account not found');
    }
    if (!this.isLinkedinAccountUsable(connectedAccount)) {
      throw new ConflictException(
        'Reconnect connected account to fetch LinkedIn images.',
      );
    }

    const accessToken = await this.encryptionService.decrypt(
      connectedAccount.accessToken!,
    );

    const url = `${this.LINKEDIN_API_BASE}/images/${encodeURIComponent(urn)}`;

    try {
      const { response, data } = await apiFetch<any>(url, {
        method: 'GET',
        headers: {
          'X-Restli-Protocol-Version': '2.0.0',
          'LinkedIn-Version': '202601',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return {
        downloadUrl: data.downloadUrl,
        downloadUrlExpiresAt: data.downloadUrlExpiresAt,
      };
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(
        'Failed to fetch LinkedIn image details',
      );
    }
  }

  async getPostMetrics(user: User, connectedAccountId: string) {
    const connectedAccount =
      await this.connectedAccountModel.findById(connectedAccountId);
    if (!connectedAccount) {
      throw new NotFoundException('Connected account not found');
    }

    if (this.referenceId(connectedAccount.user) !== user._id.toString()) {
      throw new ForbiddenException(
        'You are not authorized to view metrics for this account',
      );
    }

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const metrics = await this.postModel.aggregate<{
      month: string;
      count: number;
    }>([
      {
        $match: {
          user: user._id,
          connectedAccount: new Types.ObjectId(connectedAccountId),
          createdAt: { $gte: sixMonthsAgo },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m',
              date: '$createdAt',
            },
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 },
      },
      {
        $project: {
          _id: 0,
          month: '$_id',
          count: 1,
        },
      },
    ]);

    const total = metrics.reduce((sum, item) => sum + item.count, 0);

    return {
      total,
      monthly: metrics,
    };
  }

  private async getOwnedLinkedinConnectedAccount(
    userId: string,
    connectedAccountId: string,
  ): Promise<ConnectedAccount> {
    const connectedAccount =
      await this.connectedAccountModel.findById(connectedAccountId);
    if (!connectedAccount) {
      throw new NotFoundException('Connected account not found');
    }

    if (connectedAccount.user.toString() !== userId) {
      throw new ForbiddenException('Connected account is not owned by user');
    }

    if (connectedAccount.provider !== AccountProvider.LINKEDIN) {
      throw new BadRequestException('Connected account must be LinkedIn');
    }

    return connectedAccount;
  }

  private async getOwnedUsableLinkedinConnectedAccount(
    userId: string,
    connectedAccountId: string,
    action: string,
  ): Promise<ConnectedAccount> {
    const connectedAccount = await this.getOwnedLinkedinConnectedAccount(
      userId,
      connectedAccountId,
    );

    if (!this.isLinkedinAccountUsable(connectedAccount)) {
      throw new ConflictException(`Reconnect connected account to ${action}.`);
    }

    return connectedAccount;
  }

  private isLinkedinAccountUsable(connectedAccount: ConnectedAccount): boolean {
    return Boolean(connectedAccount.isActive && connectedAccount.accessToken);
  }

  private resolveLinkedinAuthorUrn(connectedAccount: ConnectedAccount): string {
    if (
      connectedAccount.accountType === LinkedinAccountType.ORGANIZATION ||
      connectedAccount.profileMetadata?.organizationUrn
    ) {
      const organizationId =
        connectedAccount.externalId ??
        connectedAccount.profileMetadata?.organizationUrn?.split(':').pop();
      if (!organizationId) {
        throw new BadRequestException(
          'Connected organization account is missing organization identifier',
        );
      }
      return `urn:li:organization:${organizationId}`;
    }

    const profileSub =
      connectedAccount.profileMetadata?.sub ??
      connectedAccount.externalId ??
      connectedAccount.impersonatorUrn?.split(':').pop();
    if (!profileSub) {
      throw new BadRequestException(
        'Connected personal account is missing LinkedIn profile identifier',
      );
    }

    return `urn:li:person:${profileSub}`;
  }
}
