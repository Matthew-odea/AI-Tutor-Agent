# Architecture

> When architecture docs and code diverge, **code wins**. Update this file in the same change that introduces architectural shifts.

## System Overview

AI Tutor Agent is a FastAPI backend serving three frontend clients:

- **ai-tutor-frontend** -- RAG chat, code editor (Monaco + Pyodide), session history
- **oral-assessment-instructor** -- create assessments, upload students, generate questions, view results
- **oral-assessment-student** -- take assessments (audio/video/text), view feedback

All three frontends are React + TypeScript + Vite + Tailwind + Zustand apps that call the same backend API.

```
┌──────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│  ai-tutor-       │  │  oral-assessment-     │  │  oral-assessment-    │
│  frontend :5173  │  │  instructor :5175     │  │  student :5176       │
└────────┬─────────┘  └──────────┬───────────┘  └──────────┬───────────┘
         │                       │                          │
         └───────────────────────┼──────────────────────────┘
                                 │ HTTP/REST
                                 ▼
                    ┌────────────────────────┐
                    │  FastAPI Backend :8000  │
                    └────────────┬───────────┘
                                 │
         ┌───────────┬───────────┼───────────┬───────────┐
         ▼           ▼           ▼           ▼           ▼
      Bedrock      Neo4j     DynamoDB       S3         SQS
      (LLM)     (vectors)  (state)     (uploads)    (jobs)
                                                        │
                                                   Deepgram
                                                  (speech-to-text)
```

## Backend Layering

### Controllers (`src/main/controllers/`)

Routers map HTTP requests to service calls. Each router owns a URL prefix:

| Router | Prefix | Purpose |
|--------|--------|---------|
| `history_router.py` | `/internal/history` | Workspaces, view sessions, chat messages, threads, code memory |
| `assessment_router.py` | `/api/assessment` | Instructor: create assessments, enroll students, generate questions, evaluate, results |
| `student_router.py` | `/api/student` | Student: get questions, submit answers, view progress/results |
| `auth_router.py` | `/api/auth` | Login, signup, Google OAuth, refresh, password reset, student token exchange |
| `analytics_router.py` | `/internal/analytics` | Event telemetry ingestion and summaries |
| `InternalEndpoints.py` | `/internal/context`, `/api/s3` | Document upload/delete/list, S3 presigned URLs |

Supporting files:
- `api_errors.py` -- global error envelope `{"ok": false, "error": {"code", "message"}}`
- `controller_dependencies.py` -- DI container (`@lru_cache` singletons for all services)
- `controller_helpers.py` -- auth assertions, pedagogy mode resolution

### Auth (`src/main/auth/`)

- `service.py` -- JWT issuance/validation, password hashing (PBKDF2-SHA256), Google OAuth, password reset (SES), student invite token exchange
- `models.py` -- `AuthPrincipal` dataclass (user_id, email, roles, source)
- `dependencies.py` -- FastAPI dependencies: `require_auth_principal`, `require_role(role)`

### Services (`src/main/service/`)

Business logic layer. Key service groups:

**Chat & Context:**
- `ChatService` -- RAG workflow: vector search + history + prompt building + LLM call
- `ContextVectorService` -- document chunking, embedding, Neo4j vector store CRUD
- `PromptService` -- pedagogy-mode-specific system prompts

**Assessment Management:**
- `InstructorAssessmentService` -- assessment CRUD, student enrollment coordination
- `InstructorAssessmentCatalog` -- assessment create/read/update
- `InstructorAssessmentEnrollment` -- student CSV upload, enrollment management
- `InstructorAssessmentProgressAggregator` -- aggregate student progress
- `InstructorAssessmentResultsAggregator` -- aggregate evaluation results

**Student Assessment:**
- `OralAssessmentService` -- student-side: fetch questions, submit answers, track progress
- `OralAssessmentQuestionAccess` -- question retrieval for students
- `OralAssessmentAnswerSubmission` -- handle audio/text/video answer uploads
- `OralAssessmentProgressTracker` -- per-question progress tracking
- `OralAssessmentResultsAggregator` -- results for student view

