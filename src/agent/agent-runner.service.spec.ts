// The real strategy drags the ESM-only OpenRouter SDK into the transform.
jest.mock('../llm/llm.service', () => ({
  LLMService: class LLMService {},
}));

jest.mock(
  'src/database/schemas',
  () => ({
    ArtifactType: { POST: 'POST', POLL: 'POLL', DOCUMENT: 'DOCUMENT' },
    CarouselTheme: { MINIMAL: 'minimal' },
  }),
  { virtual: true },
);

import { ArtifactType, CarouselTheme } from 'src/database/schemas';
import { LLMError } from '../llm/errors';
import { LLMProvider, MessageRole } from '../llm/interfaces';
import type { CompletionResult, LLMMessage } from '../llm/interfaces';
import { ResponseParserService } from '../llm/parsers/responseParser.service';
import { ContentValidationError } from './agent-runner.error';
import { AgentRunnerService } from './agent-runner.service';
import type { GenerateInput } from './agent-runner.interface';
import { StylePreset } from './style-presets.config';

const GENERATION_MODEL = 'test/generation-model';

const completion = (text: string, cost = 0.02): CompletionResult => ({
  text,
  usage: {
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    cost,
  },
});

const makeService = () => {
  const llmService = { complete: jest.fn() };
  const configService = {
    getOrThrow: jest.fn(() => GENERATION_MODEL),
  };

  // The real parser: this suite's whole subject is what happens when the model's
  // text does or does not satisfy the schema, so stubbing it out would test nothing.
  const service = new AgentRunnerService(
    llmService as any,
    new ResponseParserService(),
    configService as any,
  );

  const input: GenerateInput = {
    type: ArtifactType.POST,
    prompt: 'Why staff engineers should write more',
  };

  return { service, mocks: { llmService, configService }, fixtures: { input } };
};

let service: AgentRunnerService;
let mocks: ReturnType<typeof makeService>['mocks'];
let fixtures: ReturnType<typeof makeService>['fixtures'];

/** The messages passed to `llmService.complete` on its nth (1-based) call. */
const messagesOfCall = (n: number): LLMMessage[] =>
  mocks.llmService.complete.mock.calls[n - 1][1] as LLMMessage[];

beforeEach(() => {
  jest.clearAllMocks();
  ({ service, mocks, fixtures } = makeService());
});

