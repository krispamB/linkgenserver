import { Job, Worker } from 'bullmq';
import {
  EMAIL_QUEUE_NAME,
  LINKEDIN_AVATAR_REFRESH_QUEUE_NAME,
  MEDIA_UPLOAD_QUEUE_NAME,
  SCHEDULE_QUEUE_NAME,
} from '../workflow.constants';
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { PostService } from '../../post/post.service';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '../../database/schemas';
import { AuthService } from '../../auth/auth.service';
import { MailService } from '../../mail';
import { EmailQueue } from '../email.queue';
import { processEmailJob } from './email.worker.handler';
import { LinkedinMediaService } from '../../post/linkedin-media.service';
import { MediaUploadJobData } from '../media-upload.queue';
import {
  handleMediaUploadJobExhausted,
  processMediaUploadJob,
} from './media-upload.worker.handler';

async function bootstrapWorker() {
  const logger = new Logger(
    bootstrapWorker.name.charAt(0).toUpperCase() +
      bootstrapWorker.name.slice(1),
  );
  logger.log('Bootstrapping workflow context...');
  const app = await NestFactory.createApplicationContext(AppModule);

  const postService = app.get(PostService);
  const authService = app.get(AuthService);
  const mailService = app.get(MailService);
  const emailQueue = app.get(EmailQueue);
  const linkedinMediaService = app.get(LinkedinMediaService);
  const userModel = app.get<Model<User>>(getModelToken(User.name));

  logger.log('NestJs context ready');

  // The `workflow` queue has no processor between #115 and #116: the legacy
  // PostDraft pipeline is gone, and the artifact run that replaces it is wired
  // up in #116 once its step handlers exist.

  new Worker(
    SCHEDULE_QUEUE_NAME,
    async (job: Job) => {
      try {
        const { postId, userId } = job.data;
        const user = await userModel.findById(userId);
        if (!user) {
          logger.error(`User not found for schedule job ${job.id}`);
          return;
        }

        await postService.publishOnLinkedIn(user, postId);
        try {
          await emailQueue.addScheduledPostPublishedEmailJob(
            user.email,
            user.name,
            postId,
          );
        } catch (error) {
          logger.warn(
            `Failed to enqueue scheduled post published email for post ${postId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } catch (error) {
        logger.error(error);
        throw error;
      }
    },
    {
      connection: {
        url: process.env.REDIS_URL!,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
    },
  );

  new Worker(
    LINKEDIN_AVATAR_REFRESH_QUEUE_NAME,
    async (job: Job) => {
      try {
        const connectedAccountId = job.data?.connectedAccountId;
        if (!connectedAccountId) {
          logger.warn(
            `Skipping avatar refresh job ${job.id}; missing account id`,
          );
          return;
        }

        logger.log(
          `Processing LinkedIn avatar refresh for ${connectedAccountId}`,
        );
        await authService.refreshLinkedinAvatarForAccount(connectedAccountId);
      } catch (error) {
        logger.error(error);
        throw error;
      }
    },
    {
      connection: {
        url: process.env.REDIS_URL!,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
    },
  );

  new Worker(
    EMAIL_QUEUE_NAME,
    async (job: Job) => {
      try {
        await processEmailJob(job, logger, mailService);
      } catch (error) {
        logger.error(error);
        throw error;
      }
    },
    {
      connection: {
        url: process.env.REDIS_URL!,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
    },
  );

  const mediaUploadWorker = new Worker(
    MEDIA_UPLOAD_QUEUE_NAME,
    async (job: Job<MediaUploadJobData>) => {
      try {
        await processMediaUploadJob(job, logger, linkedinMediaService);
      } catch (error) {
        logger.error(error);
        throw error;
      }
    },
    {
      connection: {
        url: process.env.REDIS_URL!,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
    },
  );

  mediaUploadWorker.on('failed', (job, error) => {
    if (!job) return;
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      handleMediaUploadJobExhausted(job, logger, linkedinMediaService).catch(
        (err) => logger.error(err),
      );
    } else {
      logger.warn(
        `Media upload job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1}): ${error.message}`,
      );
    }
  });
}
bootstrapWorker();
