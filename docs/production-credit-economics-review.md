# Production Credit Economics Review

Use this workflow only after either one complete paid billing cycle or a cohort
of 100–200 paid users. It turns a normalized production export plus a named
owner's pricing decision into the evidence record required by issue #148. The
command rejects an ineligible cohort, incomplete artifact coverage, missing
provider invoices, unowned decisions, approved changes without implementation
issues, and unlimited paid credit allowances.

## Run the review

Prepare the normalized JSON described below, then run:

```bash
npm run review:credit-economics -- ./private/credit-economics-input.json docs/credit-economics-review-YYYY-MM.md
```

Keep raw exports and invoices outside the repository because they may contain
customer or vendor-sensitive data. Commit only the generated Markdown evidence
record after the owner has verified its totals and recorded all five decisions.

## Input contract

The top-level object has five fields:

- `cohort`: `paidUsers` and a `billingCycle` with ISO `start`, ISO `end`, and
  `complete`. An incomplete cycle is accepted only for 100–200 paid users.
- `runs`: normalized workflow observations with `artifactType` (`POST`, `POLL`,
  or `DOCUMENT`), `withResearch`, `credits`, successful Tavily lookup count,
  Browserless units for every render attempt, whole-job `attempts`, and final
  `status`. Supply at least one observation for each of the six artifact ×
  research combinations.
- `providerInvoices`: at least one `OPENROUTER`, `TAVILY`, and `BROWSERLESS`
  invoice row with `amountUsd` and a non-secret evidence `reference`.
- `tiers`: exactly one row each for Starter, Creator, and Pro Writer. Each row
  supplies paid users, finite positive allowance, exhausted users, recognized
  subscription revenue, and provider cost attributed to that tier.
- `decision`: the human `owner`, ISO `decidedAt`, and one item for each of
  `MARKUP`, `SEARCH_PRICING`, `RENDER_PRICING`, `TIER_ALLOWANCES`, and `TOP_UPS`.
  Every item is `RETAIN` or `CHANGE` with a rationale. A change requires an
  `implementationIssue`; a tier-allowance change also requires finite positive
  `proposedTierAllowances` for all three paid tiers.

Example decision item:

```json
{
  "area": "SEARCH_PRICING",
  "action": "CHANGE",
  "rationale": "Observed Tavily invoice cost exceeds the launch envelope.",
  "implementationIssue": "https://github.com/krispamB/linkgenserver/issues/200"
}
```

## Preparing production evidence

Use paid-user workflow runs whose creation time falls inside the selected
billing window. Join each run to its artifact to obtain `artifactType` and
`withResearch`. Use the final settled credit count for successful runs and the
retained attempt telemetry for retry/failure analysis. Browserless units come
from `WorkflowRun.renderAttempts`; include successful and failed render attempts
so invoice exposure is visible.

Successful Tavily lookup counts, whole-job attempt counts, and provider cost
attribution must be assembled from retained application/queue observability and
the vendor exports for the same window. Do not infer provider economics from raw
token counts: OpenRouter's reported cost and the actual Tavily and Browserless
invoice evidence are the source of truth.

Reconcile the invoice total against provider cost attributed across the three
paid tiers. The generated report shows the delta instead of hiding it; the human
owner must investigate a material difference before approving the decision.

## Metric definitions

- Artifact credit p50/p95 uses nearest-rank percentiles per artifact and
  research flag.
- Tavily metrics are successful lookups per research run.
- Browserless metrics are measured 30-second units per render attempt.
- Retry rate is the share of workflow observations with more than one attempt.
- Failure rate is the share whose final status is `FAILED`.
- Exhaustion is exhausted paid users divided by paid users for each tier.
- Realized gross margin is `(subscription revenue - attributed provider cost) /
subscription revenue`, compared with the launch full-exhaustion floors of 90%
  for Starter, 75% for Creator, and 50% for Pro Writer.

The report is evidence for a human pricing decision, not an automatic repricing
mechanism. Approved changes belong in separate implementation issues, and paid
provider-backed usage must remain finite.
