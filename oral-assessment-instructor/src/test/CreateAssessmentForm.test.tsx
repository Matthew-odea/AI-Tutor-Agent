import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const createAssessment = vi.fn();
vi.mock('../services/api', () => ({ apiService: { createAssessment: (...a: unknown[]) => createAssessment(...a) } }));

import CreateAssessmentForm from '../components/CreateAssessmentForm';

describe('CreateAssessmentForm times', () => {
  // The instructor's browser is in Sydney; the server reads a bare time as UTC.
  beforeAll(() => {
    process.env.TZ = 'Australia/Sydney';
  });

  it('sends window and due times as the UTC instant the instructor meant', async () => {
    createAssessment.mockResolvedValue({ id: 'a1', title: 'Quiz' });
    render(
      <MemoryRouter>
        <CreateAssessmentForm />
      </MemoryRouter>
    );
    const set = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { name: id, value } });
    set('title', 'Quiz');
    set('course', 'COMP9021');
    set('dueDate', '2099-10-01T17:00');
    fireEvent.click(screen.getByText('Scheduled window'));
    set('scheduledWindowStart', '2099-10-01T09:00');
    set('scheduledWindowEnd', '2099-10-01T11:00');
    fireEvent.submit(document.querySelector('form')!);

    await vi.waitFor(() => expect(createAssessment).toHaveBeenCalled());
    const sent = createAssessment.mock.calls[0][0];
    // 9am on 1 Oct in Sydney (AEST, +10) is 11pm on 30 Sep UTC — not 9am UTC.
    expect(sent.scheduledWindowStart).toBe('2099-09-30T23:00:00.000Z');
    expect(sent.scheduledWindowEnd).toBe('2099-10-01T01:00:00.000Z');
    expect(sent.dueDate).toBe('2099-10-01T07:00:00.000Z');
  });
});
