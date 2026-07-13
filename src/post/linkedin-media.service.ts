import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ApiError, apiFetch } from 'src/common/HelperFn/apiFetch.helper';
import { delay } from 'src/common/HelperFn';
import { IVideoInitResponse } from './post.interface';

@Injectable()
export class LinkedinMediaService {
  private readonly LINKEDIN_API_BASE = 'https://api.linkedin.com/rest';

  async uploadImage(
    ownerUrn: string,
    accessToken: string,
    fileBuffer: Buffer,
  ): Promise<string> {
    interface IResponse {
      value: {
        uploadUrlExpiresAt: number;
        uploadUrl: string;
        image: string;
      };
    }
    try {
      const initializeUploadRequest = await apiFetch<IResponse>(
        `${this.LINKEDIN_API_BASE}/images?action=initializeUpload`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202601',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            initializeUploadRequest: {
              owner: ownerUrn,
            },
          }),
        },
      );

      await apiFetch(initializeUploadRequest.data.value.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'LinkedIn-Version': '202601',
          Authorization: `Bearer ${accessToken}`,
        },
        body: fileBuffer as unknown as BodyInit,
      });

      return initializeUploadRequest.data.value.image;
    } catch (error) {
      const message: unknown =
        error instanceof ApiError
          ? (error.data as { message?: unknown } | undefined)?.message
          : undefined;
      if (
        error instanceof ApiError &&
        error.statusCode === 400 &&
        typeof message === 'string' &&
        message.includes('Organization permissions must be used')
      ) {
        throw new BadRequestException(
          'Your LinkedIn account needs to be reconnected to enable company page posting. Please disconnect and reconnect your LinkedIn account.',
        );
      }
      throw error;
    }
  }

  async uploadVideo(
    ownerUrn: string,
    accessToken: string,
    fileBuffer: Buffer,
  ): Promise<string> {
    const linkedinHeaders = {
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': '202601',
      Authorization: `Bearer ${accessToken}`,
    };

    const initRes = await apiFetch<IVideoInitResponse>(
      `${this.LINKEDIN_API_BASE}/videos?action=initializeUpload`,
      {
        method: 'POST',
        headers: linkedinHeaders,
        body: JSON.stringify({
          initializeUploadRequest: {
            owner: ownerUrn,
            fileSizeBytes: fileBuffer.length,
            uploadCaptions: false,
            uploadThumbnail: false,
          },
        }),
      },
    );

    const {
      video: videoUrn,
      uploadToken,
      uploadInstructions,
    } = initRes.data.value;

    const eTags: string[] = [];
    for (const instruction of uploadInstructions) {
      const chunk = fileBuffer.subarray(
        instruction.firstByte,
        instruction.lastByte + 1,
      );
      const { response } = await apiFetch<void>(instruction.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunk as unknown as BodyInit,
      });
      const etag = response.headers.get('etag') ?? response.headers.get('ETag');
      if (!etag) {
        throw new InternalServerErrorException(
          'LinkedIn video chunk upload did not return an ETag',
        );
      }
      eTags.push(etag.replaceAll('"', ''));
    }

    await apiFetch(`${this.LINKEDIN_API_BASE}/videos?action=finalizeUpload`, {
      method: 'POST',
      headers: linkedinHeaders,
      body: JSON.stringify({
        finalizeUploadRequest: {
          video: videoUrn,
          uploadToken,
          uploadedPartIds: eTags,
        },
      }),
    });

    await this.waitForVideoAvailable(videoUrn, accessToken);
    return videoUrn;
  }

  async uploadDocument(
    ownerUrn: string,
    accessToken: string,
    fileBuffer: Buffer,
    pageCount: number,
  ): Promise<string> {
    const maxDocumentBytes = 100 * 1024 * 1024;
    if (fileBuffer.length > maxDocumentBytes) {
      throw new BadRequestException('LinkedIn documents cannot exceed 100 MB');
    }
    if (pageCount > 300) {
      throw new BadRequestException(
        'LinkedIn documents cannot exceed 300 pages',
      );
    }

    const headers = {
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': '202601',
      Authorization: `Bearer ${accessToken}`,
    };
    const { data } = await apiFetch<{
      value: { uploadUrl: string; document: string };
    }>(`${this.LINKEDIN_API_BASE}/documents?action=initializeUpload`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
    });

    await apiFetch(data.value.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Bearer ${accessToken}`,
      },
      body: fileBuffer as unknown as BodyInit,
    });
    await this.waitForDocumentAvailable(data.value.document, accessToken);
    return data.value.document;
  }

  private async waitForVideoAvailable(
    videoUrn: string,
    accessToken: string,
    timeoutMs = 300_000,
  ): Promise<void> {
    return this.waitForMediaAvailable(
      'video',
      videoUrn,
      accessToken,
      timeoutMs,
    );
  }

  private async waitForDocumentAvailable(
    documentUrn: string,
    accessToken: string,
    timeoutMs = 300_000,
  ): Promise<void> {
    return this.waitForMediaAvailable(
      'document',
      documentUrn,
      accessToken,
      timeoutMs,
    );
  }

  private async waitForMediaAvailable(
    mediaType: 'video' | 'document',
    mediaUrn: string,
    accessToken: string,
    timeoutMs: number,
  ): Promise<void> {
    const encodedUrn = encodeURIComponent(mediaUrn);
    const deadline = Date.now() + timeoutMs;
    const resource = `${mediaType}s`;

    while (Date.now() < deadline) {
      await delay(3000);
      const { data } = await apiFetch<{ status: string }>(
        `${this.LINKEDIN_API_BASE}/${resource}/${encodedUrn}`,
        {
          method: 'GET',
          headers: {
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202601',
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );
      if (data.status === 'AVAILABLE') return;
      if (data.status === 'PROCESSING_FAILED') {
        throw new InternalServerErrorException(
          `LinkedIn ${mediaType} processing failed`,
        );
      }
    }
    throw new InternalServerErrorException(
      `Timed out waiting for LinkedIn ${mediaType} to become available`,
    );
  }
}
