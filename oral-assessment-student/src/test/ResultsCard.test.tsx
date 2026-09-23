import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import ResultsCard from '../components/ResultsCard';
import type { QuestionResult } from '../types';

afterEach(cleanup);

// Shape of a results row when skipCurrentQuestion fell back to a text marker: the backend
// stores the marker as the transcript and returns no status.
const skippedRow = (transcript: string): QuestionResult => ({
  questionId: 'q1',
  awaitingReview: false,
  questionNumber: 1,
  questionText: 'Explain recursion.',
  questionType: 'oral',
  audioUrl: '',
  transcript,
  correctnessScore: 0,
  understandingScore: 0,
  totalScore: 0,
  feedback: '',
});

describe('ResultsCard skip markers', () => {
  it.each(['[NO_ORAL_ANSWER]', '(time expired)'])('shows %s as Skipped, not as a transcript', (marker) => {
    render(<ResultsCard result={skippedRow(marker)} />);
    expect(screen.getByText('Skipped')).toBeTruthy();
    fireEvent.click(screen.getByText('Explain recursion.'));
    expect(screen.queryByText('Transcript')).toBeNull();
    expect(screen.queryByText(marker)).toBeNull();
  });

  it('still shows a real transcript', () => {
    render(<ResultsCard result={{ ...skippedRow('Recursion is a function calling itself.'), totalScore: 6 }} />);
    fireEvent.click(screen.getByText('Explain recursion.'));
    expect(screen.getByText('Transcript')).toBeTruthy();
  });
});
