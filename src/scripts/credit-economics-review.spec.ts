import {
  analyzeCreditEconomics,
  renderCreditEconomicsReport,
  type CreditEconomicsReviewInput,
} from './credit-economics-review';

describe('credit economics review', () => {
  const makeInput = (): CreditEconomicsReviewInput => ({
    cohort: {
      paidUsers: 100,
      billingCycle: {
        start: '2026-06-01T00:00:00.000Z',
        end: '2026-07-01T00:00:00.000Z',
        complete: false,
      },
    },
    runs: [
      {
        artifactType: 'POST',
        withResearch: false,
        credits: 10,
        successfulTavilyLookups: 0,
        browserlessUnits: [],
        attempts: 1,
        status: 'COMPLETED',
      },
      {
        artifactType: 'POST',
        withResearch: false,
        credits: 20,
        successfulTavilyLookups: 0,
        browserlessUnits: [],
        attempts: 2,
        status: 'COMPLETED',
      },
      {
        artifactType: 'POST',
        withResearch: true,
        credits: 50,
        successfulTavilyLookups: 1,
        browserlessUnits: [],
        attempts: 1,
        status: 'COMPLETED',
      },
      {
        artifactType: 'POST',
        withResearch: true,
        credits: 90,
        successfulTavilyLookups: 5,
        browserlessUnits: [],
        attempts: 1,
        status: 'FAILED',
      },
      {
        artifactType: 'POLL',
        withResearch: false,
        credits: 12,
        successfulTavilyLookups: 0,
        browserlessUnits: [],
        attempts: 1,
        status: 'COMPLETED',
      },
      {
        artifactType: 'POLL',
        withResearch: false,
        credits: 24,
        successfulTavilyLookups: 0,
        browserlessUnits: [],
        attempts: 1,
        status: 'COMPLETED',
      },
      {
        artifactType: 'POLL',
        withResearch: true,
        credits: 60,
        successfulTavilyLookups: 2,
        browserlessUnits: [],
        attempts: 1,
        status: 'COMPLETED',
      },
      {
        artifactType: 'POLL',
        withResearch: true,
        credits: 100,
        successfulTavilyLookups: 4,
        browserlessUnits: [],
        attempts: 1,
        status: 'COMPLETED',
      },
      {
        artifactType: 'DOCUMENT',
        withResearch: false,
        credits: 20,
        successfulTavilyLookups: 0,
        browserlessUnits: [1],
        attempts: 1,
        status: 'COMPLETED',
      },
      {
        artifactType: 'DOCUMENT',
        withResearch: false,
        credits: 40,
        successfulTavilyLookups: 0,
        browserlessUnits: [2, 3],
        attempts: 2,
        status: 'COMPLETED',
      },
      {
        artifactType: 'DOCUMENT',
        withResearch: true,
        credits: 80,
        successfulTavilyLookups: 3,
        browserlessUnits: [2],
        attempts: 1,
        status: 'COMPLETED',
      },
      {
        artifactType: 'DOCUMENT',
        withResearch: true,
        credits: 120,
        successfulTavilyLookups: 5,
        browserlessUnits: [4],
        attempts: 1,
        status: 'COMPLETED',
      },
    ],
    providerInvoices: [
      { provider: 'OPENROUTER', amountUsd: 100, reference: 'inv-openrouter' },
      { provider: 'TAVILY', amountUsd: 30, reference: 'inv-tavily' },
      { provider: 'BROWSERLESS', amountUsd: 20, reference: 'inv-browserless' },
    ],
    tiers: [
      {
        tier: 'Starter',
        paidUsers: 50,
        allowanceCredits: 2000,
        exhaustedUsers: 5,
        subscriptionRevenueUsd: 500,
        providerCostUsd: 50,
      },
      {
        tier: 'Creator',
        paidUsers: 30,
        allowanceCredits: 10000,
        exhaustedUsers: 6,
        subscriptionRevenueUsd: 600,
        providerCostUsd: 120,
      },
      {
        tier: 'Pro Writer',
        paidUsers: 20,
        allowanceCredits: 30000,
        exhaustedUsers: 10,
        subscriptionRevenueUsd: 600,
        providerCostUsd: 180,
      },
    ],
    decision: {
      owner: 'Pricing Owner',
      decidedAt: '2026-07-02T00:00:00.000Z',
      items: [
        { area: 'MARKUP', action: 'RETAIN', rationale: 'Margins are healthy.' },
        {
          area: 'SEARCH_PRICING',
          action: 'RETAIN',
          rationale: 'Lookup economics match plan.',
        },
        {
          area: 'RENDER_PRICING',
          action: 'RETAIN',
          rationale: 'Render units are covered.',
        },
        {
          area: 'TIER_ALLOWANCES',
          action: 'RETAIN',
          rationale: 'Exhaustion is acceptable.',
        },
        {
          area: 'TOP_UPS',
          action: 'RETAIN',
          rationale: 'Do not introduce top-ups yet.',
        },
      ],
    },
  });

  describe('analyzeCreditEconomics', () => {
    it('should reject an incomplete cycle with fewer than 100 paid users', () => {
      const input = makeInput();
      input.cohort.paidUsers = 99;
      input.tiers[0].paidUsers = 49;

      expect(() => analyzeCreditEconomics(input)).toThrow(
        'requires one complete paid billing cycle or a cohort of 100 to 200 paid users',
      );
    });

    it('should accept a complete paid billing cycle with fewer than 100 users', () => {
      const input = makeInput();
      input.cohort.billingCycle.complete = true;
      input.cohort.paidUsers = 99;
      input.tiers[0].paidUsers = 49;

      expect(analyzeCreditEconomics(input).eligibilityBasis).toBe(
        'complete paid billing cycle',
      );
    });

    it('should report p50 and p95 credits for every artifact and research slice', () => {
      const review = analyzeCreditEconomics(makeInput());

      expect(review.artifactCredits).toHaveLength(6);
      expect(review.artifactCredits).toContainEqual({
        artifactType: 'POST',
        withResearch: false,
        sampleSize: 2,
        p50: 10,
        p95: 20,
      });
      expect(review.artifactCredits).toContainEqual({
        artifactType: 'DOCUMENT',
        withResearch: true,
        sampleSize: 2,
        p50: 80,
        p95: 120,
      });
      expect(review.artifactCredits).toContainEqual({
        artifactType: 'POST',
        withResearch: true,
        sampleSize: 1,
        p50: 50,
        p95: 50,
      });
    });

    it('should reject a review missing one artifact and research slice', () => {
      const input = makeInput();
      input.runs = input.runs.filter(
        (run) => !(run.artifactType === 'POLL' && run.withResearch),
      );

      expect(() => analyzeCreditEconomics(input)).toThrow(
        'missing run samples for POLL with research',
      );
    });

    it('should report provider operations, retries, failures, and invoice reconciliation', () => {
      const review = analyzeCreditEconomics(makeInput());

      expect(review.operations).toEqual({
        researchRuns: 6,
        tavilyLookups: { p50: 3, p95: 5, mean: 3.33 },
        browserlessRenders: 5,
        browserlessUnits: { p50: 2, p95: 4, mean: 2.4 },
        retryRatePercent: 16.67,
        failureRatePercent: 8.33,
      });
      expect(review.invoices).toMatchObject({
        invoiceTotalUsd: 150,
        attributedProviderCostUsd: 350,
        reconciliationDeltaUsd: -200,
      });
    });

    it('should compare realized margin and exhaustion with intended tier economics', () => {
      const review = analyzeCreditEconomics(makeInput());

      expect(review.tiers).toContainEqual({
        tier: 'Creator',
        paidUsers: 30,
        allowanceCredits: 10000,
        exhaustionRatePercent: 20,
        subscriptionRevenueUsd: 600,
        providerCostUsd: 120,
        realizedGrossMarginPercent: 80,
        intendedGrossMarginFloorPercent: 75,
        marginDeltaPercent: 5,
      });
    });

    it('should require a separate implementation issue for every approved change', () => {
      const input = makeInput();
      input.decision.items[0] = {
        area: 'MARKUP',
        action: 'CHANGE',
        rationale: 'Observed costs require a change.',
      };

      expect(() => analyzeCreditEconomics(input)).toThrow(
        'MARKUP changes require a separate implementation issue',
      );
    });

    it('should reject unlimited current or proposed paid allowances', () => {
      const current = makeInput();
      current.tiers[2].allowanceCredits = -1;
      expect(() => analyzeCreditEconomics(current)).toThrow();

      const proposed = makeInput();
      proposed.decision.items[3] = {
        area: 'TIER_ALLOWANCES',
        action: 'CHANGE',
        rationale: 'Change allowances.',
        implementationIssue:
          'https://github.com/krispamB/linkgenserver/issues/200',
        proposedTierAllowances: {
          Starter: 2000,
          Creator: 10000,
          'Pro Writer': -1,
        },
      };
      expect(() => analyzeCreditEconomics(proposed)).toThrow();
    });
  });

  describe('renderCreditEconomicsReport', () => {
    it('should render the evidence, margin comparison, and human decision', () => {
      const report = renderCreditEconomicsReport(
        analyzeCreditEconomics(makeInput()),
      );

      expect(report).toContain('# Production Credit Economics Review');
      expect(report).toContain('| POST | No | 2 | 10 | 20 |');
      expect(report).toContain('| Creator | 30 | 10,000 | 20.00% |');
      expect(report).toContain('inv-openrouter');
      expect(report).toContain('Pricing Owner');
      expect(report).toContain('| MARKUP | RETAIN | Margins are healthy. |');
    });
  });
});
