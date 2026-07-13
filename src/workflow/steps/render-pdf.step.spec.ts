import { CarouselAssemblyError } from '../../carousel/carousel-renderer.error';
import { USAGE_KINDS } from '../../feature-gating/credit-meter.constants';
import { WorkflowError } from '../engine/workflow.error';
import type { RunState, StepContext } from '../engine/workflow.types';
import { renderPdfStep } from './render-pdf.step';

const documentContent = () => ({
  document: {
    templateId: 'minimal',
    slides: [
      { type: 'cover', fields: { title: 'Hello' } },
      { type: 'content', fields: { heading: 'A', body: 'B' } },
    ],
  },
});

const makeState = (overrides: Partial<RunState> = {}): RunState =>
  ({
    input: { artifactId: 'artifact-1', version: 2 },
    content: documentContent(),
    ...overrides,
  }) as unknown as RunState;

const makeCtx = () => {
  const render = jest.fn().mockResolvedValue({
    pdfKey: 'artifacts/artifact-1/2/document.pdf',
    pageCount: 2,
    browserlessDurationMs: 44_000,
    browserlessUnits: 2,
  });
  const record = jest.fn();
  const saveRenderUsage = jest.fn().mockResolvedValue(undefined);
  const emit = jest.fn();
  const ctx = {
    renderer: { render },
    meter: { record },
    run: { saveRenderUsage },
    emit,
  } as unknown as StepContext;
  return { ctx, render, record, saveRenderUsage, emit };
};

describe('renderPdfStep', () => {
  it('should render the document slides and write the render slot', async () => {
    const { ctx, render } = makeCtx();

    const patch = await renderPdfStep(makeState(), ctx);

    expect(render).toHaveBeenCalledWith({
      artifactId: 'artifact-1',
      version: 2,
      templateId: 'minimal',
      slides: documentContent().document.slides,
    });
    expect(patch).toEqual({
      render: {
        pdfKey: 'artifacts/artifact-1/2/document.pdf',
        pageCount: 2,
        browserlessDurationMs: 44_000,
        browserlessUnits: 2,
      },
    });
  });

  it('should meter measured Browserless units and persist auditable render usage on success', async () => {
    const { ctx, record, saveRenderUsage } = makeCtx();

    await renderPdfStep(makeState(), ctx);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      kind: USAGE_KINDS.PDF_RENDER,
      amount: 2,
      detail: { browserlessDurationMs: 44_000, browserlessUnits: 2 },
    });
    expect(saveRenderUsage).toHaveBeenCalledWith({
      durationMs: 44_000,
      units: 2,
    });
  });

  it('should emit no step.progress (R7)', async () => {
    const { ctx, emit } = makeCtx();

    await renderPdfStep(makeState(), ctx);

    expect(emit).not.toHaveBeenCalled();
  });

  it('should fail terminally when the content slot has no document', async () => {
    const { ctx, render, record } = makeCtx();
    const state = makeState({ content: { commentary: 'a post' } });

    await expect(renderPdfStep(state, ctx)).rejects.toMatchObject({
      retryable: false,
    });
    expect(render).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('should mark an assembly failure terminal', async () => {
    const { ctx, render, record } = makeCtx();
    render.mockRejectedValue(
      new CarouselAssemblyError('No carousel template for minimal/cover'),
    );

    const error = await renderPdfStep(makeState(), ctx).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(WorkflowError);
    expect(error).toMatchObject({ retryable: false });
    // A failed render is never billed.
    expect(record).not.toHaveBeenCalled();
  });

  it('should let a Browserless failure propagate unwrapped so it rides the retry budget', async () => {
    const { ctx, render, record } = makeCtx();
    const browserless = new Error('Browserless PDF generation failed: 504');
    render.mockRejectedValue(browserless);

    await expect(renderPdfStep(makeState(), ctx)).rejects.toBe(browserless);
    // Not classified terminal here — the engine's default rides the attempt budget.
    expect(record).not.toHaveBeenCalled();
  });
});
