/**
 * E2E critical path — Student assessment flow:
 *   1. Landing page link entry
 *   2. Consent modal
 *   3. Pre-assessment overview
 *   4. Written answer → Submit Answer → advance to Q2
 *   5. Submit Assessment + confirmation modal
 *   6. Results page
 *
 * All API calls are intercepted by page.route() so no real backend is needed.
 */

import { test, expect } from '@playwright/test';
import { setupStudentMockApi, mockJwt } from './helpers/mockApi';

const STUDENT_BASE = 'http://localhost:5176';
const STUDENT_ID = 'stu-e2e-001';
const ASSESSMENT_ID = 'asmt-e2e-001';

async function injectStudentSession(page: import('@playwright/test').Page) {
  const token = mockJwt({ sub: STUDENT_ID });
  await page.addInitScript(([sid, aid, tok]) => {
    localStorage.setItem('studentToken', tok);
    localStorage.setItem('authToken', tok);
    localStorage.setItem('studentId', sid);
    localStorage.setItem('assessmentId', aid);
  }, [STUDENT_ID, ASSESSMENT_ID, token]);
}

// ─── Student: Results viewing ────────────────────────────────────────

test.describe('Student assessment results', () => {
  test.beforeEach(async ({ page }) => {
    await setupStudentMockApi(page, { studentId: STUDENT_ID, assessmentId: ASSESSMENT_ID });
    // Override progress to return 'submitted' so ViewResults shows the results page
    await page.route(
      `**/api/student/${STUDENT_ID}/assessment/${ASSESSMENT_ID}/progress`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ answeredQuestions: 2, totalQuestions: 2, status: 'submitted' }),
        });
      }
    );
    await injectStudentSession(page);
  });

  test('student can view results after submission', async ({ page }) => {
    await page.goto(`${STUDENT_BASE}/${STUDENT_ID}/results/${ASSESSMENT_ID}`);

    await expect(page.getByText('Assessment Results')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('70%')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Competent')).toBeVisible();
    await expect(page.getByText('Question Details')).toBeVisible();
  });

  test('results page shows pending when not released', async ({ page }) => {
    // Override results to return a 403 (not released)
    await page.route(
      `**/api/student/${STUDENT_ID}/assessment/${ASSESSMENT_ID}/results`,
      async (route) => {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Results not released yet' }),
        });
      }
    );

    await page.goto(`${STUDENT_BASE}/${STUDENT_ID}/results/${ASSESSMENT_ID}`);

    await expect(page.getByText('Results Pending Release')).toBeVisible({ timeout: 10_000 });
  });
});

// ─── Student: Full assessment-taking flow ────────────────────────────

test.describe('Student assessment-taking flow', () => {
  test.beforeEach(async ({ page }) => {
    await setupStudentMockApi(page, { studentId: STUDENT_ID, assessmentId: ASSESSMENT_ID });
    await injectStudentSession(page);
  });

  test('consent modal → overview → answer Q1 → Q2 → submit', async ({ page }) => {
    await page.goto(`${STUDENT_BASE}/${STUDENT_ID}/${ASSESSMENT_ID}`);

    // 1. Consent modal appears first
    await expect(page.getByRole('heading', { name: 'Proctoring' })).toBeVisible({ timeout: 10_000 });

    // Decline proctoring to proceed without camera
    await page.getByRole('button', { name: /continue without recording/i }).click();

    // 2. Pre-assessment overview
    await expect(page.getByText('E2E Test Assessment')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('COMP9021')).toBeVisible();

    await page.getByRole('button', { name: /start assessment/i }).click();

    // 3. Question 1 — written mode (text appears in both banner and body, scope to banner)
    await expect(page.getByRole('banner').getByText('Question 1 of 2')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Explain your implementation approach.')).toBeVisible();

    // 4. Type a sufficient text answer
    const textarea = page.getByPlaceholder('Type your answer here...');
    await textarea.fill(
      'I used a recursive approach with dynamic programming and memoization to achieve optimal performance.'
    );

    // Submit the answer — store calls API then auto-advances via loadQuestions()
    await page.getByRole('button', { name: /submit answer/i }).click();

    // 5. Question 2 appears automatically after the store reloads from server
    await expect(page.getByRole('banner').getByText('Question 2 of 2')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('What are the time complexity trade-offs?')).toBeVisible();

    // Answer Q2
    const textarea2 = page.getByPlaceholder('Type your answer here...');
    await textarea2.fill(
      'The time complexity is O(n log n) for the merge sort approach, with O(n) space complexity.'
    );
    await page.getByRole('button', { name: /submit answer/i }).click();

    // 6. After Q2 submitted, "Submit Assessment" appears (Q2 is the last question)
    await expect(
      page.getByRole('button', { name: /submit assessment/i })
    ).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /submit assessment/i }).click();

    // 7. Confirmation modal
    await expect(page.getByText('Submit Assessment?')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/your assessment will be sent for evaluation/i)).toBeVisible();

    // Confirm submission — button text is just "Submit" inside the modal
    await page.getByRole('button', { name: /^submit$/i }).click();

    // 8. Submission success screen
    await expect(page.getByText('Assessment Submitted')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/submitted for evaluation/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /check results/i })).toBeVisible();

    // 9. Click through to results page
    await page.getByRole('button', { name: /check results/i }).click();
    await expect(page.getByText('Assessment Results')).toBeVisible({ timeout: 15_000 });
  });

  test('consent modal shows proctoring info', async ({ page }) => {
    await page.goto(`${STUDENT_BASE}/${STUDENT_ID}/${ASSESSMENT_ID}`);

    await expect(page.getByRole('heading', { name: 'Proctoring' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/webcam proctoring/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /i consent/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /continue without recording/i })).toBeVisible();
  });

  test('text answer submit button disabled until minimum characters reached', async ({ page }) => {
    await page.goto(`${STUDENT_BASE}/${STUDENT_ID}/${ASSESSMENT_ID}`);

    await page.getByRole('button', { name: /continue without recording/i }).click();
    await page.getByRole('button', { name: /start assessment/i }).click();

    await expect(page.getByPlaceholder('Type your answer here...')).toBeVisible({ timeout: 10_000 });

    // Too short
    await page.getByPlaceholder('Type your answer here...').fill('Short');
    await expect(page.getByRole('button', { name: /submit answer/i })).toBeDisabled();

    // Should show characters needed
    await expect(page.getByText(/more characters needed/)).toBeVisible();
  });

  test('question timer is visible', async ({ page }) => {
    await page.goto(`${STUDENT_BASE}/${STUDENT_ID}/${ASSESSMENT_ID}`);

    await page.getByRole('button', { name: /continue without recording/i }).click();
    await page.getByRole('button', { name: /start assessment/i }).click();

    // Timer should be displayed (300 seconds = 5:00)
    await expect(page.locator('[role="timer"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('5:00')).toBeVisible();
  });

  test('progress tracker shows current question number', async ({ page }) => {
    await page.goto(`${STUDENT_BASE}/${STUDENT_ID}/${ASSESSMENT_ID}`);

    await page.getByRole('button', { name: /continue without recording/i }).click();
    await page.getByRole('button', { name: /start assessment/i }).click();

    // "Question 1 of 2" appears in both header and body — scope to the header
    await expect(page.getByRole('banner').getByText('Question 1 of 2')).toBeVisible({ timeout: 10_000 });
  });
});

