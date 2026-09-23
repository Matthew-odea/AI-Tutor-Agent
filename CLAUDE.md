# CLAUDE.md

Operating instructions for whoever (human or agent) is about to change this repo. This is a FastAPI backend + three React/Vite frontends, shared with students and casual contributors who have no code review before merge. **Tests are the only gate.** Docs in this repo get read as instructions, by people and by agents — if you find a doc that reads as a mandate rather than a description of what exists, that's a bug in the doc; fix it or flag it, don't build against it.

## Verify a change before calling it done

Run the real commands, not what you assume they are — several of these are commonly gotten wrong (see below).

```bash
# Backend (from repo root)
pytest                      # all tests
pytest tests/service        # one layer
pytest tests/controllers    # one layer
```

`pyproject.toml` sets `pythonpath = ["."]`, so `src.main.*` imports resolve without a
`PYTHONPATH=.` prefix. Older docs and commit messages still show the prefix; it is harmless
but no longer needed.

The suite is expected to pass in full. Two tests in `tests/service/test_context_vector_service.py`
error if Neo4j is not running locally — start it with `docker-compose up -d` or ignore those two
specifically. **Any other failure is a real failure.** Do not re-run hoping it passes: there is no
code review here, so a test you talked yourself out of is the last thing between a bug and
production.

```bash
# Any frontend (from that frontend's directory)
npm run validate     # type-check + lint + test:run — exists in all three frontends
npm run type-check   # tsc --noEmit only
npm run build        # tsc -b (or tsc + vite build) — the actual production build
```

`npm run validate` exists in **all three** frontends, not just `ai-tutor-frontend` — `ai-tutor-frontend`'s version additionally runs `format:check`, which the other two don't have.

```bash
python app.py                    # run the backend on :8000, http://localhost:8000/docs for OpenAPI
docker-compose up -d              # local Neo4j (7474 browser, 7687 bolt) — only needed for RAG chat
```

Dev ports: `ai-tutor-frontend` 5173, `oral-assessment-instructor` 5175, `oral-assessment-student` 5176.

A change to a `.py` file is not verified by "the file parses" — run the tests for the layer you touched. A change to a router is not verified by "it compiles" — check the auth dependency is present and run `tests/controllers/test_route_auth.py` (see below).

## Where things go

```
src/main/
  controllers/     # HTTP routers — thin, delegate to services. See src/main/controllers/CLAUDE.md.
  service/         # Business logic. This is where a new feature's logic lives, not the router.
  dtos/            # Pydantic request/response models
  auth/            # JWT auth, principal resolution, role checks
  llm/             # LLM provider abstraction (AgentCoreProvider)
  agentcore_setup/ # Bedrock client bootstrap, model config, conversation memory/history stores
  config/          # AppSettings — one @lru_cache dataclass, env-var backed
```

Adding a backend endpoint:
1. **Service** (`src/main/service/`) — the logic. Extend an existing service if one owns this domain; only add a new file for a genuinely new concern.
2. **DTO** (`src/main/dtos/`) — Pydantic request/response shapes, if the existing ones don't fit.
3. **Router** (`src/main/controllers/`) — add the route to the router that owns the URL prefix (see the table in `docs/ARCHITECTURE.md`). Read `src/main/controllers/CLAUDE.md` first — it has the auth/error-handling contract every route must follow.
4. **DI** — if you added a new service, add its `@lru_cache` singleton provider in `controller_dependencies.py`.
5. **Tests** — add route-level tests: unauthorized, forbidden, success path. Run `PYTHONPATH=. pytest tests/ -v`.

Adding a frontend feature: API call in `services/api.ts` (or `api/`) → Zustand store update if new state is needed → component, using existing Tailwind patterns → route in `App.tsx` if it's a new page → test with `npm run test:run`.

