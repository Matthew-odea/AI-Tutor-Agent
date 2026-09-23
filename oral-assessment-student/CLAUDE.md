# oral-assessment-student/

API request and response shapes come from `shared/types/api.ts`, which is generated from the backend's OpenAPI schema by `shared/generate-api-types.sh` — alias onto `components["schemas"][...]` in `src/types/index.ts` rather than writing a new interface. If the backend changes a DTO, regenerate and `npm run type-check` will show every place this app breaks; the `api-types-drift` CI job fails if you forget. Purely UI-local types stay local.

Auth: a session JWT obtained by exchanging an invite token via `POST /api/auth/student/exchange`, stored in `localStorage` (`studentToken`, see `services/api.ts`) so a refresh or a reopened tab mid-exam keeps the student signed in.