// ─── Student: End-of-assessment edge cases ───────────────────────────

test.describe('Student end-of-assessment edge cases', () => {
  test.beforeEach(async ({ page }) => {
    await setupStudentMockApi(page, { studentId: STUDENT_ID, assessmentId: ASSESSMENT_ID });
    await injectStudentSession(page);
  });

  // Reaching the end with gaps is only possible in review mode: the strict flow
  // submits answers in order and won't advance past an unanswered question, so
  // there is no way to arrive at the last question with Q1 blank.
  test('submitting is blocked while questions are unanswered (review mode)', async ({ page }) => {
    // Override questions to return 2 questions but only 1 answered
    await page.route(
      `**/api/student/${STUDENT_ID}/assessment/${ASSESSMENT_ID}/questions`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            questions: [
              { id: 'q-1', text: 'Q1', questionNumber: 1, questionType: 'specific', timeLimit: 300, topic: 'T', difficulty: 'medium' },
              { id: 'q-2', text: 'Q2', questionNumber: 2, questionType: 'general', timeLimit: 300, topic: 'T', difficulty: 'medium' },
            ],
            currentQuestionIndex: 1,
            answerMode: 'written',
            // Behaviour flags must be repeated in every questions override — the
            // store treats a missing `proctored` on a written assessment as
            // un-proctored. allowReview renders the free-navigation footer whose
            // Submit Assessment button gates on allAnswered.
            proctored: true,
            allowReview: true,
            preparationTime: 0,
            assessmentTitle: 'E2E Test Assessment',
            assessmentCourse: 'COMP9021',
            assessmentDescription: '',
          }),
        });
      }
    );
    // Progress shows only 1 of 2 answered — but Q2 (last) shown and answered
    await page.route(
      `**/api/student/${STUDENT_ID}/assessment/${ASSESSMENT_ID}/progress`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ answeredQuestions: 1, totalQuestions: 2, status: 'in_progress' }),
        });
      }
    );

    await page.goto(`${STUDENT_BASE}/${STUDENT_ID}/${ASSESSMENT_ID}`);

    // This student is resuming an in-progress attempt, so TakeAssessment restores
    // straight to Q2 — no consent modal, no overview. Re-prompting a student
    // mid-exam would be the bug, so don't click through those gates here.
    await expect(page.getByRole('banner').getByText('Question 2 of 2')).toBeVisible({ timeout: 10_000 });

    // With 1 of 2 answered the control is present but refuses to open the
    // confirmation modal, and says why on hover.
    const submitAssessment = page.getByRole('button', { name: /submit assessment/i });
    await expect(submitAssessment).toBeVisible({ timeout: 10_000 });
    await expect(submitAssessment).toBeDisabled();
    await expect(submitAssessment).toHaveAttribute(
      'title',
      'Answer every question before submitting'
    );

    // No modal — the gate holds.
    await expect(page.getByText('Submit Assessment?')).toBeHidden();
  });

  test('results page shows evaluating spinner and auto-polls', async ({ page }) => {
    // Override progress to submitted
    await page.route(
      `**/api/student/${STUDENT_ID}/assessment/${ASSESSMENT_ID}/progress`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ answeredQuestions: 2, totalQuestions: 2, status: 'submitted' }),
        });
      }
    );

    let resultsCalled = 0;
    // First call: 202 pending; second call: results ready
    await page.route(
      `**/api/student/${STUDENT_ID}/assessment/${ASSESSMENT_ID}/results`,
      async (route) => {
        resultsCalled++;
        if (resultsCalled < 2) {
          await route.fulfill({
            status: 202,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'Results not available yet' }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              studentId: STUDENT_ID,
              assessmentId: ASSESSMENT_ID,
              totalScore: 14,
              maxScore: 20,
              percentage: 70,
              grade: 'Competent',
              submittedAt: '2026-04-05T10:00:00Z',
              completedAt: '2026-04-05T10:00:00Z',
              questions: [],
            }),
          });
        }
      }
    );

    await page.goto(`${STUDENT_BASE}/${STUDENT_ID}/results/${ASSESSMENT_ID}`);

    // First: evaluating spinner
    await expect(page.getByText('Evaluating Your Assessment')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/this page will update automatically/i)).toBeVisible();

    // After auto-poll fires (~8s), results load
    await expect(page.getByText('Assessment Results')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('70%')).toBeVisible();
  });

  test('submit failure keeps modal open with error message', async ({ page }) => {
    // Override submit to fail
    await page.route(`**/api/student/${STUDENT_ID}/submit`, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Internal server error' }),
      });
    });

    await page.goto(`${STUDENT_BASE}/${STUDENT_ID}/${ASSESSMENT_ID}`);
    await page.getByRole('button', { name: /continue without recording/i }).click();
    await page.getByRole('button', { name: /start assessment/i }).click();

    // Answer Q1
    await expect(page.getByPlaceholder('Type your answer here...')).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('Type your answer here...').fill(
      'I used a recursive approach with dynamic programming and memoization to achieve optimal performance.'
    );
    await page.getByRole('button', { name: /submit answer/i }).click();

    // Answer Q2
    await expect(page.getByRole('banner').getByText('Question 2 of 2')).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('Type your answer here...').fill(
      'The time complexity is O(n log n) for the merge sort approach with O(n) space.'
    );
    await page.getByRole('button', { name: /submit answer/i }).click();

    await expect(page.getByRole('button', { name: /submit assessment/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /submit assessment/i }).click();

    await expect(page.getByText('Submit Assessment?')).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /^submit$/i }).click();

    // Modal should STAY open with error — not navigate away
    await expect(page.getByText('Submit Assessment?')).toBeVisible({ timeout: 5_000 });
    // first() — the failure surfaces both in the modal and in the page-level
    // error banner, so the bare locator is a strict-mode violation.
    await expect(page.getByText(/submission failed|server error|internal/i).first()).toBeVisible({ timeout: 5_000 });

    // Still on TakeAssessment page, not results
    await expect(page).not.toHaveURL(/results/, { timeout: 2_000 });
  });

  test('results page shows not-released message without retry button', async ({ page }) => {
    await page.route(
      `**/api/student/${STUDENT_ID}/assessment/${ASSESSMENT_ID}/progress`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ answeredQuestions: 2, totalQuestions: 2, status: 'submitted' }),
        });
      }
    );
    await page.route(
      `**/api/student/${STUDENT_ID}/assessment/${ASSESSMENT_ID}/results`,
      async (route) => {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Results not released yet' }),
        });
      }
    );

    await page.goto(`${STUDENT_BASE}/${STUDENT_ID}/results/${ASSESSMENT_ID}`);

    await expect(page.getByText('Results Pending Release')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/this page will update automatically/i)).toBeVisible();
    // No manual retry button — polling handles it
    await expect(page.getByRole('button', { name: /retry/i })).not.toBeVisible();
  });

  test('not-submitted student is redirected back to assessment', async ({ page }) => {
    await page.route(
      `**/api/student/${STUDENT_ID}/assessment/${ASSESSMENT_ID}/progress`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ answeredQuestions: 1, totalQuestions: 2, status: 'in_progress' }),
        });
      }
    );

    await page.goto(`${STUDENT_BASE}/${STUDENT_ID}/results/${ASSESSMENT_ID}`);

    await expect(page.getByText('Assessment Not Submitted')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /return to assessment/i })).toBeVisible();
  });
});

// ─── Student: Landing page ──────────────────────────────────────────

test.describe('Student landing page', () => {
  test('shows platform heading and link input', async ({ page }) => {
    await page.goto(STUDENT_BASE);

    await expect(page.getByText('Oral Assessment Platform')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder(/paste your assessment link/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /go/i })).toBeVisible();
  });
});
