# Remediation plan — 2026-09-21

**Status: active. Phases 0, 1, 2 and most of 3 landed 2026-09-22/23, uncommitted.**
Working plan from a full-repo audit. Decisions below were made deliberately; do not
re-litigate them without a reason.

Verification at time of writing: `make check` green — backend 679 passed, ai-tutor-frontend
12, instructor 2, student 209. Coverage 75% against a CI gate of 68.
`tests/controllers/test_route_auth.py` green: 10 open routes, all on the allowlist with a
stated reason. Routes 96 → 84.

Net across everything so far: **3,528 source and test lines removed** (source −3,528,
tests −675, docs −927), 95 files touched. The backend test count fell from 759 to 679
because tests for deleted code went with it; coverage rose because what went was untested.

**Delete this file when Phase 4 completes.** A stale plan is worse than no plan —
this repo already learned that the hard way (see "Why this file has an expiry").

---

## Decisions locked

| Question | Decision |
|---|---|
| Real student data? | Yes, at rest between terms. Security work is days, not hours. |
| AI Tutor product? | Dormant, kept. No React 19 migration until it has CI. |
| Local dev without AWS? | Required — students/contributors run it. Use DynamoDB Local, not hand-rolled in-memory classes. |
| Code review? | None. Agents merge directly. **Tests are the only gate.** |
| Grade release? | Already correct: `manual` default, `immediate` for formative. Bulk release untested at scale. |
| Grading model? | Nova Lite, cost-driven, revisitable. Validate before committing next cohort. |
| Retention | Proctoring footage 12 months. Answer media, transcripts, evaluations 24 months. |
| Admin role | Keep — cross-instructor oversight is needed. Bootstrap before gating. |
| Question bank feature | Dead. Delete. |
| Analytics pipeline | Keep. Privacy-conscious by design (lengths and counts, never content). |
| Ed Stem integration | Keep. Instructor-supplied token, never persisted, never logged. |
| Frontend structure | npm workspaces: assessment apps first, tutor only after it has CI. |
| `assessment_router.py` | Do **not** split. Delete dead routes first, then re-measure. |
| Scale target | One course, ~400 students. No re-architecture. |

## Infrastructure — actual topology

Verified from SSM `/ai-tutor/prod/` on 2026-09-21.

- **Sydney `ap-southeast-2`** — EC2 `ai-tutor-app` (`i-017bee872633a5ef2`), and all live
  DynamoDB data. `oral_assessments` holds ~12,141 items, created 8 Apr 2026.
- **Virginia `us-east-1`** — SQS `ai-tutor-jobs`, Bedrock, SES. Deliberate: Nova Lite
  and Titan availability pinned Bedrock here, queue and SES followed.
- **Stale copies** — all four tables also exist in `us-east-1` as pre-migration
  originals (Nov 2025–Mar 2026). Not live. Hold real student data.
- **`footprints_core`** — different project, same account. Out of scope. Scope all
  terraform work to named AI-Tutor resources.

Two traps:

1. **The live Sydney tables are in no terraform state.** Production data managed by nothing.
2. **`terraform/assessment` is mixed** — its SQS queue is live, its DynamoDB resources
   point at the dead us-east-1 copies. An `apply` there looks like managing prod while
   touching corpses, and could take the live queue with it.

`terraform/minimal`'s ap-southeast-2 queue is the orphan.

---

## Phase 0 — security, while data is at rest — DONE except the last item

- [x] Delete `POST /api/student/token` (`student_router.py:55`) — unauthenticated token
      minting for any student ID
- [x] Replace it: session token `sessionStorage` → `localStorage`, invite exchange
      re-usable within the assessment window
- [x] Add `purpose` claim on issue, check it in `resolve_principal` — must land with the
      re-usable invite, not after
- [x] Add auth to the four `/internal/context/*` routes (`InternalEndpoints.py:28,48,58,75`)
- [x] Derive S3 keys server-side (`S3UploadService.py:22`) — also a prerequisite for
      retention, since prefixes currently come from the browser
- [x] Remove plaintext password fallback (`auth/service.py:243`)
- [x] `scripts/promote_to_admin.py`, run once, then gate `set_user_roles` on admin
      (`auth_router.py:154`)
- [x] CORS default `""` instead of `"*"`; add `ALLOW_ORIGINS`, `SQS_JOBS_QUEUE_URL`,
      `S3_ASSESSMENT_BUCKET` to the `required` set in `scripts/load-ssm-env.sh:66`
- [x] Delete the `X-User-Id` authorization branches (`controller_helpers.py:74-76`, `:103-104`)
- [x] **Route-auth test** — enumerate `app.routes` dynamically, assert each carries an auth
      dependency, check against a short explicit `PUBLIC_ROUTES` allowlist
- [ ] Verify proctoring chunks reassemble into watchable footage. If they don't, stop
      collecting until they do. **Still open — needs real S3 objects, so it needs you.**