**Question Generation & Evaluation:**
- `QuestionGenerationService` -- LLM-powered question generation from assignment briefs
- `ResponseEvaluationService` -- orchestrates async evaluation jobs
- `ResponseEvaluationEngine` -- LLM-based response scoring
- `EvaluationWorkflowRunner` -- runs evaluation workflow for batch jobs
- `ResponseEvaluationRepository` -- persist evaluations to DynamoDB
- `EvaluationWorkflowRunner` -- runs evaluation workflow for batch jobs

**Infrastructure Services:**
- `S3UploadService` -- presigned URL generation and upload management
- `SpeechToTextService` -- Deepgram API integration
- `TranscriptionService` -- transcription storage coordination
- `BatchJobManager` -- async batch job management
- `DynamoDBJobStore` -- persist batch jobs to DynamoDB
- `SQSJobDispatcher` -- dispatch/consume SQS messages for async processing
- `AnalyticsService` -- event tracking and aggregation
- `FileToTextService` -- PDF/document text extraction
- `TextPreprocessingService` -- text normalization

### LLM (`src/main/llm/`)

- `AgentCoreProvider` -- wraps Bedrock AgentCore runtime: `chat()`, `generate()`, `embed()`

### AgentCore Setup (`src/main/agentcore_setup/`)

- `AgentCoreClient` / `bootstrap.py` -- singleton Bedrock client initialization
- `config.py` -- model IDs: Nova Lite (chat), Titan Embed v2 (embeddings, 1024-dim)
- `memory.py` / `dynamodb_memory.py` -- conversation memory (in-memory or DynamoDB)
- `history.py` / `dynamodb_history.py` -- multi-session history store

## Data Flows

### RAG Chat

```
User message
  → POST /internal/history/views/{id}/message
  → ChatService.chat()
  → ContextVectorService: Neo4j vector search (top-k chunks)
  → Build prompt: system prompt + context + history + user query
  → Bedrock Nova Lite → response
  → Store in DynamoDB history
  → Return answer + source context IDs
```

### Assessment Question Generation

```
Instructor triggers batch generation
  → POST /api/assessment/{id}/generate-questions-batch
  → SQSJobDispatcher: send message to SQS queue
  → SQS consumer thread picks up job
  → QuestionGenerationService: for each student
    → Load student code + assignment brief
    → Bedrock → generate 5 specific + 3 general questions
    → Store questions in DynamoDB
  → Update job status in DynamoDB
```

### Student Assessment Flow

```
Student opens assessment link
  → POST /api/auth/student/exchange → single-use invite token exchanged for a 12-hour session JWT
  → GET /api/student/{id}/assessment/{aid}/questions → question list
  → For each question:
    → Record audio/video or type text answer
    → POST /api/s3/upload-url → upload media to S3
    → POST /api/student/{id}/answer → store answer metadata
  → PUT /api/student/{id}/submit → mark complete
```

Note: `answer` and `submit` are scoped by `student_id` only — the assessment is resolved server-side from the student's enrollment, not from an `{aid}` path segment.

### Batch Evaluation

```
Instructor triggers evaluation
  → POST /api/assessment/{id}/evaluate-batch
  → SQSJobDispatcher: send message to SQS queue
  → SQS consumer thread picks up job
  → EvaluationWorkflowRunner: for each student with submitted answers
    → Fetch questions + answers from DynamoDB
    → If audio/video: fetch transcript from S3 (or transcribe via Deepgram)
    → ResponseEvaluationEngine: Bedrock → correctness (0-5) + understanding (0-5),
      server-summed to a total_score (0-10 by default per question)
    → Store evaluation in DynamoDB
  → Update job status
```

