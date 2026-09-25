# AI Tutor Agent

An AI-powered educational platform for programming courses, built for UNSW's COMP9021. The system provides two core interventions:

1. **AI Tutor** -- RAG-based chat tutoring grounded in course materials, with an in-browser Python editor (Monaco + Pyodide)
2. **Oral Assessment** -- AI-generated questions, audio/video/text submissions, automated evaluation with detailed feedback

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI (Python 3.13) |
| Frontends | React + TypeScript + Vite + Tailwind + Zustand |
| LLM | AWS Bedrock (Amazon Nova Lite chat, Titan Embed v2) |
| Vector DB | Neo4j |
| Persistence | DynamoDB (single-table design) |
| Storage | S3 (presigned uploads) |
| Jobs | SQS (in-process consumer) |
| Speech-to-Text | Deepgram |
| Auth | JWT + optional Google OAuth |

## New Contributors — Start Here

**Merging to `main` deploys to production.** Real students use this, and there is no code review — CI is the only gate. Read [`CLAUDE.md`](CLAUDE.md) before your first PR.

Access to request on day one:

- [ ] GitHub collaborator access to this repo (needed to push branches and open PRs)
- [ ] Your own AWS IAM user in the project account, scoped to what you need (DynamoDB, S3, SQS, Bedrock, SSM read) — don't share keys
- [ ] Values for your local `.env` (`AUTH_JWT_SECRET`, table names, queue URL) from the maintainer — never commit `.env`
- [ ] A Deepgram API key, only if you're working on transcription

Neo4j needs no account — run it locally with `docker-compose up -d` (only RAG chat uses it).

Your first hour:

1. Follow Quick Start below and get the backend running at http://localhost:8000/docs.
2. Run `pytest` (full suite should pass; the two Neo4j tests error without Docker running).
3. Start one frontend and run `npm run validate` in it.
4. Skim [docs/ONBOARDING.md](docs/ONBOARDING.md) (codebase tour) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Every PR: branch off `main`, run `pytest` and `npm run validate` in any frontend you touched, open a PR, wait for CI (includes a 68% backend coverage floor). New routes must pass `tests/controllers/test_route_auth.py`.

## Quick Start

```bash
# Backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in credentials
python app.py           # http://localhost:8000/docs

# Any frontend (ai-tutor-frontend, oral-assessment-instructor, oral-assessment-student)
cd <frontend-dir>
npm install && npm run dev
```

Dev ports: `ai-tutor-frontend` 5173, `oral-assessment-instructor` 5175, `oral-assessment-student` 5176.

## Documentation

All detailed docs live in [`docs/`](docs/):

| Document | Purpose |
|----------|---------|
| [ONBOARDING.md](docs/ONBOARDING.md) | Local setup, running, testing, and a codebase tour |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture, data flows, service map |
| [DYNAMODB_SCHEMA.md](docs/DYNAMODB_SCHEMA.md) | DynamoDB key patterns and access patterns |
| [AUTH_CURRENT_STATE_AND_PLAN.md](docs/AUTH_CURRENT_STATE_AND_PLAN.md) | Auth model and hardening checklist |
| [ORAL_ASSESSMENT_DEPLOYMENT.md](docs/ORAL_ASSESSMENT_DEPLOYMENT.md) | Production deployment runbook (canonical) |
| [CHANGELOG.md](docs/CHANGELOG.md) | What's shipped, historical only |
| [ANALYTICS_LOGGING.md](docs/ANALYTICS_LOGGING.md) | Event telemetry and privacy constraints |

See also the repo-root `CLAUDE.md` for task-oriented operating instructions (how to verify a change, where things go, the endpoint contract).

## Testing

```bash
pytest                                  # Backend (from repo root)
npm test                                # Any frontend (watch mode)
npm run test:run                        # Any frontend (CI mode)
```

## Project Structure

```
AI-Tutor-Agent/
├── app.py                          # FastAPI entry point
├── src/main/
│   ├── controllers/                # API routers
│   ├── service/                    # Business logic
│   ├── dtos/                       # Pydantic request/response models
│   ├── auth/                       # JWT auth, principal resolution
│   ├── llm/                        # LLM provider abstraction
│   ├── agentcore_setup/            # Bedrock client, memory, history stores
│   ├── config/                     # App settings
│   ├── middleware/                  # Request logging
│   └── utils/                      # Prompt loader, markdown parser, logging
├── prompts/                        # System prompts for LLM workflows
├── ai-tutor-frontend/              # Chat + code editor app
├── oral-assessment-instructor/     # Instructor dashboard
├── oral-assessment-student/        # Student assessment app
├── shared/                         # Shared TypeScript types
├── tests/                          # Backend test suite
├── scripts/                        # Deployment and utility scripts
├── docs/                           # All documentation
└── .github/workflows/              # CI/CD pipelines
```
