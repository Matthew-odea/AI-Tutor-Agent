/**
 * statusTokens — the ONE source of status chip classes and status labels for the
 * instructor app.
 *
 * WHY THIS EXISTS
 * Every screen used to keep its own status map, and they disagreed. Concretely:
 * `completed` was `success` in StudentProgressTable but `accent` in
 * AssessmentList; the per-row `submitted` chip was `accent` while the cohort
 * phase `All Submitted` was `success`; phase `Open` and phase `Evaluated` shared
 * an identical accent tint despite sitting at opposite ends of the lifecycle;
 * AssessmentList printed `assessment.status` raw and lowercase ("active",
 * "draft") while every other chip went through a Title Case map; and the grade
 * badge map existed twice, byte-identical, in ResultsDashboard and
 * StudentResultDetail. Import from here instead. Never inline a status colour or
 * a status label string again.
 *
 * THE FOUR-WAY SEMANTICS — every map below derives from this one principle, so
 * if you are adding a state, pick its colour by asking which bucket it is in:
 *
 *   accent   live / currently actionable        (assessment `active`, phase `Open`)
 *   success  terminally done, good outcome      (`completed`, `submitted`,
 *                                                `All Submitted`, `Evaluated`)
 *   caution  in flight / needs a human glance   (`in-progress`, phase `In Progress`)
 *   slate on bg-ink/5
 *            not started / inert / lowest emphasis (`not-started`, `draft`,
 *                                                   `archived`, unknown values)
 *
 * Terminal-good states are `success` EVERYWHERE — that is the rule that settles
 * the `completed` contradiction in both directions. Where two terminal-good
 * states must still be told apart (phase `Evaluated` vs phase `All Submitted`),
 * they differ by WEIGHT inside the success family — a stronger tint plus a ring
 * — never by hue. A second "good" hue would re-create the original problem.
 *
 * Grades are the one place a fourth hue appears, because `Unsatisfactory` is a
 * genuinely bad outcome rather than a lifecycle position: Excellent → success,
 * Competent → accent, Developing → caution, Unsatisfactory → danger.
 *
 * SCOPE: presentation only. These are classes and labels. Nothing here derives a
 * status — the callers still own "is this cohort fully submitted?" and friends.
 *
 * Chip classes are foreground + soft tint only. They carry no radius, padding or
 * font weight, so the call site keeps control of chip vs pill geometry:
 *
 *   const { className, label } = studentStatusToken(p.status);
 *   <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${className}`}>
 *     {label}
 *   </span>
 */

/*
 * The API types every status and grade below as a plain string, so these unions
 * are the display vocabulary, not a wire contract. The lookups take `string` and
 * fall back to a neutral chip for anything not listed.
 */

/** Per-student enrolment status, as reported by the progress endpoint. */
export type StudentStatus = 'not-started' | 'in-progress' | 'completed' | 'submitted';

/** Assessment lifecycle status, as stored on the assessment record. */
export type AssessmentStatus = 'draft' | 'active' | 'completed' | 'archived';

/**
 * Cohort phase — a derived, display-only roll-up of the whole cohort's progress.
 * Unlike the other two this is not a persisted field: StudentProgressTable
 * computes it from the per-student statuses and the evaluation job states. The
 * strings are the keys AND the display text, so they are already Title Case.
 */
export type AssessmentPhase =
  | 'Not Started'
  | 'Open'
  | 'In Progress'
  | 'All Submitted'
  | 'Evaluated';

/** Grade band. `Unsatisfactory` is canonical — never "Needs Improvement". */
export type Grade = 'Excellent' | 'Competent' | 'Developing' | 'Unsatisfactory';

/** What a chip needs: the tint classes and the human-readable label. */
export interface StatusToken {
  className: string;
  label: string;
}

/**
 * The lowest-emphasis chip. Used for not-started/inert states AND as the
 * fallback for any value we do not recognise, so a new backend status renders
 * quietly instead of unstyled.
 */
export const INERT_CHIP = 'text-slate bg-ink/5';

/* ── Per-student enrolment status ────────────────────────────────────────────
   `completed` and `submitted` are both terminal-good, so both are success; the
   label is what tells them apart. (`submitted` used to be accent here, which
   made a finished student look like a live one.) */

export const STUDENT_STATUS_CHIP: Record<StudentStatus, string> = {
  'not-started': INERT_CHIP,
  'in-progress': 'text-caution bg-caution/10',
  completed: 'text-success bg-success/10',
  submitted: 'text-success bg-success/10',
};