Also landed, found during the work rather than in the audit:
- [x] `assessment_router.py:150` listed *every* instructor's assessments unfiltered when the
      principal came from `X-User-Id`. Unreachable once the header fallback went, deleted anyway.
- [x] `scripts/upload_db_context_batch.py` now sends a bearer token from `AI_TUTOR_TOKEN`;
      it would have started 401ing on the next corpus load.
- [x] `.env.example` pointed at a different chat *and embedding* model than the code defaults.
      Embeddings from a different model silently corrupt RAG results rather than failing.

## Phase 1 — build the gate — DONE

Must land before Phase 2. Deleting 4,700 lines with no review and a gate that can't fail
is how you discover something was load-bearing in production.

- [x] CI job for `ai-tutor-frontend` — currently deploys to prod with zero CI
- [x] Coverage ratchet 50 → 68 (actual is 71)
- [x] Stop `rm -f package-lock.json` in CI; add `@rollup/rollup-linux-x64-gnu` as an
      optionalDependency instead
- [x] `pyproject.toml` with `[tool.pytest.ini_options] pythonpath = ["."]` — the documented
      test command currently fails on a clean checkout
- [x] Root `Makefile`: `make check` = pytest + `npm run validate` × 3. `make e2e` separately.
- [x] `concurrency` group in `ci.yml`
- [x] The same `rm -f package-lock.json` was also in **both deploy workflows** — the ones that
      actually ship to production. All three now use `npm ci`.
- [x] `ai-tutor-frontend` had 4 failing tests, which would have made its new CI job red on day
      one. All four were stale tests, not broken code.

## Phase 2 — deletions — DONE

- [x] `src/utils/scrapeEdFiles.py` — 588 lines, zero references
- [x] Twelve dead endpoints in `assessment_router.py` (~497 lines) + question bank service,
      DTOs and tests (~250)
- [x] Exception ladder no-ops across controllers (~377 lines) — global handlers in
      `api_errors.py` already cover them
- [x] Dead frontend modules (~950): instructor `services/audio.ts` + `s3.ts`, student
      `services/video.ts`, four `ai-tutor-frontend/src/utils/` modules
- [x] Six unused Python deps (`moviepy` listed twice), `dotenv` shim, pinned `pip`
- [x] `Dockerfile:9-11` — `build-essential`, `ffmpeg`, `libgl1` (~500MB)
- [x] `memory.py` + `history.py` in-memory fallbacks and the `USE_DYNAMODB` branch (~965),
      **with DynamoDB Local added to `docker-compose.yml` first**
- [x] `ChatService._classify_edit_intent` unreachable LLM path (~60)
- [x] `terraform/minimal/systemd/` + `install_compose_systemd.sh` — dead
- [x] `git rm -r --cached e2e/test-results`
- [x] `InstructorSubmissionService.py` (316) — orphaned once its three upload endpoints went

**Corrections to this audit, found while doing the work:**
- The exception ladder was ~377 lines on paper; 96 were actually removed. `except ApiError: raise`
  is *not* a no-op while a blanket `except Exception` follows it — it stops the blanket clause
  relabelling a deliberate error. Handlers that map a domain error to a specific status were kept.
- `reportlab` and `google-auth` looked unused and are not. `google-auth` is reached through
  `importlib.import_module`, which no grep for `import google` finds.
- `get_bank_questions` reads `BANK_QUESTION#` items nothing writes any more. **Left in place**
  until someone confirms no such items exist in production — see Open below.

## Phase 3 — contributor-facing — docs done, tooling outstanding

The codebase is shared with students and casual contributors. Correct docs are
load-bearing, not cosmetic.

- [x] Docs 10 → 7 files with a correctness pass. Duplicates resolved, five wrong endpoint
      paths in `ARCHITECTURE.md` fixed, `QUICKSTART.md` merged into `ONBOARDING.md`,
      `docs/README.md` deleted.
      **Correction to this audit:** `ARCHITECTURE.md:170` was *not* wrong. Correctness 0-5 plus
      understanding 0-5 sums to the 10 in `ScoringConfig.py:25`. Two views of one number, not a
      contradiction. A real error found instead: the S3 key table was invented, and `JOB#{id}`
      records are top-level items, not nested under the student/assessment key.
- [x] Delete `PLATFORM_PLAN.md` §1-3 and §6; rename the rest to `CHANGELOG.md`. §5 also went —
      costed for ~20 concurrent students against a real target of ~400.
- [x] Restructure `CLAUDE.md` around tasks: verify-before-done, where-things-go, the
      endpoint contract, a never-do list
- [x] Two nested `CLAUDE.md`: `src/main/controllers/` (endpoint contract),
      `oral-assessment-student/` (confirmed: it defines 26 local interfaces instead of
      importing `shared/types`)
- [ ] `.claude/`: permissions allowlist, one `add-assessment-endpoint` skill, a PostToolUse
      hook on `shared/types/assessment.ts`