Per-question max score defaults to 10 (`correctness + understanding`, each clamped 0-5) and grade cutoffs default to 90/75/60 (`excellent`/`competent`/`developing`). Both are resolved per-assessment by `ScoringConfig.from_metadata()` from optional `maxScorePerQuestion` / `gradeCutoffs` fields on the assessment's METADATA item — see `src/main/service/ScoringConfig.py`.

### Document Upload (RAG Context)

```
POST /internal/context/upload
  → ContextVectorService
  → TextPreprocessingService: normalize text
  → Chunk document by markdown headers
  → Bedrock Titan Embed: generate 1024-dim embeddings
  → Store chunks + embeddings in Neo4j
```

## Async Job System

One job mechanism: **SQS + DynamoDB**. `SQSJobDispatcher` sends messages to an SQS queue. A consumer thread started at app boot processes jobs and writes status to DynamoDB as `JOB#` records (see `DYNAMODB_SCHEMA.md`).

`BatchJobManager` is a thin compatibility wrapper kept so routers didn't need to change call sites -- it delegates to `DynamoDBJobStore` and holds no state of its own. There is no in-memory job fallback.

The SQS consumer connects two services: `QuestionGenerationService` (question generation jobs) and `EvaluationWorkflowRunner` (evaluation jobs).

## Data Persistence

| Store | What | Key Pattern |
|-------|------|-------------|
| DynamoDB `oral_assessments` | Assessments, students, questions, answers, evaluations, jobs | See `docs/DYNAMODB_SCHEMA.md` |
| DynamoDB `auth_users` | User credentials and profiles | `email` as partition key |
| Neo4j | Document chunks with vector embeddings | Graph nodes with vector index |
| S3 `assessment bucket` | Audio recordings: `audio/{userId}/{questionId}_{timestampMs}.{ext}`. Proctoring chunks: `proctoring/{assessmentId}/{userId}/chunk_{index:06d}.{ext}`. Keys are built server-side (`S3UploadService.build_upload_key`) from the authenticated principal, never from client input. Transcripts are not stored in S3 -- they're written to the `transcript` attribute on the DynamoDB answer item. |
| SQS | Async job messages | Transient |

## Frontend Architecture

All three apps follow the same pattern:

- **State**: Zustand stores (no Redux)
- **API**: Axios client with auth token interceptor, retry logic (ai-tutor-frontend has exponential backoff)
- **Routing**: React Router v7
- **Styling**: Tailwind CSS with custom design tokens
- **Testing**: Vitest

### ai-tutor-frontend (port 5173)
- Features: chat, sidebar with sessions, Monaco code editor, Pyodide Python execution, AI assistant panel
- Auth: full login/signup/Google OAuth via `LoginGate` component
- State: `chatStore` (messages, sessions, editor, programs), `toastStore`

### oral-assessment-instructor (port 5175)
- Features: assessment creation, CSV student upload, question generation/editing, progress monitoring, results dashboard with score override
- Auth: token-based via `AuthGate`
- State: `assessmentStore` (assessments, students, progress, results, jobs)

### oral-assessment-student (port 5176)
- Features: take assessment, audio/video/text recording, proctoring camera, progress tracker, results view
- Auth: student token from invite link stored in sessionStorage
- State: `assessmentStore` (questions, recording state, upload progress, proctoring)

### Shared Types
- `shared/types/assessment.ts` -- TypeScript types used by both oral assessment apps

## Error Contract

All API errors return:

```json
{
  "ok": false,
  "error": {
    "code": "auth_error | not_found | validation_error | dependency_failure | internal_error",
    "message": "Human-readable description"
  }
}
```

## Configuration

- **Backend settings**: `src/main/config/settings.py` (`AppSettings` dataclass, `@lru_cache` singleton)
- **Frontend API config**: `{app}/src/config/api.config.ts` or `{app}/src/services/api.ts`
- **Environment**: `.env` file locally, SSM Parameter Store in production (see `ORAL_ASSESSMENT_DEPLOYMENT.md`)
- **LLM models**: `src/main/agentcore_setup/config.py`

## Source of Truth

When architecture docs and code diverge, **code wins**.
