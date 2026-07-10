import { z } from 'zod';
import { ArtifactType } from 'src/database/schemas';
import { linkedInCharCount } from '../utils/linkedin-char-count.util';

export const LINKEDIN_MAX_POST_CHARS = 3000;

// POST — text is the whole artifact. The cap is counted the way LinkedIn
// counts: by UTF-16 code unit, so an astral-plane emoji costs 2.
export const postContentSchema = z.object({
  commentary: z
    .string()
    .min(1, 'commentary must not be empty')
    .refine((text) => linkedInCharCount(text) <= LINKEDIN_MAX_POST_CHARS, {
      message: `commentary exceeds ${LINKEDIN_MAX_POST_CHARS} LinkedIn characters`,
    }),
});

export type PostContent = z.infer<typeof postContentSchema>;

// Discriminated on the artifact's family-level `type`; grows a POLL and a
// DOCUMENT arm in later slices (#119, #122).
export type ArtifactContent = PostContent;

const contentSchemaByType: Partial<
  Record<ArtifactType, z.ZodType<ArtifactContent>>
> = {
  [ArtifactType.POST]: postContentSchema,
};

export function parseArtifactContent(
  type: ArtifactType,
  raw: unknown,
): ArtifactContent {
  const schema = contentSchemaByType[type];
  if (!schema) {
    throw new Error(`No content schema implemented for artifact type ${type}`);
  }
  return schema.parse(raw);
}
