import { Module } from '@nestjs/common';
import { ArtifactService } from './artifact.service';

// The Artifact model is registered globally by DatabaseModule, so no imports
// are needed here.
@Module({
  providers: [ArtifactService],
  exports: [ArtifactService],
})
export class ArtifactModule {}
