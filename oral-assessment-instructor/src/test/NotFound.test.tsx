import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

import NotFound from '../pages/NotFound';

describe('NotFound page', () => {
  it('renders 404 heading', () => {
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>
    );
    expect(screen.getByText('404')).toBeInTheDocument();
    expect(screen.getByText('Page Not Found')).toBeInTheDocument();
    // The page title is the h1; the big "404" numeral is display type, not a heading.
    expect(screen.getByRole('heading', { level: 1, name: 'Page Not Found' })).toBeInTheDocument();
  });

  it('navigates to /assessments when button clicked', async () => {
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>
    );
    const button = screen.getByRole('button', { name: /go to dashboard/i });
    await userEvent.click(button);
    expect(mockNavigate).toHaveBeenCalledWith('/assessments');
  });
});
