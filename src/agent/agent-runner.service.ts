import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ArtifactContent, contentSchemaFor } from '../artifact/schemas';
import { LLMProvider, MessageRole } from '../llm/interfaces';
import type { LLMMessage } from '../llm/interfaces';
import { LLMService } from '../llm/llm.service';
import { ResponseParserService } from '../llm/parsers/responseParser.service';
import { ContentValidationError } from './agent-runner.error';
import type {
  AgentHooks,
  AgentRunner,
  GenerateInput,
  ResearchResult,
} from './agent-runner.interface';
import {
  buildGenerationUserPrompt,
  buildRepairUserPrompt,
  generationSystemPrompt,
} from './prompts';

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Layer 2 of the agent stack: provider-agnostic, and the only place that knows
 * which prompt an artifact type takes.
 *
 * It never touches the meter. Usage leaves through `hooks.onUsage`, which the
 * `GENERATE` step bridges to `ctx.meter.record`.
 */
@Injectable()
export class AgentRunnerService implements AgentRunner {
  private readonly logger = new Logger(AgentRunnerService.name);
  private readonly generationModel: string;

  constructor(
    private readonly llmService: LLMService,
    private readonly parser: ResponseParserService,
    private readonly configService: ConfigService,
  ) {
    this.generationModel =
      this.configService.getOrThrow<string>('GENERATION_MODEL');
  }

  /**
   * The agentic half, landing with the tool loop. Unreachable today: the builder
   * only emits `RESEARCH` for a research-on run, and no handler is registered
   * for it, so the engine fails such a run before it gets here.
   */
  research(): Promise<ResearchResult> {
    return Promise.reject(
      new Error(
        'AgentRunner.research is not implemented until the agent loop lands',
      ),
    );
  }

  /**
   * Generation is not a loop: every input is already in hand, so this is one
   * `complete` call with no tools, plus at most one repair.
   *
   * The repair re-prompts with the exact validation error. A failure that
   * survives it is a `ContentValidationError` — terminal, per R2.
   */
  async generate(
    input: GenerateInput,
    hooks?: AgentHooks,
  ): Promise<ArtifactContent> {
    const schema = contentSchemaFor(input.type);
    const messages: LLMMessage[] = [
      { role: MessageRole.System, content: generationSystemPrompt(input.type) },
      { role: MessageRole.User, content: buildGenerationUserPrompt(input) },
    ];

    const draft = await this.complete(messages, hooks);

    let validationError: unknown;
    try {
      return this.parser.parseWithSchema(draft, schema);
    } catch (error: unknown) {
      validationError = error;
    }

    this.logger.warn(
      `Generated ${input.type} content failed validation; repairing: ${describeError(validationError)}`,
    );

    const repaired = await this.complete(
      [
        ...messages,
        { role: MessageRole.Assistant, content: draft },
        {
          role: MessageRole.User,
          content: buildRepairUserPrompt(describeError(validationError)),
        },
      ],
      hooks,
    );

    try {
      return this.parser.parseWithSchema(repaired, schema);
    } catch (error: unknown) {
      throw new ContentValidationError(
        `Generated ${input.type} content failed validation after one repair retry: ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * A repair turn is real spend, so it is announced like any other. Transport
   * errors are left alone: `src/llm` already classified them as retryable or
   * not, and this layer would only be guessing.
   */
  private async complete(
    messages: LLMMessage[],
    hooks?: AgentHooks,
  ): Promise<string> {
    const { text, usage } = await this.llmService.complete(
      LLMProvider.OPENROUTER,
      messages,
      { model: this.generationModel },
    );

    hooks?.onUsage?.({ ...usage, model: this.generationModel });

    return text;
  }
}
