import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Artifact,
  ArtifactType,
  CarouselTheme,
  VersionStatus,
} from 'src/database/schemas';
import type { StylePreset } from 'src/agent/style-presets.config';
import {
  ArtifactWriter,
  CurrentVersionRead,
  VersionRender,
} from './artifact-writer.interface';
import { ArtifactContent, parseArtifactContent } from './schemas';

export interface CreateArtifactInput {
  type: ArtifactType;
  prompt: string;
  withResearch: boolean;
  stylePreset?: StylePreset;
  theme?: CarouselTheme;
}

@Injectable()
export class ArtifactService implements ArtifactWriter {
  constructor(
    @InjectModel(Artifact.name) private readonly artifactModel: Model<Artifact>,
  ) {}

  async createArtifact(
    userId: string,
    input: CreateArtifactInput,
  ): Promise<Artifact> {
    return this.artifactModel.create({
      user: new Types.ObjectId(userId),
      type: input.type,
      source: {
        prompt: input.prompt,
        withResearch: input.withResearch,
        ...(input.stylePreset ? { stylePreset: input.stylePreset } : {}),
        ...(input.theme ? { theme: input.theme } : {}),
      },
      currentVersion: 1,
      versions: [{ version: 1, status: VersionStatus.GENERATING, content: {} }],
    });
  }

  async setVersionContent(
    artifactId: string,
    version: number,
    content: ArtifactContent,
    render?: VersionRender,
  ): Promise<void> {
    const artifact = await this.getLiveArtifact(artifactId);
    if (!artifact.versions.some((v) => v.version === version)) {
      throw new NotFoundException(
        `Version ${version} not found on artifact ${artifactId}`,
      );
    }

    // Folding render.pdfKey/pageCount into content.document arrives with the
    // DOCUMENT arm (#122); the POST arm has no document object to fold into.
    void render;
    const parsed = parseArtifactContent(artifact.type, content);

    // The write targets the fixed (artifactId, version), so a whole-job retry
    // overwrites rather than appends.
    await this.artifactModel.updateOne(
      { _id: artifact._id, 'versions.version': version },
      {
        $set: {
          'versions.$.content': parsed,
          'versions.$.status': VersionStatus.READY,
        },
      },
    );
  }

  /**
   * Terminal end of a run: the version keeps its place in the artifact's
   * history rather than being removed, so the user can see what failed and
   * refine from it.
   */
  async failVersion(
    artifactId: string,
    version: number,
    failureReason: string,
  ): Promise<void> {
    const artifact = await this.getLiveArtifact(artifactId);
    if (!artifact.versions.some((v) => v.version === version)) {
      throw new NotFoundException(
        `Version ${version} not found on artifact ${artifactId}`,
      );
    }

    await this.artifactModel.updateOne(
      { _id: artifact._id, 'versions.version': version },
      {
        $set: {
          'versions.$.status': VersionStatus.FAILED,
          'versions.$.failureReason': failureReason,
        },
      },
    );
  }

  async readCurrent(artifactId: string): Promise<CurrentVersionRead> {
    const artifact = await this.getLiveArtifact(artifactId);
    const current = artifact.versions.find(
      (v) => v.version === artifact.currentVersion,
    );
    if (!current) {
      throw new NotFoundException(
        `Version ${artifact.currentVersion} not found on artifact ${artifactId}`,
      );
    }
    return {
      type: artifact.type,
      version: current.version,
      content: current.content as ArtifactContent,
    };
  }

  private async getLiveArtifact(artifactId: string): Promise<Artifact> {
    const artifact = await this.artifactModel.findById(artifactId);
    if (!artifact || artifact.deletedAt) {
      throw new NotFoundException(`Artifact ${artifactId} not found`);
    }
    return artifact;
  }
}
