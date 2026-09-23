import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import axios from 'axios';
import ErrorMessage from '../components/ErrorMessage';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

const INPUT_CLASS =
  'w-full px-4 py-2 bg-ink/5 border border-hairline rounded-xl text-ink placeholder-slate focus:border-accent focus:ring-2 focus:ring-accent focus:outline-none';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: Location })?.from?.pathname ?? '/assessments';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const response = await axios.post<{ access_token: string }>(
        `${API_BASE_URL}/api/auth/login`,
        { email, password }
      );
      localStorage.setItem('authToken', response.data.access_token);
      navigate(from, { replace: true });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        setError('Invalid email or password.');
      } else {
        setError('Unable to sign in. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // A 401 isn't per-field, so both fields point at the form-level error.
  const errorId = error ? 'login-error' : undefined;

  return (
    <div className="min-h-screen bg-paper flex items-center justify-center p-4">
      <div className="bg-paper border border-hairline rounded-xl p-8 w-full max-w-md">
        <img src="/c9-logo.svg" alt="" aria-hidden="true" className="w-10 h-10 mx-auto mb-4" />
        <h1 className="font-serif text-2xl font-semibold text-ink mb-2 text-center">
          Instructor Sign In
        </h1>
        <p className="text-slate text-sm mb-6 text-center">Oral Assessment Platform</p>

        {error && (
          <div id={errorId} role="alert" className="mb-4">
            <ErrorMessage error={error} onDismiss={() => setError(null)} />
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              aria-invalid={error ? true : undefined}
              aria-describedby={errorId}
              className={INPUT_CLASS}
              placeholder="you@university.edu"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              aria-invalid={error ? true : undefined}
              aria-describedby={errorId}
              className={INPUT_CLASS}
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            aria-busy={isLoading}
            className="w-full bg-accent hover:bg-accent-hover text-white py-2.5 rounded-xl font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
        <div className="mt-4 text-center">
          <Link
            to="/forgot-password"
            className="text-accent hover:text-accent-hover text-sm font-medium"
          >
            Forgot password?
          </Link>
        </div>
      </div>
    </div>
  );
}
