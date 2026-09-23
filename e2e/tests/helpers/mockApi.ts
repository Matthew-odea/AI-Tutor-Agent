/**
 * page.route() mocks for the frontends' Axios calls, returning deterministic
 * fixtures. Use setupStudentMockApi / setupInstructorMockApi.
 */

import { Page } from '@playwright/test';

export interface MockContext {
  studentId: string;
  assessmentId: string;
  /** Override individual fixture fields */
  overrides?: Record<string, unknown>;
}

// Use ** glob prefix to match any host — dev servers may point to localhost:8000
// or a remote EC2 IP depending on the local .env.local file.
// The glob matches the path portion regardless of which base URL is in use.
const G = '**/api';

/** Unsigned but structurally valid JWT with a future exp, so AuthGate accepts it. */
export function mockJwt(payload: Record<string, unknown> = {}): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(
    JSON.stringify({
      sub: 'mock-user',
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
      ...payload,
    })
  );
  const sig = btoa('mock-signature');
  return `${header}.${body}.${sig}`;
}

// ─── Student-side mocks ──────────────────────────────────────────────

/** Track call count so sequential-question mock can advance */
let questionFetchCount = 0;

export async function setupStudentMockApi(page: Page, ctx: MockContext): Promise<void> {
  const { studentId, assessmentId } = ctx;
  questionFetchCount = 0;

  // Student: exchange the invite token for a session token
  await page.route(`${G}/auth/student/exchange`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: mockJwt({ sub: studentId }),
        student_id: studentId,
        assessment_id: assessmentId,
      }),
    });
  });

  // Student: get assessment questions (written mode, sequential)
  // First call → index 0, after submit → index 1, etc.
  await page.route(
    `${G}/student/${studentId}/assessment/${assessmentId}/questions`,
    async (route) => {
      const idx = questionFetchCount;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          questions: [
            {
              id: 'q-1',
              text: 'Explain your implementation approach.',
              questionNumber: 1,
              questionType: 'specific',
              timeLimit: 300,
              topic: 'Design',
              difficulty: 'medium',
            },
            {
              id: 'q-2',
              text: 'What are the time complexity trade-offs?',
              questionNumber: 2,
              questionType: 'general',
              timeLimit: 300,
              topic: 'Analysis',
              difficulty: 'hard',
            },
          ],
          currentQuestionIndex: Math.min(idx, 1),
          answerMode: 'written',
          // Behaviour flags are per-assessment (instructor-configurable). The
          // store defaults `proctored` to (answerMode === 'oral') when omitted,
          // so a written assessment skips the consent modal entirely — set it
          // explicitly here because these tests exercise the consent flow.
          proctored: true,
          allowReview: false,
          preparationTime: 0,
          assessmentTitle: 'E2E Test Assessment',
          assessmentCourse: 'COMP9021',
          assessmentDescription: 'End-to-end test assessment.',
        }),
      });
    }
  );

  // Student: submit text/audio answer — also bumps the question index
  await page.route(`${G}/student/${studentId}/answer`, async (route) => {
    questionFetchCount++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  // Student: get progress
  await page.route(
    `${G}/student/${studentId}/assessment/${assessmentId}/progress`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          answeredQuestions: questionFetchCount,
          totalQuestions: 2,
          // ViewResults requires 'submitted' to show results (not 'completed')
          status: questionFetchCount >= 2 ? 'submitted' : 'in_progress',
        }),
      });
    }
  );

  // Student: submit assessment
  await page.route(`${G}/student/${studentId}/submit`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, status: 'submitted' }),
    });
  });

  // Student: get results (released)
  await page.route(
    `${G}/student/${studentId}/assessment/${assessmentId}/results`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          studentId,
          assessmentId,
          totalScore: 14,
          maxScore: 20,
          percentage: 70,
          grade: 'Competent',
          completedAt: new Date().toISOString(),
          questions: [
            {
              questionId: 'q-1',
              questionText: 'Explain your implementation approach.',
              aiScore: 7,
              effectiveScore: 7,
              maxScore: 10,
              feedback: 'Good explanation with clear structure.',
              strengths: 'Clear and concise.',
              improvements: 'Add more examples.',
            },
            {
              questionId: 'q-2',
              questionText: 'What are the time complexity trade-offs?',
              aiScore: 7,
              effectiveScore: 7,
              maxScore: 10,
              feedback: 'Correct analysis.',
              strengths: 'Accurate complexity analysis.',
              improvements: 'Discuss space complexity.',
            },
          ],
        }),
      });
    }
  );

  // Student: presigned URL (for audio uploads)
  await page.route(`${G}/s3/upload-url**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        url: 'https://s3.example.com/mock-upload',
        key: 'mock/key.webm',
      }),
    });
  });

  // Student: proctoring chunk
  await page.route(`${G}/student/${studentId}/proctoring-chunk`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
}

// ─── Instructor-side mocks ───────────────────────────────────────────

export async function setupInstructorMockApi(
  page: Page,
  ctx: MockContext
): Promise<void> {
  const { assessmentId } = ctx;

  // Auth: login
  await page.route(`${G}/auth/login`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: mockJwt({ sub: 'instructor-1', role: 'instructor' }) }),
    });
  });

  // Assessment: list
  await page.route(`${G}/assessment/list`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        assessments: [
          {
            id: assessmentId,
            title: 'Introduction to Algorithms',
            course: 'CS101',
            status: 'active',
            createdAt: new Date().toISOString(),
            totalStudents: 3,
            totalQuestions: 8,
            dueDate: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
          },
        ],
        total: 1,
      }),
    });
  });

  // Assessment: create
  await page.route(`${G}/assessment/create`, async (route) => {
    const body = JSON.parse((await route.request().postData()) || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'asmt-new-001',
        ...body,
        status: 'draft',
        createdAt: new Date().toISOString(),
      }),
    });
  });

  // Assessment: get single (glob pattern — regex doesn't match full URL in Playwright)
  await page.route(`${G}/assessment/*`, async (route) => {
    const url = route.request().url();
    const pathAfterAssessment = url.split('/api/assessment/')[1] || '';
    // Fallback for named resource paths (list, create) and sub-resource paths (/students, etc.)
    // so that the specific glob handlers registered before this one get a chance.
    const namedResources = ['list', 'create'];
    if (namedResources.includes(pathAfterAssessment) || pathAfterAssessment.includes('/')) {
      await route.fallback();
      return;
    }
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: assessmentId,
        title: 'Introduction to Algorithms',
        course: 'CS101',
        status: 'active',
        totalStudents: 3,
        totalQuestions: 8,
        dueDate: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        assignmentBrief: 'Students implement sorting algorithms.',
        resultsReleased: false,
      }),
    });
  });

  // Assessment: students list
  await page.route(new RegExp(`/api/assessment/[^/]+/students$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // StudentListResponse envelope — apiService reads response.data.students,
      // so a bare array silently yields [] and names degrade to raw IDs.
      body: JSON.stringify({
        ok: true,
        assessmentId,
        students: [
          { studentId: 'stu-001', name: 'Alice Johnson', email: 'alice@uni.edu' },
          { studentId: 'stu-002', name: 'Bob Smith', email: 'bob@uni.edu' },
          { studentId: 'stu-003', name: 'Charlie Brown', email: 'charlie@uni.edu' },
        ],
        total: 3,
      }),
    });
  });

  // Assessment: upload students
  await page.route(new RegExp(`/api/assessment/[^/]+/upload-students`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, count: 3 }),
    });
  });

  // Assessment: update brief
  await page.route(new RegExp(`/api/assessment/[^/]+/brief`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  // Assessment: generate questions (batch)
  await page.route(new RegExp(`/api/assessment/[^/]+/generate-questions-batch`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId: 'job-gen-001',
        status: 'running',
        assessmentId,
        totalStudents: 3,
        processedCount: 0,
      }),
    });
  });

  // Assessment: generation status
  await page.route(new RegExp(`/api/assessment/[^/]+/generation-status/`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId: 'job-gen-001',
        status: 'completed',
        assessmentId,
        totalStudents: 3,
        processedCount: 3,
      }),
    });
  });

  // Assessment: progress (monitoring)
  await page.route(new RegExp(`/api/assessment/[^/]+/progress$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Mirrors StudentProgressItem exactly: hyphenated status values, an
      // `answeredQuestions` count, and name/email embedded per row.
      body: JSON.stringify({
        ok: true,
        assessmentId,
        students: [
          {
            studentId: 'stu-001',
            name: 'Alice Johnson',
            email: 'alice@uni.edu',
            status: 'completed',
            answeredQuestions: 8,
            totalQuestions: 8,
            percentage: 100,
            startedAt: new Date().toISOString(),
            submittedAt: new Date().toISOString(),
          },
          {
            studentId: 'stu-002',
            name: 'Bob Smith',
            email: 'bob@uni.edu',
            status: 'in-progress',
            answeredQuestions: 4,
            totalQuestions: 8,
            percentage: 50,
            startedAt: new Date().toISOString(),
            submittedAt: null,
          },
          {
            studentId: 'stu-003',
            name: 'Charlie Brown',
            email: 'charlie@uni.edu',
            status: 'not-started',
            answeredQuestions: 0,
            totalQuestions: 8,
            percentage: 0,
            startedAt: null,
            submittedAt: null,
          },
        ],
        summary: { total: 3, 'not-started': 1, 'in-progress': 1, completed: 1 },
      }),
    });
  });

  // Assessment: dual-scoring panels on the results dashboard.
  // These MUST be mocked even though the component swallows their errors: an
  // unmocked request reaches the real backend, which answers 401 for the
  // unsigned mock JWT, and the axios interceptor turns any 401 into a hard
  // `window.location.href = '/login'` that navigates the page under test away.
  await page.route(new RegExp(`/api/assessment/[^/]+/score-agreement`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        assessmentId,
        dualScoredCount: 0,
        exactMatchRate: null,
        within1Rate: null,
        meanAbsoluteDifference: null,
        items: [],
      }),
    });
  });

  await page.route(new RegExp(`/api/assessment/[^/]+/flagged-evaluations`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, assessmentId, flaggedCount: 0, items: [] }),
    });
  });

  // Assessment: results
  await page.route(new RegExp(`/api/assessment/[^/]+/results$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        results: [
          {
            studentId: 'stu-001',
            name: 'Alice Johnson',        // ResultsDashboard uses result.name
            email: 'alice@uni.edu',
            totalScore: 16,
            maxScore: 20,
            percentage: 80,
            grade: 'Proficient',
            completedAt: new Date().toISOString(),
          },
          {
            studentId: 'stu-002',
            name: 'Bob Smith',
            email: 'bob@uni.edu',
            totalScore: 14,
            maxScore: 20,
            percentage: 70,
            grade: 'Competent',
            completedAt: new Date().toISOString(),
          },
        ],
      }),
    });
  });

  // Student detail results
  await page.route(new RegExp(`/api/assessment/[^/]+/student/[^/]+/results`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        studentId: 'stu-001',
        studentName: 'Alice Johnson',
        studentEmail: 'alice@uni.edu',
        totalScore: 16,
        maxScore: 20,
        percentage: 80,
        grade: 'Proficient',
        submittedAt: new Date().toISOString(),
        questions: [
          {
            questionId: 'q-1',
            questionText: 'Explain your implementation approach.',
            answerType: 'text',
            textContent: 'I used a recursive approach with memoization...',
            aiScore: 8,
            effectiveScore: 8,
            maxScore: 10,
            feedback: 'Excellent explanation.',
            strengths: 'Clear structure and good examples.',
            improvements: 'Could mention edge cases.',
          },
          {
            questionId: 'q-2',
            questionText: 'What are the time complexity trade-offs?',
            answerType: 'text',
            textContent: 'The time complexity is O(n log n) because...',
            aiScore: 8,
            effectiveScore: 8,
            maxScore: 10,
            feedback: 'Correct analysis.',
            strengths: 'Accurate.',
            improvements: 'Discuss space complexity.',
          },
        ],
        proctoring: { chunks: [], totalChunks: 0, missingIndexes: [] },
      }),
    });
  });

  // Score override
  await page.route(new RegExp(`/api/assessment/[^/]+/student/[^/]+/question/[^/]+/override`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  // Release results
  await page.route(new RegExp(`/api/assessment/[^/]+/release-results`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  // Evaluate batch
  await page.route(new RegExp(`/api/assessment/[^/]+/evaluate-batch`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId: 'job-eval-001',
        status: 'completed',
        assessmentId,
      }),
    });
  });

  // Student questions (for question editor)
  await page.route(new RegExp(`/api/assessment/[^/]+/students/[^/]+/questions`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        questions: [
          { id: 'q-1', text: 'Explain your implementation approach.', questionType: 'specific', difficulty: 'medium', topic: 'Design', timeLimit: 300 },
          { id: 'q-2', text: 'What are the time complexity trade-offs?', questionType: 'general', difficulty: 'hard', topic: 'Analysis', timeLimit: 300 },
        ],
      }),
    });
  });

  // Send invites (bulk)
  await page.route(new RegExp(`/api/assessment/[^/]+/send-invites`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, sent: 3, skipped: 0, total: 3 }),
    });
  });

  // Send reminder
  await page.route(new RegExp(`/api/assessment/[^/]+/student/[^/]+/remind`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
}

// Unused by current specs; kept as an alias for setupStudentMockApi.

export async function setupMockApi(page: Page, ctx: MockContext): Promise<void> {
  await setupStudentMockApi(page, ctx);
}
