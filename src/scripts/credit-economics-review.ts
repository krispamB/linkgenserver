import { z } from 'zod';

const artifactTypes = ['POST', 'POLL', 'DOCUMENT'] as const;
const paidTiers = ['Starter', 'Creator', 'Pro Writer'] as const;
const decisionAreas = [
  'MARKUP',
  'SEARCH_PRICING',
  'RENDER_PRICING',
  'TIER_ALLOWANCES',
  'TOP_UPS',
] as const;

type ArtifactType = (typeof artifactTypes)[number];
type PaidTier = (typeof paidTiers)[number];

const finiteAllowanceSchema = z.number().int().positive();

const decisionItemSchema = z.object({
  area: z.enum(decisionAreas),
  action: z.enum(['RETAIN', 'CHANGE']),
  rationale: z.string().trim().min(1),
  implementationIssue: z.string().url().optional(),
  proposedTierAllowances: z
    .object({
      Starter: finiteAllowanceSchema,
      Creator: finiteAllowanceSchema,
      'Pro Writer': finiteAllowanceSchema,
    })
    .optional(),
});

export const creditEconomicsReviewInputSchema = z
  .object({
    cohort: z.object({
      paidUsers: z.number().int().positive(),
      billingCycle: z.object({
        start: z.string().datetime(),
        end: z.string().datetime(),
        complete: z.boolean(),
      }),
    }),
    runs: z
      .array(
        z
          .object({
            artifactType: z.enum(artifactTypes),
            withResearch: z.boolean(),
            credits: z.number().int().nonnegative(),
            successfulTavilyLookups: z.number().int().min(0).max(5),
            browserlessUnits: z.array(z.number().int().positive()),
            attempts: z.number().int().positive(),
            status: z.enum(['COMPLETED', 'FAILED']),
          })
          .superRefine((run, ctx) => {
            if (!run.withResearch && run.successfulTavilyLookups !== 0) {
              ctx.addIssue({
                code: 'custom',
                path: ['successfulTavilyLookups'],
                message: 'non-research runs cannot contain Tavily lookups',
              });
            }
            if (
              run.artifactType !== 'DOCUMENT' &&
              run.browserlessUnits.length > 0
            ) {
              ctx.addIssue({
                code: 'custom',
                path: ['browserlessUnits'],
                message: 'only DOCUMENT runs can contain Browserless renders',
              });
            }
          }),
      )
      .min(1),
    providerInvoices: z
      .array(
        z.object({
          provider: z.enum(['OPENROUTER', 'TAVILY', 'BROWSERLESS']),
          amountUsd: z.number().nonnegative(),
          reference: z.string().trim().min(1),
        }),
      )
      .min(3),
    tiers: z
      .array(
        z.object({
          tier: z.enum(paidTiers),
          paidUsers: z.number().int().nonnegative(),
          allowanceCredits: finiteAllowanceSchema,
          exhaustedUsers: z.number().int().nonnegative(),
          subscriptionRevenueUsd: z.number().nonnegative(),
          providerCostUsd: z.number().nonnegative(),
        }),
      )
      .length(3),
    decision: z.object({
      owner: z.string().trim().min(1),
      decidedAt: z.string().datetime(),
      items: z.array(decisionItemSchema).length(5),
    }),
  })
  .superRefine((input, ctx) => {
    if (
      new Date(input.cohort.billingCycle.end) <=
      new Date(input.cohort.billingCycle.start)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['cohort', 'billingCycle', 'end'],
        message: 'billing cycle end must be after its start',
      });
    }

    const tierNames = new Set(input.tiers.map(({ tier }) => tier));
    for (const tier of paidTiers) {
      if (!tierNames.has(tier)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tiers'],
          message: `missing ${tier} economics`,
        });
      }
    }

    const tierUsers = input.tiers.reduce(
      (total, tier) => total + tier.paidUsers,
      0,
    );
    if (tierUsers !== input.cohort.paidUsers) {
      ctx.addIssue({
        code: 'custom',
        path: ['tiers'],
        message: 'tier paid-user counts must equal the cohort paid-user count',
      });
    }

    input.tiers.forEach((tier, index) => {
      if (tier.exhaustedUsers > tier.paidUsers) {
        ctx.addIssue({
          code: 'custom',
          path: ['tiers', index, 'exhaustedUsers'],
          message: 'exhausted users cannot exceed paid users',
        });
      }
    });

    const invoiceProviders = new Set(
      input.providerInvoices.map(({ provider }) => provider),
    );
    for (const provider of ['OPENROUTER', 'TAVILY', 'BROWSERLESS'] as const) {
      if (!invoiceProviders.has(provider)) {
        ctx.addIssue({
          code: 'custom',
          path: ['providerInvoices'],
          message: `missing ${provider} invoice evidence`,
        });
      }
    }

    const areas = new Set(input.decision.items.map(({ area }) => area));
    for (const area of decisionAreas) {
      if (!areas.has(area)) {
        ctx.addIssue({
          code: 'custom',
          path: ['decision', 'items'],
          message: `missing human decision for ${area}`,
        });
      }
    }

    input.decision.items.forEach((item, index) => {
      if (item.action === 'CHANGE' && !item.implementationIssue) {
        ctx.addIssue({
          code: 'custom',
          path: ['decision', 'items', index, 'implementationIssue'],
          message: `${item.area} changes require a separate implementation issue`,
        });
      }
      if (
        item.area === 'TIER_ALLOWANCES' &&
        item.action === 'CHANGE' &&
        !item.proposedTierAllowances
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['decision', 'items', index, 'proposedTierAllowances'],
          message: 'tier allowance changes require finite proposed allowances',
        });
      }
    });
  });

