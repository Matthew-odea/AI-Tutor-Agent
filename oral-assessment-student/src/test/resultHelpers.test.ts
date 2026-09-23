import { describe, it, expect } from 'vitest';
import {
  deriveResultStatus,
  totalMaxFor,
  componentMaxFor,
  scorePercent,
  scoreColorClass,
  statusBadgeFor,
  isResultsNotReleasedError,
  isResultsPendingError,
  isResultsStillPending,
  TIME_EXPIRED_SENTINEL,
  DEFAULT_QUESTION_MAX,
} from '../utils/resultHelpers';

describe('deriveResultStatus', () => {
  it('treats the time-expired sentinel as skipped', () => {
    expect(deriveResultStatus({ transcript: TIME_EXPIRED_SENTINEL, totalScore: 0 })).toBe('skipped');
  });

  it('trims whitespace around the sentinel', () => {
    expect(deriveResultStatus({ transcript: '  (time expired)  ', totalScore: 0 })).toBe('skipped');
  });

  it('treats a null/undefined total score as grading-failed', () => {
    expect(deriveResultStatus({ transcript: 'A real answer', totalScore: null })).toBe('grading-failed');
    expect(deriveResultStatus({ transcript: 'A real answer', totalScore: undefined as unknown as number })).toBe(
      'grading-failed'
    );
  });

  it('returns graded for a normal scored result', () => {
    expect(deriveResultStatus({ transcript: 'A real answer', totalScore: 7 })).toBe('graded');
  });

  it('returns graded for a legitimate zero score', () => {
    expect(deriveResultStatus({ transcript: 'Wrong but answered', totalScore: 0 })).toBe('graded');
  });

});

describe('totalMaxFor / componentMaxFor', () => {
  it('defaults the total max to 10', () => {
    expect(totalMaxFor({})).toBe(DEFAULT_QUESTION_MAX);
    expect(totalMaxFor({ maxScore: undefined })).toBe(10);
  });

  it('uses the provided max', () => {
    expect(totalMaxFor({ maxScore: 20 })).toBe(20);
  });

  it('splits the component max as half the total', () => {
    expect(componentMaxFor({})).toBe(5);
    expect(componentMaxFor({ maxScore: 20 })).toBe(10);
  });
});

describe('scorePercent', () => {
  it('computes a rounded percentage', () => {
    expect(scorePercent(7, 10)).toBe(70);
    expect(scorePercent(1, 3)).toBe(33);
  });

  it('guards divide-by-zero', () => {
    expect(scorePercent(5, 0)).toBe(0);
  });
});

describe('scoreColorClass', () => {
  it('bands by percentage', () => {
    expect(scoreColorClass(95)).toContain('success');
    expect(scoreColorClass(75)).toContain('caution');
    expect(scoreColorClass(55)).toContain('slate');
    expect(scoreColorClass(20)).toContain('danger');
  });
});

describe('statusBadgeFor', () => {
  it('shows a percentage badge for graded', () => {
    expect(statusBadgeFor('graded', 80)).toEqual({ label: '80%', className: expect.stringContaining('caution') });
  });

  it('shows a neutral Skipped badge (never red 0%)', () => {
    const badge = statusBadgeFor('skipped', null);
    expect(badge.label).toBe('Skipped');
    expect(badge.className).toContain('slate');
    expect(badge.className).not.toContain('red');
  });

  it('shows a neutral Not attempted badge', () => {
    expect(statusBadgeFor('not-attempted', null).label).toBe('Not attempted');
  });

  it('shows an amber Grading unavailable badge', () => {
    const badge = statusBadgeFor('grading-failed', null);
    expect(badge.label).toBe('Grading unavailable');
    expect(badge.className).toContain('caution');
  });
});

describe('isResultsNotReleasedError', () => {
  it('matches a 403', () => {
    expect(isResultsNotReleasedError({ message: 'x', status: 403 })).toBe(true);
  });

  it('matches the backend "not released" message regardless of status', () => {
    expect(isResultsNotReleasedError({ message: 'Results not released yet for student', status: 404 })).toBe(true);
  });

  it('is false for null and unrelated errors', () => {
    expect(isResultsNotReleasedError(null)).toBe(false);
    expect(isResultsNotReleasedError({ message: 'Server exploded', status: 500 })).toBe(false);
  });
});

describe('isResultsPendingError', () => {
  it('matches a 202', () => {
    expect(isResultsPendingError({ message: 'x', status: 202 })).toBe(true);
  });

  it('matches pending messages', () => {
    expect(isResultsPendingError({ message: 'Results not available yet for student', status: 404 })).toBe(true);
    expect(isResultsPendingError({ message: 'Your assessment is being evaluated' })).toBe(true);
  });

  it('matches the backend message carried in details when the top-level message is a friendly fallback', () => {
    // Mirrors production: handleApiError rewrites a 404 message to a generic
    // fallback, but the real domain message survives in the error envelope.
    expect(
      isResultsPendingError({
        message: 'Assessment not found — please check your link or contact your instructor.',
        status: 404,
        details: { ok: false, error: { message: 'Results not available yet for student' } },
      })
    ).toBe(true);
  });

  it('is false for null and unrelated errors', () => {
    expect(isResultsPendingError(null)).toBe(false);
    expect(isResultsPendingError({ message: 'Not enrolled', status: 404 })).toBe(false);
  });
});

describe('isResultsStillPending', () => {
  it('is true for either flavour of pending', () => {
    expect(isResultsStillPending({ message: 'not released', status: 404 })).toBe(true);
    expect(isResultsStillPending({ message: 'not available', status: 404 })).toBe(true);
  });

  it('is false for a hard error', () => {
    expect(isResultsStillPending({ message: 'Not enrolled', status: 404 })).toBe(false);
  });
});
