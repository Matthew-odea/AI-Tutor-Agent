# Changelog

What actually shipped, in the order it shipped. This is a historical record, not a plan -- see repo-root `PLAN.md` for current, active decisions. If you're an agent reading this file looking for instructions: there are none here, only facts about the past.

The project was built as 9 roughly-two-week sprints. Sprint numbers below are historical markers, not a schedule.

## Sprint 6-7: video, proctoring, evaluation pipeline

- **Video answer transcription + evaluation**: `TranscriptionService` downloads audio/video from S3, transcribes via Deepgram with 3-attempt exponential backoff, writes `transcript` + `transcript_status` back to the DynamoDB answer item. `EvaluationWorkflowRunner` runs a transcription pre-pass before the evaluation loop.
- **Batch evaluation via SQS**: `evaluate_batch` endpoint replaced an in-memory polling loop with `SQSJobDispatcher.enqueue_evaluation_batch`. All job state moved to DynamoDB (`JOB#{jobId}`); the old in-memory `BatchJobManager` was rewritten as a thin wrapper around it.
- **Auto-evaluation on full submission**: `submit_assessment` counts submitted students; if `autoEvaluate=True` and all have submitted, enqueues a batch evaluation job via SQS.
- **Custom evaluation rubric**: `rubric` field on assessment metadata, injected into the evaluation prompt.

## Sprint 8: results dashboards

- **Proctoring chunk health indicator**: `StudentResultDetail` shows per-student chunk count, missing indexes, and a chunk-by-chunk manifest.
- **Class-level results dashboard**: median stat, name sort, "Release Results" toggle, SSE auto-refresh on evaluation job completion, CSV export.
- **Per-student results with score override**: `GET /api/assessment/{id}/student/{studentId}/results` returns per-question detail (transcript, playback URL, AI score, override). `PUT /api/assessment/{id}/student/{studentId}/question/{questionId}/override` writes `instructorScore`; the effective score uses the override when set.
- **Results release gate**: `PUT /api/assessment/{id}/release-results` sets `resultsReleased` on assessment metadata. The student results endpoint refuses until it's set. PDF download via `GET /api/student/{id}/assessment/{id}/results/pdf`.
- **Live progress monitor**: "Inactive 30m+" badge for in-progress students; per-row "Send Reminder" button sends an SES email.

## Sprint 9: question editing, observability, CI

- **Question preview and editing**: `GET/PUT/DELETE/POST /api/assessment/{id}/students/{studentId}/questions[/{questionId}]`, locked to draft/scheduled assessments only.
- **Structured logging**: `LOG_FORMAT=json` switches to single-line JSON output (for CloudWatch); default is human-readable text. Every non-health request is logged with `request_id, method, path, status, duration_ms`.
- **Test suite hardening**: `moto[dynamodb,s3,sqs,ses]` for AWS mocking; Vitest added to both oral-assessment frontends; Playwright E2E covering the student-results / instructor-list critical path.
- **GitHub Actions CI**: 4 parallel jobs (backend pytest+moto, instructor Vitest, student Vitest, Playwright E2E). Backend enforces >=70% coverage.

## After Sprint 9

- **SES production setup**: closed. Production access is granted in **us-east-1** (the region the app actually sends from -- `AUTH_PASSWORD_RESET_SES_REGION=us-east-1`). The `chat9021.org` domain identity is DKIM-verified for both configured senders (`assessments@chat9021.org`, `noreply@chat9021.org`).
  - `ap-southeast-2` SES is still sandboxed with zero verified identities. That's fine -- nothing sends from there. Don't "fix" it by pointing the SES region at the backend's own region; that would break outbound mail.
- **Per-question evaluation progress**: `ResponseEvaluationRepository.set_evaluation_progress()` writes an `EVAL_PROGRESS` item (questions evaluated, total, percentage, status) at the start, after each question, and at the terminal state. `GET /api/assessment/{id}/students/{studentId}/evaluation-progress` streams it over SSE, polling every 2s.
- **Auto report generation on >=10 submissions** (2026-07-23 to 2026-08-04): `AssessmentReportService` generates a cohort summary report once >=N students (default 10, configurable via `autoReportThreshold`) have submitted, instead of waiting for every enrolled student.
  - Trigger: `submit_assessment` spawns a background thread; a conditional DynamoDB update (`REPORT_TRIGGER` marker) ensures exactly one caller wins per milestone crossing, and regenerates at every multiple of the threshold as stragglers arrive.
  - Output: submission/evaluation counts, score stats, grade distribution, a decile histogram, correctness-vs-understanding averages, and an optional short LLM-written narrative (via `BEDROCK_MODEL_REPORT`, falls back to `BEDROCK_MODEL_CHAT`). Aggregate only -- no student names, emails, or IDs.
  - Endpoints: `GET /api/assessment/{id}/report`, `POST /api/assessment/{id}/report/generate`, `GET /api/assessment/{id}/report.html`, `GET /api/assessment/{id}/report.pdf` (WeasyPrint; returns 503 with a `brew install` hint if the native libs are missing locally -- the HTML version always works).
