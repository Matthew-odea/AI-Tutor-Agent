# DynamoDB Schema Reference

This document describes active key patterns used by assessment/auth features.

## Assessment Table

Default table name:

- `oral_assessments` (configurable via `DYNAMODB_ASSESSMENT_TABLE`)

### Core Item Patterns

#### Assessment metadata

- `PK = ASSESSMENT#{assessmentId}`
- `SK = METADATA`

Attributes include: `title`, `course`, `description`, `dueDate`, `totalQuestions`, `timeLimit`, `status`, `createdBy`, timestamps. Optional scoring overrides: `maxScorePerQuestion`, `gradeCutoffs` (see `src/main/service/ScoringConfig.py`).

#### Student enrollment per assessment

- `PK = ASSESSMENT#{assessmentId}`
- `SK = STUDENT#{studentId}`

Attributes include: `name`, `email`, `studentId`, `code`, `assignmentFile`, `status`, `enrolledAt`, optional submission timestamps.

#### Student assessment-scoped records

- `PK = STUDENT#{studentId}#ASSESSMENT#{assessmentId}`

Sort-key subtypes:

- `QUESTION#{questionId}`
- `ANSWER#{questionId}`
- `EVALUATION#{questionId}`
- `PROGRESS`
- `EVAL_PROGRESS` — per-student evaluation progress tracker, written by `ResponseEvaluationRepository.set_evaluation_progress()`

#### Batch job records

- `PK = JOB#{jobId}`
- `SK = METADATA`

A standalone item (not nested under a student/assessment composite key), written by `DynamoDBJobStore` / `SQSJobDispatcher`. Attributes: `job_id`, `job_type`, `assessment_id`, `status`, `total_items`, `processed_count`, `successful_count`, `failed_count`, `started_at`, `completed_at`, `error`, `metadata`, `TTL` (7-day auto-cleanup).

### Access Patterns

- Get assessment by id
- List assessments (via GSI)
- List students in assessment
- Get questions/answers/evaluations for student+assessment
- Read/write progress summary
- Read/write per-student evaluation progress (`EVAL_PROGRESS`)
- Read/write batch job state (`JOB#`)

## Auth Users Table (Optional)

Default table name:

- `auth_users` (configurable via `DYNAMODB_AUTH_USERS_TABLE`)

Used when persistent credential-backed auth users are enabled.

## Notes

- Keep key prefixes stable (`ASSESSMENT#`, `STUDENT#`, `JOB#`, etc.) to avoid breaking query patterns.
- Any schema/key change must be paired with service updates and route tests.
