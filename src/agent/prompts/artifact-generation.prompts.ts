import { ArtifactType } from 'src/database/schemas';
import type { GenerateInput } from '../agent-runner.interface';
import { resolveStylePresetInstruction } from '../style-presets.config';

// `generate` is a single structured completion, so the system prompt carries the
// whole output contract: the model gets one shot plus one repair, and both are
// judged by the same Zod schema.
export const GENERATE_POST_SYSTEM_PROMPT = `ROLE:
You are a professional LinkedIn writer. You produce a single, publishable post
that delivers real value to a professional audience.

TASK:
Write one LinkedIn post from the brief the user supplies.

OUTPUT:
Return ONLY a JSON object matching this shape, with no prose, commentary, or
markdown fences around it:

{ "commentary": "the full text of the post" }

The post text lives entirely in "commentary". Newlines inside it must be escaped
as \\n, and the string must be valid JSON.

CONSTRAINTS:
- "commentary" must be non-empty and at most 3000 characters.
- Open with a hook that earns the next line, develop 2-4 connected ideas, and
  close with a takeaway the reader can act on.
- If a VOICE instruction is supplied, follow it as the highest-priority guidance
  for tone and framing.
- If RESEARCH FINDINGS are supplied, ground every factual claim in them and
  introduce no facts they do not support. If they are absent, rely on the brief
  and general domain reasoning, and make no unsupported claims.
- Avoid hype, clickbait, and generic motivation. Prefer clarity over cleverness.
- Use emojis only where they add meaning; default to none.
- Do not mention the brief, the research, or that you are an AI.`;

export const GENERATE_POLL_SYSTEM_PROMPT = `ROLE:
You are a professional LinkedIn writer. You craft engaging polls that spark
useful discussion among a professional audience.

TASK:
Design one LinkedIn poll from the brief the user supplies: a single question and
2-4 answer options, plus optional commentary that frames the poll.

OUTPUT:
Return ONLY a JSON object matching this shape, with no prose, commentary, or
markdown fences around it:

{ "commentary": "optional framing text", "poll": { "question": "the poll question", "options": ["option one", "option two"], "durationDays": 7 } }

"commentary" is optional — omit the key entirely if the poll needs no framing.
Newlines inside any string must be escaped as \\n, and the whole object must be
valid JSON.

CONSTRAINTS:
- "question" must be non-empty and at most 140 characters.
- "options" must hold 2 to 4 entries. Each is non-empty, at most 30 characters,
  and mutually distinct (comparison ignores case and surrounding whitespace).
- "durationDays" must be exactly one of 1, 3, 7, or 14.
- "commentary", when present, must be non-empty and at most 3000 characters.
- Make the options collectively exhaustive and genuinely distinct, so a reader
  can find their answer without wanting a fifth choice.
- If a VOICE instruction is supplied, follow it as the highest-priority guidance
  for tone and framing.
- If RESEARCH FINDINGS are supplied, ground the question and options in them and
  introduce nothing they do not support. If they are absent, rely on the brief
  and general domain reasoning, and make no unsupported claims.
- Avoid hype, clickbait, and leading questions. Prefer clarity over cleverness.
- Do not mention the brief, the research, or that you are an AI.`;

/**
 * A switch rather than a module-scope lookup table: the enum is read when a
 * prompt is asked for, not when this module loads, so importing it never
 * depends on the schema barrel having been fully evaluated.
 *
 * DOCUMENT arrives with its own slice.
 */
export function generationSystemPrompt(type: ArtifactType): string {
  switch (type) {
    case ArtifactType.POST:
      return GENERATE_POST_SYSTEM_PROMPT;
    case ArtifactType.POLL:
      return GENERATE_POLL_SYSTEM_PROMPT;
    default:
      throw new Error(
        `No generation prompt implemented for artifact type ${type}`,
      );
  }
}

/**
 * The brief. Sections appear only when they carry content, so an unresearched,
 * unstyled initial run sends the model nothing but the topic.
 */
export function buildGenerationUserPrompt(input: GenerateInput): string {
  const sections = [`BRIEF:\n${input.prompt}`];

  const voice = resolveStylePresetInstruction(input.stylePreset);
  if (voice) sections.push(`VOICE:\n${voice}`);

  if (input.research) {
    sections.push(`RESEARCH FINDINGS:\n${input.research.findings}`);
    if (input.research.sources.length > 0) {
      const sources = input.research.sources
        .map((source) => `- ${source.title} (${source.url})`)
        .join('\n');
      sections.push(`SOURCES:\n${sources}`);
    }
  }

  if (input.refine) {
    sections.push(
      `PREVIOUS VERSION:\n${JSON.stringify(input.refine.priorContent)}`,
      `REVISION FEEDBACK:\n${input.refine.feedback}\n\nRewrite the post to address the feedback. Keep what the feedback does not ask you to change.`,
    );
  }

  return sections.join('\n\n');
}

/**
 * The repair turn. Handing the model the exact validation error is what makes
 * this a *warm* resample — and why a post-repair failure is terminal (R2)
 * rather than something a cold whole-job retry could do better.
 */
export function buildRepairUserPrompt(validationError: string): string {
  return `Your previous response was rejected:

${validationError}

Return a corrected JSON object that satisfies the schema. Output only the JSON object.`;
}
