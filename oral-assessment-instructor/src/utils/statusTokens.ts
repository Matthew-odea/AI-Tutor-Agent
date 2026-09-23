/**
 * Single source of status chip classes and labels; never inline a status colour
 * or label elsewhere. Presentation only: callers still derive the status.
 *
 * Colour buckets (pick one for any new state):
 *   accent   live / actionable            (active, Open)
 *   success  terminal-good                (completed, submitted, All Submitted, Evaluated)
 *   caution  in flight                    (in-progress, In Progress)
 *   inert    not started / unknown        (not-started, draft, archived)
 * Two terminal-good states differ by weight (tint + ring), never by hue. Grades
 * add danger for Unsatisfactory. Chip classes carry no geometry; the call site
 * adds padding/radius.
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

/** Derived, not persisted: StudentProgressTable computes it. Keys double as display text. */
export type AssessmentPhase =
  | 'Not Started'
  | 'Open'
  | 'In Progress'
  | 'All Submitted'
  | 'Evaluated';

/** Grade band. `Unsatisfactory` is canonical — never "Needs Improvement". */
export type Grade = 'Excellent' | 'Competent' | 'Developing' | 'Unsatisfactory';

export interface StatusToken {
  className: string;
  label: string;
}

/** Also the fallback for unrecognised values, so a new backend status renders quietly. */
export const INERT_CHIP = 'text-slate bg-ink/5';

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

// Ring is inset so the chip never bleeds into a neighbour in a tight table row.
export const ASSESSMENT_PHASE_CHIP: Record<AssessmentPhase, string> = {
  'Not Started': INERT_CHIP,
  Open: 'text-accent bg-accent/10',
  'In Progress': 'text-caution bg-caution/10',
  'All Submitted': 'text-success bg-success/10',
  Evaluated: 'text-success bg-success/15 ring-1 ring-inset ring-success/30',
};

// Identity map so a key can be renamed without touching call sites.
export const ASSESSMENT_PHASE_LABEL: Record<AssessmentPhase, string> = {
  'Not Started': 'Not Started',
  Open: 'Open',
  'In Progress': 'In Progress',
  'All Submitted': 'All Submitted',
  Evaluated: 'Evaluated',
};

// Competent is accent, not a second "good" hue, so only Excellent reads as success.
export const GRADE_CHIP: Record<Grade, string> = {
  Excellent: 'text-success bg-success/10',
  Competent: 'text-accent bg-accent/10',
  Developing: 'text-caution bg-caution/10',
  Unsatisfactory: 'text-danger bg-danger/10',
};

// Lookups take loose strings (API values); unknown values get the inert chip and a
// Title Cased label, missing values an em dash.

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

export function studentStatusToken(status: string | null | undefined): StatusToken {
  return resolve(status, STUDENT_STATUS_CHIP, STUDENT_STATUS_LABEL);
}

export function assessmentStatusToken(status: string | null | undefined): StatusToken {
  return resolve(status, ASSESSMENT_STATUS_CHIP, ASSESSMENT_STATUS_LABEL);
}

export function assessmentPhaseToken(phase: string | null | undefined): StatusToken {
  return resolve(phase, ASSESSMENT_PHASE_CHIP, ASSESSMENT_PHASE_LABEL);
}

export function gradeToken(grade: string | null | undefined): StatusToken {
  if (!grade) return { className: INERT_CHIP, label: 'Not Graded' };
  return { className: GRADE_CHIP[grade as Grade] ?? INERT_CHIP, label: grade };
}
