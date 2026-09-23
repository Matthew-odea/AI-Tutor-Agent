import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import LoadingSpinner from '../components/LoadingSpinner';
import HelpButton from '../components/HelpButton';
import type { Schemas } from '../types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

// No contact props: there is no per-assessment data before the token exchange.
function InviteHelp() {
  return (
    <div className="absolute top-4 right-4">
      <HelpButton />
    </div>
  );
}

export default function InviteLanding() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  // ?next=results: results can't be deep-linked because they need the session token only
  // this exchange sets; without it a submitted student lands back in the question UI.
  const resultsMode = searchParams.get('next') === 'results';
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!token) {
    return (
      <div className="relative min-h-screen bg-paper flex items-center justify-center p-4">
        <InviteHelp />
        <div className="max-w-md w-full text-center">
          <svg className="mx-auto h-12 w-12 text-danger mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <h2 className="font-serif text-lg font-semibold text-ink mb-2">Invalid Invite Link</h2>
          <p className="text-sm text-slate">No invite token found. Please check your link.</p>
        </div>
      </div>
    );
  }

  const handleStart = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await axios.post<Schemas['StudentInviteExchangeResponse']>(
        `${API_BASE_URL}/api/auth/student/exchange`,
        { invite_token: token } satisfies Schemas['StudentInviteExchangeRequest']
      );
      const { access_token, student_id, assessment_id } = resp.data;

      // localStorage, not sessionStorage: a refresh or a new tab must not end the
      // student's session mid-exam. The invite token is kept so the session can be
      // renewed from the same link while the assessment is open.
      localStorage.setItem('studentToken', access_token);
      localStorage.setItem('authToken', access_token);
      localStorage.setItem('studentId', student_id);
      localStorage.setItem('assessmentId', assessment_id);
      localStorage.setItem('inviteToken', token);

      navigate(
        resultsMode
          ? `/${student_id}/results/${assessment_id}`
          : `/${student_id}/${assessment_id}`,
        { replace: true },
      );
    } catch (err) {
      if (axios.isAxiosError(err) && (err.response?.status === 400 || err.response?.status === 401)) {
        const detail = err.response?.data?.error?.message || err.response?.data?.detail || '';
        if (detail.toLowerCase().includes('expired')) {
          setError('This invite link has expired. Please contact your instructor for a new link.');
        } else if (detail.toLowerCase().includes('closed')) {
          setError('This assessment has closed. Please contact your instructor.');
        } else {
          setError('This invite link is invalid or has expired. Please contact your instructor for a new link.');
        }
      } else {
        setError('Failed to verify your invite link. Please try again or contact your instructor.');
      }
    } finally {
      setLoading(false);
    }
  };

  if (error) {
    return (
      <div className="relative min-h-screen bg-paper flex items-center justify-center p-4">
        <InviteHelp />
        <div className="max-w-md w-full text-center">
          <svg className="mx-auto h-12 w-12 text-danger mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <h2 className="font-serif text-lg font-semibold text-ink mb-2">Invalid Invite Link</h2>
          <p className="text-sm text-slate">{error}</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center">
        <LoadingSpinner size="lg" message="Verifying your invite..." />
      </div>
    );
  }

  if (resultsMode) {
    return (
      <div className="relative min-h-screen bg-paper flex items-center justify-center p-4">
        <InviteHelp />
        <div className="max-w-lg w-full text-center">
          <svg className="mx-auto h-12 w-12 text-accent mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <h2 className="font-serif text-lg font-semibold text-ink mb-1">Your Feedback</h2>
          <p className="text-sm text-slate mb-6">
            Open your feedback for this assessment. Your answers have already been submitted — nothing
            here changes them.
          </p>
          <button
            onClick={handleStart}
            className="w-full inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-xl text-white bg-accent hover:bg-accent-hover transition-colors duration-200 ease-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent"
          >
            View My Feedback
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-paper flex items-center justify-center p-4">
      <InviteHelp />
      <div className="max-w-lg w-full">
        <div className="text-center">
          <svg className="mx-auto h-12 w-12 text-accent mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <h2 className="font-serif text-lg font-semibold text-ink mb-1">Assessment Invitation</h2>
          <p className="text-sm text-slate mb-6">Before you begin, here's what to expect.</p>
        </div>

        {/* Format-agnostic on purpose: nothing is known about the assessment until the
            single-use token is exchanged. Specifics come in PreAssessmentOverview. */}
        <div className="bg-paper border border-hairline rounded-xl p-5 mb-6 text-left">
          <h3 className="font-serif text-sm font-semibold text-ink mb-3">Before you begin</h3>
          <ul className="text-sm text-ink space-y-2.5">
            <li className="flex items-start space-x-2">
              <span className="text-accent mt-0.5" aria-hidden="true">•</span>
              <span>
                Use a <span className="font-medium">modern browser</span> (Chrome, Firefox, or Safari) on a
                stable internet connection.
              </span>
            </li>
            <li className="flex items-start space-x-2">
              <span className="text-accent mt-0.5" aria-hidden="true">•</span>
              <span>
                Set aside <span className="font-medium">uninterrupted time</span> so you can finish in one sitting.
              </span>
            </li>
            <li className="flex items-start space-x-2">
              <span className="text-accent mt-0.5" aria-hidden="true">•</span>
              <span>
                You'll see this assessment's <span className="font-medium">details and requirements</span> — its
                format, the number of questions, and any time limit — on the next screen before you start.
              </span>
            </li>
          </ul>

          <div className="mt-4 pt-4 border-t border-hairline">
            <p className="text-sm text-slate">
              <span className="font-medium text-ink">Keep your invite link.</span> You can safely refresh,
              close the tab or briefly lose connection — open the same link again to get straight back
              into your assessment, any time before it closes.
            </p>
          </div>
        </div>

        <button
          onClick={handleStart}
          className="w-full inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-xl text-white bg-accent hover:bg-accent-hover transition-colors duration-200 ease-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent"
        >
          Start Assessment
        </button>
      </div>
    </div>
  );
}
