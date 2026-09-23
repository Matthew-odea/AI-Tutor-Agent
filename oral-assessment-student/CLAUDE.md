# oral-assessment-student/

Unlike `oral-assessment-instructor`, this app does **not** import from `shared/types/assessment.ts`. It defines its own local `interface`s per file (26 of them, as of this writing) instead. If you're adding a type that should match the instructor app's shape (e.g. a question or answer payload), check `shared/types/assessment.ts` for drift by hand — there's no shared source here to keep them in sync automatically. Don't assume importing from `shared/types/` will work; it isn't wired into this app's `tsconfig`/build.

Auth: a session JWT obtained by exchanging an invite token via `POST /api/auth/student/exchange`, stored in `sessionStorage` (not `localStorage` — deliberately cleared when the tab closes).
