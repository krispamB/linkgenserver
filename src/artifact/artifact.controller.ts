import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
// Direct file import (not the ../auth/clerk barrel) to avoid a require cycle:
// the barrel loads ClerkAuthModule, which imports WorkflowModule.
import { ClerkAuthGuard } from '../auth/clerk/clerk-auth.guard';
import { GetUser } from '../common/decorators';
import { User } from '../database/schemas';
import {
  ArtifactGenerationService,
  LaunchResult,
  RefineLaunchResult,
} from './artifact-generation.service';
import { CreateArtifactDto, RefineArtifactDto } from './dto';

@UseGuards(ClerkAuthGuard)
@Controller('artifacts')
export class ArtifactController {
  constructor(private readonly generation: ArtifactGenerationService) {}

  /**
   * Create an artifact and kick off its generation run. Responds `202` with the
   * `{ artifactId, runId }` the client uses to open the SSE progress stream —
   * creation is async because research + LLM + render take tens of seconds.
   */
  @HttpCode(HttpStatus.ACCEPTED)
  @Post()
  create(
    @GetUser() user: User,
    @Body() dto: CreateArtifactDto,
  ): Promise<LaunchResult> {
    return this.generation.launchInitialRun(user._id.toString(), dto);
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Post(':id/refine')
  refine(
    @GetUser() user: User,
    @Param('id') artifactId: string,
    @Body() dto: RefineArtifactDto,
  ): Promise<RefineLaunchResult> {
    return this.generation.launchRefineRun(
      user._id.toString(),
      artifactId,
      dto.feedback,
    );
  }
}
