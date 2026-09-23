import { create } from 'zustand';
import type {
  Assessment,
  Student,
  StudentProgress,
  AssessmentResults,
  QuestionGenerationJob,
} from '../../../shared/types/assessment';

interface AssessmentStore {
  // State
  assessments: Assessment[];
  selectedAssessment: Assessment | null;
  students: Student[];
  progress: StudentProgress[];
  results: AssessmentResults[];
  generationJob: QuestionGenerationJob | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  setAssessments: (assessments: Assessment[]) => void;
  addAssessment: (assessment: Assessment) => void;
  setSelectedAssessment: (assessment: Assessment | null) => void;
  setStudents: (students: Student[]) => void;
  addStudents: (students: Student[]) => void;
  setProgress: (progress: StudentProgress[]) => void;
  setResults: (results: AssessmentResults[]) => void;
  setGenerationJob: (job: QuestionGenerationJob | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useAssessmentStore = create<AssessmentStore>((set) => ({
  // Initial state
  assessments: [],
  selectedAssessment: null,
  students: [],
  progress: [],
  results: [],
  generationJob: null,
  isLoading: false,
  error: null,

  // Actions
  setAssessments: (assessments) => set({ assessments }),
  
  addAssessment: (assessment) =>
    set((state) => ({ assessments: [...state.assessments, assessment] })),
  
  setSelectedAssessment: (assessment) => set({ selectedAssessment: assessment }),
  
  setStudents: (students) => set({ students }),
  
  addStudents: (newStudents) =>
    set((state) => ({ students: [...state.students, ...newStudents] })),
  
  setProgress: (progress) => set({ progress }),
  
  setResults: (results) => set({ results }),
  
  setGenerationJob: (job) => set({ generationJob: job }),
  
  setLoading: (loading) => set({ isLoading: loading }),
  
  setError: (error) => set({ error }),
  
  reset: () =>
    set({
      assessments: [],
      selectedAssessment: null,
      students: [],
      progress: [],
      results: [],
      generationJob: null,
      isLoading: false,
      error: null,
    }),
}));
