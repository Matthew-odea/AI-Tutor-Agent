# New Developer Onboarding

Welcome to the AI Tutor Agent project. This guide walks you through the codebase so you can contribute effectively.

## What This Project Does

This is an AI-powered educational platform for university programming courses (currently COMP9021 at UNSW). It has two main interventions:

1. **AI Tutor** -- students chat with an AI tutor that answers questions grounded in uploaded course materials (RAG). Includes an in-browser Python code editor.
2. **Oral Assessment** -- instructors create assessments, upload student lists, and batch-generate personalized questions. Students record audio/video/text answers. The system transcribes and auto-evaluates responses.

## Local Setup

Prerequisites: Python 3.13+, Node.js 20+, and a configured `.env` at repo root (copy from `.env.example`). Backend integrations vary by feature (Neo4j, AWS Bedrock, Deepgram, DynamoDB) -- you only need credentials for the ones you're touching.

### 1. Backend

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in your credentials
python app.py
```

- API: http://localhost:8000
- OpenAPI docs: http://localhost:8000/docs

Local Neo4j (optional, needed for RAG chat):

```bash
docker-compose up -d   # starts Neo4j on ports 7474 (browser) and 7687 (bolt)
```

### 2. Frontends

Each frontend is a standalone Vite + React app:

```bash
cd ai-tutor-frontend && npm install && npm run dev              # port 5173
cd oral-assessment-instructor && npm install && npm run dev     # port 5175
cd oral-assessment-student && npm install && npm run dev        # port 5176
```

All three connect to the backend at `http://localhost:8000` in dev mode.

### 3. Tests

```bash
# Backend (from repo root, with venv active)
PYTHONPATH=. pytest tests/ -v

# Frontend (from any frontend dir)
npm run test:run        # single run
npm test                # watch mode
npm run validate        # type-check + lint + format + tests (ai-tutor-frontend only)
```

### Common Issues

| Problem | Fix |
|---------|-----|
| Import errors in tests | Set `PYTHONPATH=.` before running `pytest` |
| Auth-protected routes fail | Confirm the frontend sends `Authorization: Bearer <token>` |
| Vector features fail | Check `NEO4J_*` env vars and that Neo4j is reachable |
| Frontend can't reach backend | Ensure the backend is running on port 8000 |

## Codebase Tour

### Backend

The backend is a FastAPI app (`app.py`) with strict layering:

```
app.py                              # Creates FastAPI app, mounts routers, starts SQS consumer
src/main/
  controllers/                      # HTTP routers (thin -- delegate to services)
    assessment_router.py            # Instructor endpoints (largest router, ~900 lines)
    student_router.py               # Student assessment endpoints
    history_router.py               # Chat history, workspaces, threads
    auth_router.py                  # Login, signup, OAuth, password reset
    analytics_router.py             # Event telemetry
    InternalEndpoints.py            # Document context + S3 upload
    controller_dependencies.py      # DI container -- all service singletons
    controller_helpers.py           # Auth checks, utility functions
    api_errors.py                   # Error envelope + global exception handlers

  service/                          # Business logic (30+ files)
    ChatService.py                  # Core RAG chat workflow
    ContextVectorService.py         # Vector store CRUD (Neo4j)
    InstructorAssessment*.py        # Assessment management (5 files)
    OralAssessment*.py              # Student assessment (5 files)
    QuestionGenerationService.py    # LLM question generation
    ResponseEvaluation*.py          # LLM response evaluation (5 files)
    SQSJobDispatcher.py             # Async job queue
    ...

  auth/                             # JWT auth, password hashing, principal model
  llm/                              # LLM provider abstraction
  agentcore_setup/                  # Bedrock client, conversation memory, history stores
  dtos/                             # Pydantic request/response models
  config/                           # App settings
```

### Frontends

Three independent React apps, all using the same stack (Vite, Tailwind, Zustand, Axios):

- **ai-tutor-frontend** (port 5173) -- chat interface, code editor, session sidebar
- **oral-assessment-instructor** (port 5175) -- assessment creation and monitoring dashboard
- **oral-assessment-student** (port 5176) -- take assessments, record responses

