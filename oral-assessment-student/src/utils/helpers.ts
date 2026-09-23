export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function formatTimestamp(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function calculatePercentage(value: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((value / total) * 100);
}

export function getGradeFromPercentage(percentage: number): string {
  if (percentage >= 90) return 'A';
  if (percentage >= 80) return 'B';
  if (percentage >= 70) return 'C';
  if (percentage >= 60) return 'D';
  return 'F';
}

export function getGradeColor(grade: string): string {
  switch (grade) {
    case 'A':
      return 'text-success bg-success/10';
    case 'B':
      return 'text-accent bg-accent/10';
    case 'C':
      return 'text-caution bg-caution/10';
    case 'D':
      return 'text-caution bg-caution/10';
    case 'F':
      return 'text-danger bg-danger/10';
    default:
      return 'text-slate bg-ink/5';
  }
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'not-started':
      return 'bg-ink/5 text-slate';
    case 'in-progress':
      return 'bg-accent/10 text-accent';
    case 'submitted':
      return 'bg-success/10 text-success';
    case 'evaluated':
      return 'bg-caution/10 text-caution';
    default:
      return 'bg-ink/5 text-slate';
  }
}

export function validateStudentId(studentId: string): boolean {
  return studentId.length > 0 && studentId.length <= 50;
}

export function validateAssessmentId(assessmentId: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(assessmentId);
}

// Persists a recording decline so a refresh doesn't re-arm the camera.
export function declinedConsentKey(assessmentId: string): string {
  return `declined_consent_${assessmentId}`;
}

export function hasDeclinedConsent(assessmentId: string | null | undefined): boolean {
  if (!assessmentId) return false;
  return sessionStorage.getItem(declinedConsentKey(assessmentId)) === 'true';
}

export function parseUrlParams(pathname: string): { studentId: string; assessmentId: string } | null {
  const parts = pathname.split('/').filter(Boolean);
  
  if (parts.length >= 2) {
    return {
      studentId: parts[0],
      assessmentId: parts[1],
    };
  }
  
  return null;
}

export function checkBrowserSupport(): {
  supported: boolean;
  missing: string[];
} {
  const missing: string[] = [];

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    missing.push('MediaDevices API');
  }

  if (!window.MediaRecorder) {
    missing.push('MediaRecorder API');
  }

  if (!window.AudioContext && !(window as Window & { webkitAudioContext?: unknown }).webkitAudioContext) {
    missing.push('AudioContext API');
  }

  return {
    supported: missing.length === 0,
    missing,
  };
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

export function capitalize(text: string): string {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function getBandGradeColor(grade: string): string {
  switch (grade) {
    case 'Excellent': return 'text-success bg-success/10';
    case 'Competent': return 'text-accent bg-accent/10';
    case 'Developing': return 'text-caution bg-caution/10';
    case 'Unsatisfactory': return 'text-danger bg-danger/10';
    default: return 'text-slate bg-ink/5';
  }
}

export function getDifficultyColor(difficulty: string): string {
  switch (difficulty.toLowerCase()) {
    case 'easy':
      return 'bg-success/10 text-success';
    case 'medium':
      return 'bg-caution/10 text-caution';
    case 'hard':
      return 'bg-danger/10 text-danger';
    default:
      return 'bg-ink/5 text-slate';
  }
}

export default {
  formatDuration,
  formatDate,
  formatTimestamp,
  calculatePercentage,
  getGradeFromPercentage,
  getGradeColor,
  getBandGradeColor,
  getStatusColor,
  validateStudentId,
  validateAssessmentId,
  parseUrlParams,
  checkBrowserSupport,
  truncate,
  capitalize,
  getDifficultyColor,
};