export const STUDENT_STATUS_LABEL: Record<StudentStatus, string> = {
  'not-started': 'Not Started',
  'in-progress': 'In Progress',
  completed: 'Completed',
  submitted: 'Submitted',
};

/* ── Assessment lifecycle status ─────────────────────────────────────────────
   `active` is the live, currently-actionable state → accent. `completed` is the
   terminal-good state → success (it was accent here, colliding with `active`'s
   meaning). `archived` is deliberately the quietest chip on the page. */

export const ASSESSMENT_STATUS_CHIP: Record<AssessmentStatus, string> = {
  draft: INERT_CHIP,
  active: 'text-accent bg-accent/10',
  completed: 'text-success bg-success/10',
  archived: 'text-slate/70 bg-ink/5',
};

export const ASSESSMENT_STATUS_LABEL: Record<AssessmentStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  completed: 'Completed',
  archived: 'Archived',
};

/* ── Cohort phase ────────────────────────────────────────────────────────────
   `Evaluated` is the end of the line, so it stays in the success family and
   earns its extra weight from a stronger tint plus an inset ring rather than a
   different hue. The ring is inset so the chip never bleeds into a neighbour in
   a tight table row. */

export const ASSESSMENT_PHASE_CHIP: Record<AssessmentPhase, string> = {
  'Not Started': INERT_CHIP,
  Open: 'text-accent bg-accent/10',
  'In Progress': 'text-caution bg-caution/10',
  'All Submitted': 'text-success bg-success/10',
  Evaluated: 'text-success bg-success/15 ring-1 ring-inset ring-success/30',
};

/**
 * Phase keys are already display strings; the map exists so a key can be
 * renamed without touching every call site, and so phase reads like the other
 * two status families.
 */
export const ASSESSMENT_PHASE_LABEL: Record<AssessmentPhase, string> = {
  'Not Started': 'Not Started',
  Open: 'Open',
  'In Progress': 'In Progress',
  'All Submitted': 'All Submitted',
  Evaluated: 'Evaluated',
};

/* ── Grade bands ─────────────────────────────────────────────────────────────
   Previously duplicated verbatim in ResultsDashboard and StudentResultDetail.
   Competent takes the accent tint rather than a second "good" colour, so only
   Excellent reads as success. */

export const GRADE_CHIP: Record<Grade, string> = {
  Excellent: 'text-success bg-success/10',
  Competent: 'text-accent bg-accent/10',
  Developing: 'text-caution bg-caution/10',
  Unsatisfactory: 'text-danger bg-danger/10',
};

/* ── Lookups ─────────────────────────────────────────────────────────────────
   Each takes a loose `string` because these values arrive from the API, and
   returns a safe token so an unrecognised value still renders a readable chip:
   the inert tint plus a best-effort Title Case of whatever came through. A
   missing value renders an em dash rather than the word "undefined". */

/** "in-progress" / "not_started" → "In Progress" / "Not Started". */
function titleCase(raw: string): string {
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function resolve(
  value: string | null | undefined,
  chips: Record<string, string>,
  labels: Record<string, string>
): StatusToken {
  if (!value) return { className: INERT_CHIP, label: '—' };
  return {
    className: chips[value] ?? INERT_CHIP,
    label: labels[value] ?? titleCase(value),
  };
}

/** Chip classes + Title Case label for a per-student enrolment status. */
export function studentStatusToken(status: string | null | undefined): StatusToken {
  return resolve(status, STUDENT_STATUS_CHIP, STUDENT_STATUS_LABEL);
}

/** Chip classes + Title Case label for an assessment's lifecycle status. */
export function assessmentStatusToken(status: string | null | undefined): StatusToken {
  return resolve(status, ASSESSMENT_STATUS_CHIP, ASSESSMENT_STATUS_LABEL);
}

/** Chip classes + label for a derived cohort phase. */
export function assessmentPhaseToken(phase: string | null | undefined): StatusToken {
  return resolve(phase, ASSESSMENT_PHASE_CHIP, ASSESSMENT_PHASE_LABEL);
}

/** Chip classes + label for a grade band. Grades are already display strings. */
export function gradeToken(grade: string | null | undefined): StatusToken {
  if (!grade) return { className: INERT_CHIP, label: 'Not Graded' };
  return { className: GRADE_CHIP[grade as Grade] ?? INERT_CHIP, label: grade };
}
