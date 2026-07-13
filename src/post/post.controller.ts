import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PostService } from './post.service';
import { SchedulePostDto, CreatePostDto, GetPostsQueryDto } from './dto';
import { SubscriptionAccessGuard } from '../common/guards';
import { ClerkAuthGuard } from '../auth/clerk';
import { IAppResponse } from 'src/common/interfaces';
import { GetUser } from 'src/common/decorators';
import { User } from 'src/database/schemas';
import type { GetPostsResult } from './post.service';

@UseGuards(ClerkAuthGuard)
@Controller('posts')
export class PostController {
  constructor(private readonly postService: PostService) {}

  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SubscriptionAccessGuard)
  @Post()
  async createPost(
    @GetUser() user: User,
    @Body() dto: CreatePostDto,
  ): Promise<IAppResponse> {
    return {
      statusCode: HttpStatus.CREATED,
      message: 'Post created successfully',
      data: await this.postService.createPost(user, dto),
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/publish')
  async publishPost(
    @GetUser() user: User,
    @Param('id') id: string,
  ): Promise<IAppResponse> {
    return {
      statusCode: HttpStatus.OK,
      message: 'Post published successfully',
      data: await this.postService.publishPostNow(user, id),
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/schedule')
  async schedulePost(
    @GetUser() user: User,
    @Param('id') id: string,
    @Body() dto: SchedulePostDto,
  ): Promise<IAppResponse> {
    return {
      statusCode: HttpStatus.OK,
      message: 'Post scheduled successfully',
      data: await this.postService.schedulePost(user, id, dto),
    };
  }

  @Get()
  async getPosts(
    @GetUser() user: User,
    @Query() query: GetPostsQueryDto,
  ): Promise<IAppResponse> {
    const result: GetPostsResult = await this.postService.getPosts(
      user,
      query.connectedAccount,
      query.status,
      query.month,
      query.page,
    );

    return {
      statusCode: HttpStatus.OK,
      message: 'Posts retrieved successfully',
      data: result.data,
      filters: result.filters,
    };
  }

  @Delete(':id')
  async deletePost(
    @GetUser() user: User,
    @Param('id') id: string,
  ): Promise<IAppResponse> {
    await this.postService.deletePost(user, id);
    return {
      statusCode: HttpStatus.OK,
      message: 'Post deleted successfully',
    };
  }

  @Get('metrics/:connectedAccountId')
  async getPostMetrics(
    @GetUser() user: User,
    @Param('connectedAccountId') connectedAccountId: string,
  ): Promise<IAppResponse> {
    return {
      statusCode: HttpStatus.OK,
      message: 'Post metrics retrieved successfully',
      data: await this.postService.getPostMetrics(user, connectedAccountId),
    };
  }

  @Get('linkedin/image/:urn')
  async getLinkedinImage(
    @GetUser() user: User,
    @Param('urn') urn: string,
  ): Promise<IAppResponse> {
    return {
      statusCode: HttpStatus.OK,
      message: 'Image details retrieved successfully',
      data: await this.postService.getLinkedinImage(user, urn),
    };
  }

  @Get(':id')
  async getPostById(
    @GetUser() user: User,
    @Param('id') id: string,
  ): Promise<IAppResponse> {
    return {
      statusCode: HttpStatus.OK,
      message: 'Post retrieved successfully',
      data: await this.postService.getPost(user, id),
    };
  }
}
