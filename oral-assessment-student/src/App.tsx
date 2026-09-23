import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import TakeAssessment from './pages/TakeAssessment';
import ViewResults from './pages/ViewResults';
import InviteLanding from './pages/InviteLanding';
import { ToastContainer } from './components/ToastContainer';
import OfflineBanner from './components/OfflineBanner';
import './index.css';

function DefaultRoute() {
  const navigate = useNavigate();
  const [linkInput, setLinkInput] = useState('');

  const handleGo = () => {
    try {
      const url = new URL(linkInput.trim());
      navigate(url.pathname);
    } catch {
      // Not a full URL: treat as a pathname.
      navigate(linkInput.trim());
    }
  };

  return (
    <div className="min-h-screen bg-paper flex items-center justify-center p-4">
      <div className="bg-paper rounded-xl border border-hairline p-10 max-w-md w-full text-center">
        <h1 className="font-serif text-2xl font-bold text-ink mb-3">Oral Assessment Platform</h1>
        <p className="text-ink mb-2">
          This platform is used to take oral assessments set by your instructor.
        </p>
        <p className="text-sm text-slate mb-2">
          If you have an assessment link, open it in your browser or paste it below.
        </p>
        <p className="text-xs text-slate mb-8 font-mono bg-ink/5 rounded-xl px-3 py-2 text-left">
          Your link will look like:<br />
          <span className="text-ink">https://…/s12345/a1b2c3d4-…</span>
        </p>
        <div className="flex space-x-2">
          <input
            type="text"
            value={linkInput}
            onChange={(e) => setLinkInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleGo()}
            placeholder="Paste your assessment link…"
            className="flex-1 border border-hairline rounded-xl px-3 py-2 text-sm bg-paper text-ink focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            onClick={handleGo}
            disabled={!linkInput.trim()}
            className="bg-accent text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-accent-hover disabled:opacity-40 transition-colors duration-200 ease-out"
          >
            Go
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <OfflineBanner />
      <ToastContainer />
      <Routes>
        <Route path="/invite" element={<InviteLanding />} />

        <Route path="/:studentId/:assessmentId" element={<TakeAssessment />} />

        <Route path="/:studentId/results/:assessmentId" element={<ViewResults />} />

        <Route path="*" element={<DefaultRoute />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
