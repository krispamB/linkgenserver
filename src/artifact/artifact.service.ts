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
import {
  ArtifactContent,
  DocumentContent,
  parseArtifactContent,
} from './schemas';

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

    // For a DOCUMENT, fold RENDER_PDF's derived output onto the slides-only
    // content GENERATE produced; POST/POLL carry no document to fold into.
    const folded = this.foldRender(artifact.type, content, render);
    const parsed = parseArtifactContent(artifact.type, folded);

    // RENDER_PDF is what gates READY for a document: without a rendered pdfKey the
    // deck has no preview, so this flip would publish a half-built version.
    if (
      artifact.type === ArtifactType.DOCUMENT &&
      !(parsed as DocumentContent).document.pdfKey
    ) {
      throw new Error(
        `Cannot mark document ${artifactId} v${version} READY without a rendered pdfKey`,
      );
    }

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

  /**
   * Folds RENDER_PDF's `pdfKey`/`pageCount` onto a document's slides-only
   * content. A no-op for POST/POLL (no document object) and for a document
   * reached without a render (the gate below rejects that separately).
   */
  private foldRender(
    type: ArtifactType,
    content: ArtifactContent,
    render?: VersionRender,
  ): ArtifactContent {
    if (type !== ArtifactType.DOCUMENT || !render || !('document' in content)) {
      return content;
    }
    return {
      ...content,
      document: {
        ...content.document,
        pdfKey: render.pdfKey,
        pageCount: render.pageCount,
      },
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