export type CreditEconomicsReviewInput = z.infer<
  typeof creditEconomicsReviewInputSchema
>;

interface Percentiles {
  p50: number;
  p95: number;
}

interface Distribution extends Percentiles {
  mean: number;
}

export interface ArtifactCreditMetrics extends Percentiles {
  artifactType: ArtifactType;
  withResearch: boolean;
  sampleSize: number;
}

export interface TierEconomicsMetrics {
  tier: PaidTier;
  paidUsers: number;
  allowanceCredits: number;
  exhaustionRatePercent: number;
  subscriptionRevenueUsd: number;
  providerCostUsd: number;
  realizedGrossMarginPercent: number;
  intendedGrossMarginFloorPercent: number;
  marginDeltaPercent: number;
}

export interface CreditEconomicsReview {
  cohort: CreditEconomicsReviewInput['cohort'];
  eligibilityBasis: 'complete paid billing cycle' | '100–200 paid-user cohort';
  artifactCredits: ArtifactCreditMetrics[];
  operations: {
    researchRuns: number;
    tavilyLookups: Distribution;
    browserlessRenders: number;
    browserlessUnits: Distribution;
    retryRatePercent: number;
    failureRatePercent: number;
  };
  invoices: {
    evidence: CreditEconomicsReviewInput['providerInvoices'];
    invoiceTotalUsd: number;
    attributedProviderCostUsd: number;
    reconciliationDeltaUsd: number;
  };
  tiers: TierEconomicsMetrics[];
  decision: CreditEconomicsReviewInput['decision'];
}

const intendedGrossMarginFloorPercent: Record<PaidTier, number> = {
  Starter: 90,
  Creator: 75,
  'Pro Writer': 50,
};

const round = (value: number, places = 2): number => {
  const multiplier = 10 ** places;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

const percentile = (values: number[], ratio: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ratio * sorted.length) - 1);
  return sorted[index];
};

const distribution = (values: number[]): Distribution => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  mean: round(
    values.reduce((total, value) => total + value, 0) / values.length,
  ),
});

const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : round((numerator / denominator) * 100);

export const analyzeCreditEconomics = (
  candidate: unknown,
): CreditEconomicsReview => {
  const input = creditEconomicsReviewInputSchema.parse(candidate);
  const cycleEligible = input.cohort.billingCycle.complete;
  const cohortEligible =
    input.cohort.paidUsers >= 100 && input.cohort.paidUsers <= 200;

  if (!cycleEligible && !cohortEligible) {
    throw new Error(
      'Credit economics review requires one complete paid billing cycle or a cohort of 100 to 200 paid users',
    );
  }

  const artifactCredits: ArtifactCreditMetrics[] = [];
  for (const artifactType of artifactTypes) {
    for (const withResearch of [false, true]) {
      const credits = input.runs
        .filter(
          (run) =>
            run.artifactType === artifactType &&
            run.withResearch === withResearch &&
            run.status === 'COMPLETED',
        )
        .map(({ credits }) => credits);
      if (credits.length === 0) {
        throw new Error(
          `Credit economics review is missing run samples for ${artifactType} ${withResearch ? 'with' : 'without'} research`,
        );
      }
      artifactCredits.push({
        artifactType,
        withResearch,
        sampleSize: credits.length,
        p50: percentile(credits, 0.5),
        p95: percentile(credits, 0.95),
      });
    }
  }

  const researchRuns = input.runs.filter(({ withResearch }) => withResearch);
  const browserlessUnits = input.runs.flatMap(
    ({ browserlessUnits }) => browserlessUnits,
  );
  if (browserlessUnits.length === 0) {
    throw new Error(
      'Credit economics review requires Browserless render samples',
    );
  }

  const invoiceTotalUsd = round(
    input.providerInvoices.reduce(
      (total, invoice) => total + invoice.amountUsd,
      0,
    ),
  );
  const attributedProviderCostUsd = round(
    input.tiers.reduce((total, tier) => total + tier.providerCostUsd, 0),
  );

  const tiers = paidTiers.map((tierName): TierEconomicsMetrics => {
    const tier = input.tiers.find(({ tier }) => tier === tierName)!;
    const realizedGrossMarginPercent =
      tier.subscriptionRevenueUsd === 0
        ? 0
        : round(
            ((tier.subscriptionRevenueUsd - tier.providerCostUsd) /
              tier.subscriptionRevenueUsd) *
              100,
          );
    const intended = intendedGrossMarginFloorPercent[tierName];

    return {
      tier: tierName,
      paidUsers: tier.paidUsers,
      allowanceCredits: tier.allowanceCredits,
      exhaustionRatePercent: rate(tier.exhaustedUsers, tier.paidUsers),
      subscriptionRevenueUsd: tier.subscriptionRevenueUsd,
      providerCostUsd: tier.providerCostUsd,
      realizedGrossMarginPercent,
      intendedGrossMarginFloorPercent: intended,
      marginDeltaPercent: round(realizedGrossMarginPercent - intended),
    };
  });

  return {
    cohort: input.cohort,
    eligibilityBasis: cycleEligible
      ? 'complete paid billing cycle'
      : '100–200 paid-user cohort',
    artifactCredits,
    operations: {
      researchRuns: researchRuns.length,
      tavilyLookups: distribution(
        researchRuns.map(
          ({ successfulTavilyLookups }) => successfulTavilyLookups,
        ),
      ),
      browserlessRenders: browserlessUnits.length,
      browserlessUnits: distribution(browserlessUnits),
      retryRatePercent: rate(
        input.runs.filter(({ attempts }) => attempts > 1).length,
        input.runs.length,
      ),
      failureRatePercent: rate(
        input.runs.filter(({ status }) => status === 'FAILED').length,
        input.runs.length,
      ),
    },
    invoices: {
      evidence: input.providerInvoices,
      invoiceTotalUsd,
      attributedProviderCostUsd,
      reconciliationDeltaUsd: round(
        invoiceTotalUsd - attributedProviderCostUsd,
      ),
    },
    tiers,
    decision: input.decision,
  };
};

