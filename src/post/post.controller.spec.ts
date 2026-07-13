import { HttpStatus } from '@nestjs/common';

jest.mock('./post.service', () => ({
  PostService: class PostService {},
}));
jest.mock('../agent/dto', () => ({ InputDto: class InputDto {} }));
jest.mock('../common/guards', () => ({
  JwtAuthGuard: class JwtAuthGuard {},
  SubscriptionAccessGuard: class SubscriptionAccessGuard {},
}));
jest.mock(
  'src/common/decorators',
  () => ({
    GetUser: () => () => undefined,
  }),
  { virtual: true },
);
jest.mock(
  'src/common/interfaces',
  () => ({ IAppResponse: class IAppResponse {} }),
  { virtual: true },
);
jest.mock(
  'src/database/schemas',
  () => ({
    User: class User {},
    PostStatus: {
      SCHEDULED: 'SCHEDULED',
      PUBLISHED: 'PUBLISHED',
      FAILED: 'FAILED',
    },
  }),
  { virtual: true },
);

import { PostController } from './post.controller';

describe('PostController', () => {
  describe('getPosts', () => {
    it('should return posts and filter metadata when list results exist', async () => {
      const postService = {
        getPosts: jest.fn().mockResolvedValue({
          data: [{ _id: 'post-1' }],
          filters: {
            availableMonths: ['2026-01'],
            connectedAccountIds: ['acc-1'],
          },
        }),
      } as any;

      const controller = new PostController(postService);

      const response = await controller.getPosts(
        { _id: 'user-1' } as any,
        {
          connectedAccount: 'acc-1',
          status: 'SCHEDULED',
          month: '2026-01',
          page: 2,
        } as any,
      );

      expect(postService.getPosts).toHaveBeenCalledWith(
        { _id: 'user-1' },
        'acc-1',
        'SCHEDULED',
        '2026-01',
        2,
      );

      expect(response).toEqual({
        statusCode: HttpStatus.OK,
        message: 'Posts retrieved successfully',
        data: [{ _id: 'post-1' }],
        filters: {
          availableMonths: ['2026-01'],
          connectedAccountIds: ['acc-1'],
        },
      });
    });
  });

  describe('publishPost', () => {
    it('should publish immediately when the post is owned by the user', async () => {
      const post = { _id: 'post-1', status: 'PUBLISHED' };
      const postService = {
        publishPostNow: jest.fn().mockResolvedValue(post),
      } as any;
      const controller = new PostController(postService);
      const user = { _id: 'user-1' } as any;

      const response = await controller.publishPost(user, 'post-1');

      expect(postService.publishPostNow).toHaveBeenCalledWith(user, 'post-1');
      expect(response.data).toBe(post);
    });
  });

  describe('schedulePost', () => {
    it('should pass scheduledAt when scheduling a post', async () => {
      const post = { _id: 'post-1', status: 'SCHEDULED' };
      const dto = { scheduledAt: '2026-08-01T10:00:00.000Z' };
      const postService = {
        schedulePost: jest.fn().mockResolvedValue(post),
      } as any;
      const controller = new PostController(postService);
      const user = { _id: 'user-1' } as any;

      const response = await controller.schedulePost(user, 'post-1', dto);

      expect(postService.schedulePost).toHaveBeenCalledWith(
        user,
        'post-1',
        dto,
      );
      expect(response.data).toBe(post);
    });
  });
});
