import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { trackPageView } from "../utils/analytics";

export const AnalyticsWrapper = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const location = useLocation();

  useEffect(() => {
    trackPageView({
      path: location.pathname,
      title: document.title,
    });
  }, [location]);

  return <>{children}</>;
};