- [x] Generate TS types from `/openapi.json`; CI fails on drift. `shared/generate-api-types.sh`
      imports the app and calls `app.openapi()` — no server needed — and the `api-types-drift`
      CI job regenerates and fails on a diff.
      **Correction to this audit:** it was twelve `Date` fields across eight interfaces, not six,
      and they were already fixed. Three shared-type field *names* are still wrong against the
      DTOs (`Question.generatedAt` is `createdAt` on the wire; `QuestionGenerationJob.createdAt`
      and `EvaluationJob.createdAt` are both `startedAt`). No component reads them, so nothing is
      broken — but the generator cannot see a mismatch in a hand-written type.
- [x] Import `shared/types/api.ts` from the student and instructor apps. A renamed DTO field now
      fails `npm run type-check`. Doing it surfaced that `type-check` had been `tsc --noEmit`
      against solution tsconfigs, which checks zero files, and that the instructor app sent
      `student_ids` where the backend reads `studentIds`, so choosing specific students for
      generation or evaluation was silently ignored.
- [x] Rename the six sprint-numbered test files by domain
- [~] npm workspaces — **attempted and reverted deliberately.** Hoisting to a root lockfile
      broke `npm ci` in each frontend, which is exactly what both deploy workflows run. A tidy
      monorepo is not worth a broken deploy. Revisit only alongside the deploy workflows.

## Phase 4 — operational

- [ ] **Import live Sydney tables into terraform state** — highest infra risk
- [ ] Untangle `terraform/assessment`: live queue, dead tables
- [ ] Verify the 8 Apr migration captured everything, then decide on the stale us-east-1 tables
- [ ] S3 lifecycle: `proctoring/` 365 days, `audio/` 730 days. DynamoDB TTL to match.
      Analytics events currently have no retention at all.
- [x] Replace the per-submit daemon threads with `BackgroundTasks` (`student_router.py`) —
      **already done before this round; the audit was stale.** Now held by a test that asserts
      the work is registered on `BackgroundTasks` and still unrun when the handler returns.
- [x] `_notify_students` in `release_results` moved onto `BackgroundTasks`; three uncalled
      thread-spawning methods deleted.
- [x] Exclude `needs_review` evaluations from the score denominator — done, see Phase 0.
- [ ] Dry run on last term's data: bulk release-results + `get_score_agreement`.
      One exercise validates both the release gate and the Nova Lite choice.

---

## Open — not decisions, facts to confirm

### Three that a script answers

Run **`./scripts/prod_checks.sh`**. All three are read-only counts and parameter names against
production — nothing is written, and no student data is returned. It prints which AWS account it
reached first, because this machine's default profile belongs to a different organisation and an
AccessDenied there looks exactly like "no data".

| # | Question | What the answer changes |
|---|---|---|
| 1 | Is `AUTH_USERS_JSON` or `AUTH_LOGIN_PASSWORD` set in `/ai-tutor/prod/`? | **Blocks deploy.** The plaintext password fallback is gone. No stored DynamoDB password can be plaintext — every write path hashes — but these two env bootstraps are the one remaining source. If either holds a plaintext value, that login stops working the moment this ships. |
| 2 | Have instructors ever overridden a grade? | Whether real grades were misreported. The student view read `totalScore` and ignored `instructorScore`; the instructor view honoured it. So an overridden grade showed corrected to the instructor and uncorrected to the student. Fixed 2026-09-22. Non-zero means go back and check what those students saw. |
| 3 | Do any `BANK_QUESTION#` items exist? | Whether ten more lines can go. The question-bank write path is deleted but `OralAssessmentQuestionAccess.get_bank_questions` still reads it. Zero means delete the read; non-zero means those assessments depend on it. |

### The rest — no script can answer these

- The institutional retention window, if UNSW states one. 12/24 months is a judgement call
  until confirmed.
- Whether the Sydney migration captured everything from us-east-1.
- Whether proctoring footage reassembles into watchable video (blocks the last Phase 0 item).
- ~~`should_generate_on_submit` read-modify-write contention~~ — **this audit item was wrong.**
  It is a COUNT plus `claim_milestone()`, a conditional `update_item` that catches
  `ConditionalCheckFailedException`. There is no lost update. A test now forces the interleaving
  that would expose one, because the pre-existing ten-thread test passed against a deliberately
  broken implementation and so was never a race detector.

## Why this file has an expiry

The audit found ~750 lines of a "question bank" feature nobody remembers requesting, with
no frontend calling it. It was almost certainly generated by an agent reading
`PLATFORM_PLAN.md` §2 — which opens *"These supersede the current implementation where
noted"* and mandates TanStack Query, React Hook Form and Zod, none of which are installed.

Agents treat docs as instructions. A plan that outlives its decisions becomes a spec for
work nobody wants. Delete this when it's done.