Adding an environment variable:
- **Backend**: add to `.env.example`, read it in `src/main/config/settings.py` (or the owning service, if it's not a global setting). For production, add it to SSM Parameter Store *and* to the `required` set in `scripts/load-ssm-env.sh` if it's load-bearing.
- **Frontend**: prefix with `VITE_`, add to the GitHub Actions workflow's build-step `env:` block — see "Environment Variables" below, `.env` files do nothing in production.

## The endpoint contract

Every route requires an auth dependency (`Depends(require_auth_principal)`, `require_user_id`, or `require_role(...)`) **unless** it is listed in `tests/controllers/test_route_auth.py`'s `PUBLIC_ROUTES` allowlist with a one-line reason. That test walks every route's dependency tree and fails the build if a route is reachable without either. Adding an intentionally-public route means adding a line to that allowlist, not skipping the test.

Full contract (auth, error envelope, DI) is in `src/main/controllers/CLAUDE.md`.

## Environment Variables — How They Work

**All `.env` files are gitignored and never pushed.** There are two separate systems:

### Backend (EC2)
Vars come from **AWS SSM Parameter Store** at `/ai-tutor/prod/`. `scripts/load-ssm-env.sh` pulls them and writes `.env` on the EC2 instance at deploy time. To add/change a backend var:
```bash
aws ssm put-parameter --region ap-southeast-2 \
  --name /ai-tutor/prod/MY_VAR --value "value" --type SecureString --overwrite
```
Then redeploy or SSH + re-run the script + restart Docker.

### Frontends (S3/CloudFront)
`VITE_*` vars are **baked in at Vite build time** — there is no runtime config. They are set in `.github/workflows/assessment-frontend-deploy.yml` as `env:` blocks on each build step. The local `.env` files have no effect on production.

**To add a new frontend env var to production:** add it to the workflow's build step `env:` block. Do NOT rely on `.env` files — they are local only and are never deployed.

Currently wired in the workflow: `VITE_API_BASE_URL`. Student app URL is hardcoded as a fallback in source (`https://student.chat9021.org`) since it doesn't change between environments.

### Local dev

Copy `.env.example` to `.env`. Required vars:
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`
- `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`
- `DEEPGRAM_SECRET_KEY`
- `AUTH_JWT_SECRET`
- `DYNAMODB_TABLE_NAME`, `DYNAMODB_AUTH_USERS_TABLE`
- `BEDROCK_MODEL_CHAT`, `BEDROCK_MODEL_EMBED`

## Never do this

Drawn from real incidents in this repo, not hypotheticals:

- **Don't treat a doc as a spec.** ~750 lines of an unused "question bank" feature (TanStack Query, React Hook Form, Zod — none of them installed) got generated because an old planning doc opened with "these supersede the current implementation." A doc describes what exists. If it's making a forward-looking claim, that's a defect — fix it, don't build against it.
- **`.env` changes do nothing in production for frontends.** `VITE_*` vars are baked in at Vite *build* time (see above). Editing a local `.env` file and expecting it to show up on `student.chat9021.org` will cost you a deploy cycle finding out it doesn't.
- **Don't assume your AWS CLI profile points at this project.** A contributor's default AWS profile may belong to an entirely different account. `AccessDenied` on a DynamoDB table usually means "wrong account," not "missing table" — check `aws sts get-caller-identity` before concluding infra is broken.
- **Don't trust an unverified header for authorization.** `X-User-Id` is accepted in some request signatures but never establishes identity — `resolve_principal()` ignores it and requires a valid `Authorization: Bearer <jwt>`. Authorize off the verified `AuthPrincipal`, never off a client-supplied header.
- **Don't add a route without checking `test_route_auth.py`.** An unauthenticated route reaching production is exactly the failure this repo has no code review to catch otherwise.

## Documentation map

`docs/`: `ARCHITECTURE.md` (system design, data flows, service map — **code wins on conflict**), `ONBOARDING.md` (local setup + codebase tour, start here if new), `DYNAMODB_SCHEMA.md`, `AUTH_CURRENT_STATE_AND_PLAN.md`, `ORAL_ASSESSMENT_DEPLOYMENT.md` (production runbook), `CHANGELOG.md` (what shipped, historical only), `ANALYTICS_LOGGING.md`.

Nested `CLAUDE.md` files exist in `src/main/controllers/` and `oral-assessment-student/` for context that isn't obvious from reading the directory. Don't add more without a specific reason — one in every directory is noise, not guidance.
