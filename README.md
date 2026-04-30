# linkgenserver

An open-source NestJS backend that generates and schedules LinkedIn posts using AI. It runs as two separate processes — an HTTP API server and a background worker — and integrates with LinkedIn OAuth, Google OAuth, OpenRouter LLM, and Paddle for payments.

## Features

- **AI post generation** — pipeline-based workflow engine that calls an LLM (via OpenRouter) to draft LinkedIn posts
- **Post scheduling** — queue-backed scheduler that publishes posts to LinkedIn at a chosen time
- **LinkedIn & Google OAuth** — connect LinkedIn person/organisation accounts; sign in with Google
- **Feature gating** — tier-based limits on AI drafts, scheduled posts, and connected accounts, with usage metering
- **Background worker** — separate BullMQ worker process handles post generation, scheduling, LinkedIn avatar refresh, and transactional email
- **Payments** — Paddle webhook integration for subscription management

## Tech stack

| Concern | Technology |
|---|---|
| Framework | NestJS v11 |
| Database | MongoDB (Mongoose) |
| Queue / cache | Redis + BullMQ |
| LLM | OpenRouter |
| Web research | Apify |
| Email | Resend |
| Payments | Paddle |
| Auth | Passport (Google OAuth2, LinkedIn OAuth2, JWT cookies) |

## Prerequisites

- Node.js 20+
- Docker & Docker Compose (for local MongoDB, Redis, and the BullMQ dashboard)

## Getting started

### 1. Clone and install

```bash
git clone https://github.com/krispamb/linkgenserver.git
cd linkgenserver
npm install
```

### 2. Start infrastructure

```bash
docker-compose up -d
```

This starts:
- **MongoDB** on `localhost:27017`
- **Redis** on `localhost:6379` (password: `securelinkgenpass`)
- **BullMQ dashboard** on `http://localhost:8080`

### 3. Configure environment

```bash
cp .env.example .env
```

Fill in the values — see [Environment variables](#environment-variables) below.

### 4. Seed tiers (first run only)

```bash
npm run seed:tiers:temp
```

### 5. Run the HTTP server

```bash
npm run start:dev
```

The API is available at `http://localhost:3500/api/v1`.

### 6. Run the worker (separate terminal)

```bash
npm run build
npm run start:worker
```

The worker bootstraps a NestJS application context and processes four queues: `workflow`, `post-schedule`, `linkedin-avatar-refresh`, and `email`.

## Environment variables

Copy `.env.example` and set the following. Keys not present in the example file are marked with *.

| Variable | Description |
|---|---|
| `NODE_ENV` | `development` or `production` |
| `PORT` | HTTP server port (default `3500`) |
| `MONGO_URI` | MongoDB connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Secret used to sign JWT cookies |
| `FRONTEND_URL` | Your frontend origin (for CORS and redirects) |
| `ENCRYPTION_KEY` * | Arbitrary secret for AES-256-GCM encryption of LinkedIn tokens |
| `LINKEDIN_CLIENT_ID` * | LinkedIn OAuth app client ID |
| `LINKEDIN_CLIENT_SECRET` * | LinkedIn OAuth app client secret |
| `LINKEDIN_REDIRECT_URI` * | OAuth callback URL registered in the LinkedIn app |
| `GOOGLE_CLIENT_ID` * | Google OAuth app client ID |
| `GOOGLE_CLIENT_SECRET` * | Google OAuth app client secret |
| `GOOGLE_CALLBACK_URL` * | OAuth callback URL registered in the Google app |
| `GOOGLE_API_KEY` * | YouTube Data API key |
| `APIFY_API_TOKEN` * | Apify token for web research actors |
| `OPENROUTER_API_KEY` * | OpenRouter API key for LLM calls |
| `PADDLE_ENVIRONMENT` | `sandbox` or `production` |
| `PADDLE_API_KEY` | Paddle API key |
| `PADDLE_WEBHOOK_SECRET` | Paddle webhook signing secret |
| `RESEND_API_KEY` | Resend API key for transactional email |
| `MAIL_FROM` | Sender address for outbound email |
| `ADMIN_DIAG_TOKEN` | Optional — set to enable `GET /api/v1/diagnostics/heap` |

## Project structure

```
src/
├── agent/          # LLM prompt definitions and agent service
├── auth/           # Google & LinkedIn OAuth strategies, JWT guard
├── database/       # Mongoose schemas (User, PostDraft, ConnectedAccount, Tier, …)
├── feature-gating/ # Tier resolution, usage metering, subscription access guard
├── llm/            # LLM strategy pattern (OpenRouter)
├── payment/        # Paddle webhook handler
├── post/           # Post CRUD and publish controller
├── workflow/       # Queue producers, step handlers, workflow engine, BullMQ worker
│   ├── engine/     # WorkflowDefinition, WorkflowRegistry, runWorkflow
│   ├── steps/      # Individual step handlers
│   ├── workers/    # workflow.worker.ts — the standalone worker entry point
│   └── workflows/  # quickPostLinkedin, insightPostLinkedin pipeline definitions
└── main.ts         # HTTP server entry point
```

## Architecture overview

The application is intentionally split into two processes so the long-running AI workflows don't block HTTP request handling.

```
HTTP client
    │
    ▼
NestJS HTTP server  ──enqueues jobs──►  Redis / BullMQ
    │                                        │
    │                               BullMQ worker process
    │                                  ├── workflow queue      → AI post generation
    │                                  ├── post-schedule queue → LinkedIn publish
    │                                  ├── avatar-refresh      → token refresh
    │                                  └── email queue         → Resend
    ▼
MongoDB
```

The workflow engine (`runWorkflow`) iterates an ordered list of `WorkflowStep` enum values, calling each registered step handler in sequence. A shared `state` object accumulates results across steps, making intermediate LLM outputs available to later steps in the same run.

## Scripts

```bash
npm run start:dev     # HTTP server in watch mode
npm run start:worker  # BullMQ worker (requires prior build)
npm run build         # Compile TypeScript
npm run lint          # ESLint with auto-fix
npm run format        # Prettier
npm run test          # Unit tests
npm run test:cov      # Unit tests with coverage
npm run test:e2e      # End-to-end tests
```

## Contributing

1. Fork the repository and create a feature branch from `main`.
2. Follow the conventions in `PROJECT_RULES.md` (kebab-case files, PascalCase classes, camelCase variables, no `I` prefix on interfaces).
3. Write or update tests for changed behaviour.
4. Open a pull request — keep commits focused and descriptions clear.

## License

This project is currently unlicensed. A licence file will be added before the first stable release.