describe('AgentRunnerService', () => {
  describe('generate', () => {
    it('should return parsed content when the first completion is valid', async () => {
      mocks.llmService.complete.mockResolvedValue(
        completion('{"commentary":"Write more."}'),
      );

      await expect(service.generate(fixtures.input)).resolves.toEqual({
        commentary: 'Write more.',
      });
      expect(mocks.llmService.complete).toHaveBeenCalledTimes(1);
    });

    it('should call the configured GENERATION_MODEL through the OpenRouter provider', async () => {
      mocks.llmService.complete.mockResolvedValue(
        completion('{"commentary":"Write more."}'),
      );

      await service.generate(fixtures.input);

      expect(mocks.llmService.complete).toHaveBeenCalledWith(
        LLMProvider.OPENROUTER,
        expect.any(Array),
        { model: GENERATION_MODEL },
      );
    });

    it('should strip markdown fences before validating', async () => {
      mocks.llmService.complete.mockResolvedValue(
        completion('```json\n{"commentary":"Fenced."}\n```'),
      );

      await expect(service.generate(fixtures.input)).resolves.toEqual({
        commentary: 'Fenced.',
      });
    });

    it('should inject the style preset instruction as voice when one is supplied', async () => {
      mocks.llmService.complete.mockResolvedValue(
        completion('{"commentary":"Bold take."}'),
      );

      await service.generate({
        ...fixtures.input,
        stylePreset: StylePreset.CONTRARIAN,
      });

      const [, user] = messagesOfCall(1);
      expect(user.content).toContain('VOICE:');
      expect(user.content).toContain('Challenge a common assumption');
    });

    it('should omit the voice section when no style preset is supplied', async () => {
      mocks.llmService.complete.mockResolvedValue(
        completion('{"commentary":"Plain."}'),
      );

      await service.generate(fixtures.input);

      const [system, user] = messagesOfCall(1);
      expect(system.role).toBe(MessageRole.System);
      expect(user.content).not.toContain('VOICE:');
    });

    it('should pass research findings and sources into the brief when present', async () => {
      mocks.llmService.complete.mockResolvedValue(
        completion('{"commentary":"Researched."}'),
      );

      await service.generate({
        ...fixtures.input,
        research: {
          findings: 'Staff engineers who write get promoted.',
          sources: [{ title: 'StaffEng', url: 'https://staffeng.com' }],
        },
      });

      const [, user] = messagesOfCall(1);
      expect(user.content).toContain('Staff engineers who write get promoted.');
      expect(user.content).toContain('https://staffeng.com');
    });

    it('should pass the prior content and feedback into the brief on a refine', async () => {
      mocks.llmService.complete.mockResolvedValue(
        completion('{"commentary":"Revised."}'),
      );

      await service.generate({
        ...fixtures.input,
        refine: {
          priorContent: { commentary: 'The old post.' },
          feedback: 'Make the hook sharper.',
        },
      });

      const [, user] = messagesOfCall(1);
      expect(user.content).toContain('The old post.');
      expect(user.content).toContain('Make the hook sharper.');
    });

    it('should report usage per LLM turn, tagged with the model', async () => {
      mocks.llmService.complete.mockResolvedValue(
        completion('{"commentary":"Write more."}', 0.031),
      );
      const onUsage = jest.fn();

      await service.generate(fixtures.input, { onUsage });

      expect(onUsage).toHaveBeenCalledTimes(1);
      expect(onUsage).toHaveBeenCalledWith({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cost: 0.031,
        model: GENERATION_MODEL,
      });
    });

    describe('the inline repair retry', () => {
      it('should re-prompt with the validation error and return the repaired content', async () => {
        mocks.llmService.complete
          .mockResolvedValueOnce(completion('{"commentary":""}'))
          .mockResolvedValueOnce(completion('{"commentary":"Repaired."}'));

        await expect(service.generate(fixtures.input)).resolves.toEqual({
          commentary: 'Repaired.',
        });
        expect(mocks.llmService.complete).toHaveBeenCalledTimes(2);

        const repair = messagesOfCall(2);
        expect(repair).toHaveLength(4);
        expect(repair[2]).toEqual({
          role: MessageRole.Assistant,
          content: '{"commentary":""}',
        });
        expect(repair[3].role).toBe(MessageRole.User);
        expect(repair[3].content).toContain('commentary must not be empty');
      });

      it('should repair a response that is not JSON at all', async () => {
        mocks.llmService.complete
          .mockResolvedValueOnce(completion('I cannot do that.'))
          .mockResolvedValueOnce(completion('{"commentary":"Fine, here."}'));

        await expect(service.generate(fixtures.input)).resolves.toEqual({
          commentary: 'Fine, here.',
        });
      });

      it('should charge usage for the repair turn too', async () => {
        mocks.llmService.complete
          .mockResolvedValueOnce(completion('{"commentary":""}', 0.01))
          .mockResolvedValueOnce(
            completion('{"commentary":"Repaired."}', 0.02),
          );
        const onUsage = jest.fn();

        await service.generate(fixtures.input, { onUsage });

        expect(onUsage).toHaveBeenCalledTimes(2);
        expect(onUsage).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ cost: 0.02 }),
        );
      });

      it('should throw ContentValidationError when the repair is also invalid', async () => {
        mocks.llmService.complete.mockResolvedValue(
          completion('{"commentary":""}'),
        );

        await expect(service.generate(fixtures.input)).rejects.toBeInstanceOf(
          ContentValidationError,
        );
        expect(mocks.llmService.complete).toHaveBeenCalledTimes(2);
      });

      it('should not attempt a second repair', async () => {
        mocks.llmService.complete.mockResolvedValue(completion('not json'));

        await expect(service.generate(fixtures.input)).rejects.toBeInstanceOf(
          ContentValidationError,
        );
        expect(mocks.llmService.complete).toHaveBeenCalledTimes(2);
      });
    });

    it('should let an LLM transport error through unchanged, so the engine can classify it', async () => {
      const transportError = new LLMError('rate limited', {
        retryable: true,
        statusCode: 429,
      });
      mocks.llmService.complete.mockRejectedValue(transportError);

      await expect(service.generate(fixtures.input)).rejects.toBe(
        transportError,
      );
      expect(mocks.llmService.complete).toHaveBeenCalledTimes(1);
    });

    it('should let an LLM transport error during the repair turn through unchanged', async () => {
      const transportError = new LLMError('gateway down', { retryable: true });
      mocks.llmService.complete
        .mockResolvedValueOnce(completion('{"commentary":""}'))
        .mockRejectedValueOnce(transportError);

      await expect(service.generate(fixtures.input)).rejects.toBe(
        transportError,
      );
    });

    it('should throw when no generation prompt exists for the artifact type', async () => {
      await expect(
        service.generate({
          ...fixtures.input,
          type: ArtifactType.DOCUMENT,
          theme: CarouselTheme.MINIMAL,
        }),
      ).rejects.toThrow('DOCUMENT');
      expect(mocks.llmService.complete).not.toHaveBeenCalled();
    });
  });

  describe('research', () => {
    it('should throw until the agent loop lands', async () => {
      await expect(
        service.research({ prompt: 'anything', type: ArtifactType.POST }),
      ).rejects.toThrow(/not implemented/i);
    });
  });
});