Each follows the same structure:
```
src/
  components/ or features/     # UI components
  pages/                       # Route-level components
  services/ or api/            # Axios API client
  store/                       # Zustand state management
  hooks/                       # Custom React hooks
  types/                       # TypeScript types
```

Shared types between the two assessment apps live in `shared/types/assessment.ts`.

### Key Patterns

**Dependency injection**: All services are created as singletons via `@lru_cache` in `controller_dependencies.py`. Routers use `Depends(get_xyz_service)` to receive them.

**Auth flow**: `require_auth_principal` extracts the JWT from the `Authorization` header and returns an `AuthPrincipal`. Role checks use `require_role("instructor")`. Student sessions use a scoped JWT from invite token exchange.

**Async jobs**: Long-running tasks (question generation, batch evaluation) go through SQS. The `SQSJobDispatcher` sends a message, and a consumer thread (started at app boot) picks it up and delegates to the appropriate service. Job status is tracked in DynamoDB.

**Error handling**: All errors return `{"ok": false, "error": {"code": "...", "message": "..."}}` via the global exception handlers in `api_errors.py`.

## How to Add a Feature

### Adding a new backend endpoint

1. **Service**: Create or extend a service in `src/main/service/`. Keep business logic here, not in the router.
2. **DTO**: If you need new request/response shapes, add Pydantic models in `src/main/dtos/`.
3. **Router**: Add the endpoint to the appropriate router in `src/main/controllers/`. Use `Depends()` for service injection and auth.
4. **DI**: If you created a new service, add a singleton provider in `controller_dependencies.py`.
5. **Tests**: Add tests in `tests/`. Run with `PYTHONPATH=. pytest tests/ -v`.

### Adding a frontend feature

1. **API**: Add the API call in the `services/api.ts` or `api/` directory.
2. **Store**: Update the Zustand store if new state is needed.
3. **Component**: Build the UI component. Use existing Tailwind patterns.
4. **Route**: If it's a new page, add a route in `App.tsx`.
5. **Tests**: Add tests. Run with `npm run test:run`.

### Adding an environment variable

- **Backend**: Add to `.env.example`, reference in `src/main/config/settings.py`. For production, add to SSM Parameter Store and update `scripts/load-ssm-env.sh` validation.
- **Frontend**: Prefix with `VITE_`. Add to the relevant GitHub Actions workflow build step (env vars are baked in at build time).

## Testing

```bash
# Backend
PYTHONPATH=. pytest tests/ -v               # all tests
PYTHONPATH=. pytest tests/service/ -v       # service tests only
PYTHONPATH=. pytest tests/controllers/ -v   # controller tests only

# Frontend (from any frontend dir)
npm run test:run                            # single run
npm run validate                            # type-check + lint + format + tests
```

CI enforces >= 50% backend coverage. Tests mock AWS services using `moto`.

## Deployment

Production runs on AWS (EC2 + S3 + CloudFront + DynamoDB + SQS). See [ORAL_ASSESSMENT_DEPLOYMENT.md](ORAL_ASSESSMENT_DEPLOYMENT.md) for the full runbook.

Key facts:
- Backend deploys via SSM Run Command to EC2 (Docker container)
- Frontend deploys via S3 sync + CloudFront invalidation
- Secrets come from SSM Parameter Store, not `.env` files
- GitHub Actions uses OIDC for AWS auth (no stored credentials)

## Key Documentation

| When you need... | Read... |
|------------------|---------|
| Architecture overview | [ARCHITECTURE.md](ARCHITECTURE.md) |
| DynamoDB key patterns | [DYNAMODB_SCHEMA.md](DYNAMODB_SCHEMA.md) |
| Auth model | [AUTH_CURRENT_STATE_AND_PLAN.md](AUTH_CURRENT_STATE_AND_PLAN.md) |
| Production deployment | [ORAL_ASSESSMENT_DEPLOYMENT.md](ORAL_ASSESSMENT_DEPLOYMENT.md) |
| What's shipped, in order | [CHANGELOG.md](CHANGELOG.md) |
| Analytics/telemetry | [ANALYTICS_LOGGING.md](ANALYTICS_LOGGING.md) |
| OpenAPI reference | http://localhost:8000/docs (run backend first) |