const formatNumber = (value: number): string => value.toLocaleString('en-US');
const formatUsd = (value: number): string => `$${value.toFixed(2)}`;
const escapeCell = (value: string): string =>
  value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');

export const renderCreditEconomicsReport = (
  review: CreditEconomicsReview,
): string => {
  const artifactRows = review.artifactCredits
    .map(
      (metric) =>
        `| ${metric.artifactType} | ${metric.withResearch ? 'Yes' : 'No'} | ${metric.sampleSize} | ${formatNumber(metric.p50)} | ${formatNumber(metric.p95)} |`,
    )
    .join('\n');
  const invoiceRows = review.invoices.evidence
    .map(
      (invoice) =>
        `| ${invoice.provider} | ${formatUsd(invoice.amountUsd)} | ${escapeCell(invoice.reference)} |`,
    )
    .join('\n');
  const tierRows = review.tiers
    .map(
      (tier) =>
        `| ${tier.tier} | ${tier.paidUsers} | ${formatNumber(tier.allowanceCredits)} | ${tier.exhaustionRatePercent.toFixed(2)}% | ${formatUsd(tier.subscriptionRevenueUsd)} | ${formatUsd(tier.providerCostUsd)} | ${tier.realizedGrossMarginPercent.toFixed(2)}% | ${tier.intendedGrossMarginFloorPercent.toFixed(2)}% | ${tier.marginDeltaPercent.toFixed(2)} pp |`,
    )
    .join('\n');
  const decisionRows = review.decision.items
    .map(
      (item) =>
        `| ${item.area} | ${item.action} | ${escapeCell(item.rationale)} | ${escapeCell(item.implementationIssue ?? '—')} |`,
    )
    .join('\n');

  return `# Production Credit Economics Review

## Cohort

- Eligibility: ${review.eligibilityBasis}
- Paid users: ${review.cohort.paidUsers}
- Billing cycle: ${review.cohort.billingCycle.start} to ${review.cohort.billingCycle.end}

## Artifact credits

| Artifact | Research | Runs | p50 credits | p95 credits |
|---|---:|---:|---:|---:|
${artifactRows}

## Provider operations

- Research runs: ${review.operations.researchRuns}
- Successful Tavily lookups per research run: mean ${review.operations.tavilyLookups.mean}, p50 ${review.operations.tavilyLookups.p50}, p95 ${review.operations.tavilyLookups.p95}
- Browserless renders: ${review.operations.browserlessRenders}
- Browserless units per render: mean ${review.operations.browserlessUnits.mean}, p50 ${review.operations.browserlessUnits.p50}, p95 ${review.operations.browserlessUnits.p95}
- Workflow retry rate: ${review.operations.retryRatePercent.toFixed(2)}%
- Workflow failure rate: ${review.operations.failureRatePercent.toFixed(2)}%

## Provider invoices

| Provider | Amount | Evidence reference |
|---|---:|---|
${invoiceRows}

- Invoice total: ${formatUsd(review.invoices.invoiceTotalUsd)}
- Provider cost attributed to paid tiers: ${formatUsd(review.invoices.attributedProviderCostUsd)}
- Reconciliation delta: ${formatUsd(review.invoices.reconciliationDeltaUsd)}

## Tier economics

| Tier | Paid users | Allowance | Exhaustion | Revenue | Provider cost | Realized margin | Intended floor | Delta |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${tierRows}

## Human decision

- Owner: ${review.decision.owner}
- Decided at: ${review.decision.decidedAt}

| Area | Decision | Rationale | Implementation issue |
|---|---|---|---|
${decisionRows}
`;
};
