import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import "./index.css";
import { ErrorBoundary } from "./shared/ErrorBoundary.tsx";
import { initErrorTracking } from "./utils/errorTracking";
import { initAnalytics } from "./utils/analytics";
import { initPerformanceTracking } from "./utils/performance";
import { AnalyticsWrapper } from "./shared/AnalyticsWrapper";
import { PageLoader } from "./shared/PageLoader";

initErrorTracking();
initAnalytics();
initPerformanceTracking();

const App = lazy(() => import("./App.tsx"));
const PrivacyPolicy = lazy(() => import("./pages/PrivacyPolicy.tsx"));
const TermsOfService = lazy(() => import("./pages/TermsOfService.tsx"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HelmetProvider>
      <ErrorBoundary>
        <BrowserRouter>
          <AnalyticsWrapper>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/" element={<App />} />
                <Route path="/privacypolicy" element={<PrivacyPolicy />} />
                <Route path="/termsofservice" element={<TermsOfService />} />
              </Routes>
            </Suspense>
          </AnalyticsWrapper>
        </BrowserRouter>
      </ErrorBoundary>
    </HelmetProvider>
  </StrictMode>,
);
