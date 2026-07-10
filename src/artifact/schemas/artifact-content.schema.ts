import { z } from 'zod';
import { ArtifactType } from 'src/database/schemas';
import { linkedInCharCount } from '../utils/linkedin-char-count.util';

export const LINKEDIN_MAX_POST_CHARS = 3000;
export const LINKEDIN_MAX_POLL_QUESTION_CHARS = 140;
export const LINKEDIN_MAX_POLL_OPTION_CHARS = 30;
export const POLL_DURATION_DAYS = [1, 3, 7, 14] as const;

// The commentary cap is counted the way LinkedIn counts: by UTF-16 code unit,
// so an astral-plane emoji costs 2. Shared by every arm that carries commentary.
const commentarySchema = z
  .string()
  .min(1, 'commentary must not be empty')
  .refine((text) => linkedInCharCount(text) <= LINKEDIN_MAX_POST_CHARS, {
    message: `commentary exceeds ${LINKEDIN_MAX_POST_CHARS} LinkedIn characters`,
  });

// POST — text is the whole artifact.
export const postContentSchema = z.object({
  commentary: commentarySchema,
});

export type PostContent = z.infer<typeof postContentSchema>;

// POLL — an inline poll object, optionally introduced by commentary. No binary
// asset ever, so this arm never touches R2 or a render step. Its constraints
// were carried forward from the now-deleted poll.util.ts — including the
// case-insensitive, trimmed option-uniqueness rule that earlier designs omitted.
export const pollContentSchema = z.object({
  commentary: commentarySchema.optional(),
  poll: z.object({
    question: z
      .string()
      .refine((text) => text.trim().length > 0, 'question must not be empty')
      .refine(
        (text) => linkedInCharCount(text) <= LINKEDIN_MAX_POLL_QUESTION_CHARS,
        {
          message: `question exceeds ${LINKEDIN_MAX_POLL_QUESTION_CHARS} LinkedIn characters`,
        },
      ),
    options: z
      .array(
        z
          .string()
          .refine((text) => text.trim().length > 0, 'option must not be empty')
          .refine(
            (text) => linkedInCharCount(text) <= LINKEDIN_MAX_POLL_OPTION_CHARS,
            {
              message: `option exceeds ${LINKEDIN_MAX_POLL_OPTION_CHARS} LinkedIn characters`,
            },
          ),
      )
      .min(2, 'poll must have at least 2 options')
      .max(4, 'poll cannot have more than 4 options')
      .refine(
        (options) =>
          new Set(options.map((o) => o.trim().toLowerCase())).size ===
          options.length,
        { message: 'poll options must be unique' },
      ),
    durationDays: z
      .number()
      .refine(
        (days): days is (typeof POLL_DURATION_DAYS)[number] =>
          (POLL_DURATION_DAYS as readonly number[]).includes(days),
        {
          message: `durationDays must be one of ${POLL_DURATION_DAYS.join(', ')}`,
        },
      ),
  }),
});

export type PollContent = z.infer<typeof pollContentSchema>;

// Discriminated on the artifact's family-level `type`; grows a DOCUMENT arm in a
// later slice (#122).
export type ArtifactContent = PostContent | PollContent;

const contentSchemaByType: Partial<
  Record<ArtifactType, z.ZodType<ArtifactContent>>
> = {
  [ArtifactType.POST]: postContentSchema,
  [ArtifactType.POLL]: pollContentSchema,
};

/**
 * The schema itself, for callers that validate raw text rather than a parsed
 * object — `AgentRunner.generate` hands it to `parseWithSchema`, which needs to
 * own the JSON.parse step so a malformed body and a schema violation reach the
 * repair retry through the same path.
 */
export function contentSchemaFor(
  type: ArtifactType,
): z.ZodType<ArtifactContent> {
  const schema = contentSchemaByType[type];
  if (!schema) {
    throw new Error(`No content schema implemented for artifact type ${type}`);
  }
  return schema;
}

export function parseArtifactContent(
  type: ArtifactType,
  raw: unknown,
): ArtifactContent {
  return contentSchemaFor(type).parse(raw);
}
