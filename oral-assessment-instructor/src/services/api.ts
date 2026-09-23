import axios from 'axios';
import type { AxiosInstance } from 'axios';
import type { components } from '../../../shared/types/api';
import type {
  Assessment,
  Student,
  CreateAssessmentRequest,
  UploadedStudent,
  StudentProgress,
  AssessmentResults,
  AssessmentReport,
} from '../../../shared/types/assessment';

type Schemas = components['schemas'];

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

/** The subset of EventSource the progress stream's consumer uses. */
export interface ProgressStream {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close: () => void;
}

class ApiService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add request interceptor for auth token if needed
    this.client.interceptors.request.use((config) => {
      const token = localStorage.getItem('authToken');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        console.error('API Error:', error.response?.data || error.message);
        if (error.response?.status === 401) {
          localStorage.removeItem('authToken');
          window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    );
  }

  // Assessment endpoints
  async createAssessment(data: CreateAssessmentRequest): Promise<Assessment> {
    const response = await this.client.post<Assessment>('/api/assessment/create', data);
    return response.data;
  }

  async getAssessment(assessmentId: string): Promise<Assessment> {
    const response = await this.client.get<Assessment>(`/api/assessment/${assessmentId}`);
    return response.data;
  }

  async listAssessments(): Promise<Assessment[]> {
    const response = await this.client.get<Schemas['AssessmentListResponse']>('/api/assessment/list');
    return response.data.assessments || [];
  }

  async deleteAssessment(assessmentId: string): Promise<void> {
    await this.client.delete(`/api/assessment/${assessmentId}`);
  }

  // Student upload endpoints
  async uploadStudents(assessmentId: string, students: UploadedStudent[]): Promise<void> {
    await this.client.post(`/api/assessment/${assessmentId}/upload-students`, {
      students,
    } satisfies Schemas['UploadStudentsRequest']);
  }

  // Ed import
  async importFromEd(assessmentId: string, edToken: string, challengeId: number): Promise<Schemas['ImportFromEdResponse']> {
    const response = await this.client.post<Schemas['ImportFromEdResponse']>(`/api/assessment/${assessmentId}/import-ed`, {
      edToken,
      challengeId,
    } satisfies Schemas['ImportFromEdRequest']);
    return response.data;
  }

  // Question generation endpoints
  async generateQuestions(
    assessmentId: string,
    studentIds?: string[]
  ): Promise<Schemas['QuestionGenerationJobResponse']> {
    const response = await this.client.post<Schemas['QuestionGenerationJobResponse']>(
      `/api/assessment/${assessmentId}/generate-questions-batch`,
      { studentIds } satisfies Schemas['GenerateQuestionsBatchRequest']
    );
    return response.data;
  }

  async getQuestionGenerationStatus(
    assessmentId: string,
    jobId: string
  ): Promise<Schemas['QuestionGenerationStatusResponse']> {
    const response = await this.client.get<Schemas['QuestionGenerationStatusResponse']>(
      `/api/assessment/${assessmentId}/generation-status/${jobId}`
    );
    return response.data;
  }

  // S3 upload endpoints
  // Evaluation endpoints
  async evaluateAssessment(
    assessmentId: string,
    studentIds?: string[]
  ): Promise<Schemas['EvaluationJobResponse']> {
    const response = await this.client.post<Schemas['EvaluationJobResponse']>(
      `/api/assessment/${assessmentId}/evaluate-batch`,
      { studentIds } satisfies Schemas['EvaluateBatchRequest']
    );
    return response.data;
  }

  async getAssessmentResults(assessmentId: string): Promise<AssessmentResults[]> {
    const response = await this.client.get<Schemas['ResultsSummaryResponse']>(
      `/api/assessment/${assessmentId}/results`
    );
    return response.data.results || [];
  }

  /** Latest cohort report, or null if none has been generated yet. */
  async getAssessmentReport(assessmentId: string): Promise<AssessmentReport | null> {
    const response = await this.client.get<Schemas['AssessmentReportResponse']>(
      `/api/assessment/${assessmentId}/report`
    );
    return response.data.generated ? (response.data.report ?? null) : null;
  }

  /** Regenerate the cohort report now, without waiting for the next submission milestone. */
  async generateAssessmentReport(assessmentId: string): Promise<AssessmentReport> {
    const response = await this.client.post<Schemas['GenerateReportResponse']>(
      `/api/assessment/${assessmentId}/report/generate`
    );
    return response.data.report;
  }

  /**
   * Fetch the one-page report as a blob. Both endpoints need the auth header, so
   * they go through the axios client rather than a plain <a href> the browser
   * would request unauthenticated.
   */
  async downloadAssessmentReport(assessmentId: string, format: 'pdf' | 'html'): Promise<Blob> {
    const response = await this.client.get(`/api/assessment/${assessmentId}/report.${format}`, {
      responseType: 'blob',
    });
    return response.data as Blob;
  }

  // Progress monitoring endpoints
  async getAssessmentProgress(assessmentId: string): Promise<StudentProgress[]> {
    const response = await this.client.get<Schemas['ProgressSummaryResponse']>(
      `/api/assessment/${assessmentId}/progress`
    );
    return response.data.students || [];
  }

  async getAssessmentStudents(assessmentId: string): Promise<Student[]> {
    const response = await this.client.get<Schemas['StudentListResponse']>(
      `/api/assessment/${assessmentId}/students`
    );
    return response.data.students || [];
  }

  // Sprint 8: Results Dashboards

  async getStudentDetail(
    assessmentId: string,
    studentId: string
  ): Promise<Schemas['InstructorStudentDetailResponse']> {
    const response = await this.client.get<Schemas['InstructorStudentDetailResponse']>(
      `/api/assessment/${assessmentId}/student/${studentId}/results`
    );
    return response.data;
  }

  async overrideScore(
    assessmentId: string,
    studentId: string,
    questionId: string,
    score: number,
    comment?: string
  ): Promise<Schemas['ScoreOverrideResponse']> {
    const response = await this.client.put<Schemas['ScoreOverrideResponse']>(
      `/api/assessment/${assessmentId}/student/${studentId}/question/${questionId}/override`,
      { score, comment } satisfies Schemas['ScoreOverrideRequest']
    );
    return response.data;
  }

  async releaseResults(assessmentId: string): Promise<Schemas['ReleaseResultsResponse']> {
    const response = await this.client.put<Schemas['ReleaseResultsResponse']>(
      `/api/assessment/${assessmentId}/release-results`
    );
    return response.data;
  }

  // Dual-scoring validity harness: record a human reference score for a question.
  async recordHumanScore(
    assessmentId: string,
    studentId: string,
    questionId: string,
    humanCorrectnessScore: number,
    humanUnderstandingScore: number,
    scoredBy?: string,
  ): Promise<Schemas['RecordHumanScoreResponse']> {
    const response = await this.client.put<Schemas['RecordHumanScoreResponse']>(
      `/api/assessment/${assessmentId}/student/${studentId}/question/${questionId}/human-score`,
      { humanCorrectnessScore, humanUnderstandingScore, scoredBy } satisfies Schemas['RecordHumanScoreRequest']
    );
    return response.data;
  }

  // AI-vs-human agreement summary across all dual-scored items.
  async getScoreAgreement(assessmentId: string): Promise<Schemas['ScoreAgreementResponse']> {
    const response = await this.client.get<Schemas['ScoreAgreementResponse']>(
      `/api/assessment/${assessmentId}/score-agreement`
    );
    return response.data;
  }

  // Evaluations flagged for human review (needs-review / fallback / score divergence).
  async getFlaggedEvaluations(assessmentId: string): Promise<Schemas['FlaggedEvaluationsResponse']> {
    const response = await this.client.get<Schemas['FlaggedEvaluationsResponse']>(
      `/api/assessment/${assessmentId}/flagged-evaluations`
    );
    return response.data;
  }

  async sendInvites(assessmentId: string, options?: Schemas['SendInvitesRequest']): Promise<Schemas['SendInvitesResponse']> {
    const response = await this.client.post<Schemas['SendInvitesResponse']>(
      `/api/assessment/${assessmentId}/send-invites`,
      options || {}
    );
    return response.data;
  }

  // Resend a single student's invite — mints a fresh single-use link (new token,
  // new 7-day expiry) and emails it. For students whose link expired or was used.
  async resendInvite(
    assessmentId: string,
    studentId: string,
    options?: Schemas['StudentInviteRequest']
  ): Promise<Schemas['StudentInviteResponse']> {
    const response = await this.client.post<Schemas['StudentInviteResponse']>(
      `/api/assessment/${assessmentId}/students/${studentId}/invite`,
      options || {}
    );
    return response.data;
  }

  async sendReminder(assessmentId: string, studentId: string): Promise<Schemas['SendReminderResponse']> {
    const response = await this.client.post<Schemas['SendReminderResponse']>(
      `/api/assessment/${assessmentId}/student/${studentId}/remind`
    );
    return response.data;
  }

  // EventSource cannot send headers, and the backend reads the token only from the
  // Authorization header, so the old `?token=` URL was always 401 (and put the JWT in
  // access logs). This reads the same `data: ...` frames with fetch, behind the
  // EventSource shape StudentProgressTable already uses.
  openStudentEvaluationProgressStream(assessmentId: string, studentId: string): ProgressStream {
    const controller = new AbortController();
    const stream: ProgressStream = { onmessage: null, onerror: null, close: () => controller.abort() };
    const token = localStorage.getItem('authToken');
    fetch(`${API_BASE_URL}/api/assessment/${assessmentId}/students/${studentId}/evaluation-progress`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`Progress stream failed: ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const data = buffer.slice(0, end).split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            buffer = buffer.slice(end + 2);
            if (data) stream.onmessage?.({ data });
          }
        }
        // The server ending the stream is an error to an EventSource consumer too.
        if (!controller.signal.aborted) stream.onerror?.();
      })
      .catch(() => {
        if (!controller.signal.aborted) stream.onerror?.();
      });
    return stream;
  }

  // EPIC-3-3: Question preview and editing
  async listStudentQuestions(
    assessmentId: string,
    studentId: string
  ): Promise<Schemas['StudentQuestionListResponse']> {
    const response = await this.client.get<Schemas['StudentQuestionListResponse']>(
      `/api/assessment/${assessmentId}/students/${studentId}/questions`
    );
    return response.data;
  }

  async updateStudentQuestion(
    assessmentId: string,
    studentId: string,
    questionId: string,
    text: string,
    timeLimit?: number | null
  ): Promise<Schemas['StudentQuestionResponse']> {
    const response = await this.client.put<Schemas['StudentQuestionResponse']>(
      `/api/assessment/${assessmentId}/students/${studentId}/questions/${questionId}`,
      { text, timeLimit } satisfies Schemas['UpdateStudentQuestionRequest']
    );
    return response.data;
  }

  async deleteStudentQuestion(
    assessmentId: string,
    studentId: string,
    questionId: string
  ): Promise<Schemas['DeleteStudentQuestionResponse']> {
    const response = await this.client.delete<Schemas['DeleteStudentQuestionResponse']>(
      `/api/assessment/${assessmentId}/students/${studentId}/questions/${questionId}`
    );
    return response.data;
  }

  async addStudentQuestion(
    assessmentId: string,
    studentId: string,
    data: Schemas['AddStudentQuestionRequest']
  ): Promise<Schemas['StudentQuestionResponse']> {
    const response = await this.client.post<Schemas['StudentQuestionResponse']>(
      `/api/assessment/${assessmentId}/students/${studentId}/questions`,
      data
    );
    return response.data;
  }

  async updateBrief(assessmentId: string, brief: string): Promise<void> {
    await this.client.put(`/api/assessment/${assessmentId}/brief`, {
      brief,
    } satisfies Schemas['UpdateBriefRequest']);
  }

  async listUsers(): Promise<Schemas['UserRecord'][]> {
    const response = await this.client.get<Schemas['UserListResponse']>('/api/auth/users');
    return response.data.users || [];
  }

  async setUserRoles(email: string, roles: string[]): Promise<void> {
    await this.client.put(`/api/auth/users/${encodeURIComponent(email)}/roles`, {
      roles,
    } satisfies Schemas['SetUserRolesRequest']);
  }
}

export const apiService = new ApiService();
