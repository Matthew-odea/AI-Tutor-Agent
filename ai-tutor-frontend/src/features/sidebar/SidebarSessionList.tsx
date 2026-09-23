import React from "react";
import { SessionSkeletonList } from "../chat/SessionSkeleton";
import { formatRelativeTime } from "../../utils/formatTime";
import type { SessionInfo } from "../../types";

interface SidebarSessionListProps {
  sessions: SessionInfo[];
  isLoadingSessions: boolean;
  sessionId: string | null;
  loadingSessionId: string | null;
  handleLoadSession: (sid: string) => void;
  handleDeleteClick: (
    sid: string,
    title: string,
    e: React.SyntheticEvent<HTMLElement>,
  ) => void;
}

export const SidebarSessionList: React.FC<SidebarSessionListProps> = ({
  sessions,
  isLoadingSessions,
  sessionId,
  loadingSessionId,
  handleLoadSession,
  handleDeleteClick,
}) => {
  if (isLoadingSessions) {
    return <SessionSkeletonList count={5} />;
  }
  if (sessions.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        <svg
          className="w-12 h-12 mx-auto text-gray-600 mb-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
        <p className="text-sm text-gray-500">No previous sessions</p>
        <p className="text-xs text-gray-600 mt-1">Start a new chat to begin</p>
      </div>
    );
  }
  return (
    <div>
      {sessions.map((session) => {
        const isActive = sessionId === session.session_id;
        const isLoading = loadingSessionId === session.session_id;
        const sessionTitle = session.title?.trim() || "Untitled";
        return (
          <button
            key={session.session_id}
            onClick={() => handleLoadSession(session.session_id)}
            disabled={isLoading}
            className={`w-full text-left px-2.5 py-2 rounded-md transition-colors group relative ${
              isActive
                ? "bg-gray-800 text-white"
                : "text-gray-400 hover:bg-gray-800 hover:text-white"
            } ${isLoading ? "opacity-50 cursor-wait" : ""}`}
          >
            <div className="flex items-center justify-between gap-1">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-xs font-medium truncate">{sessionTitle}</p>
                  {isLoading && (
                    <div className="animate-spin h-2.5 w-2.5 border border-primary-500 border-t-transparent rounded-full" />
                  )}
                </div>
                <p className="text-[10px] text-gray-500 mt-0.5">
                  {formatRelativeTime(session.last_accessed)}
                </p>
              </div>
              <div
                onClick={(e) =>
                  handleDeleteClick(session.session_id, sessionTitle, e)
                }
                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-700 rounded transition-opacity flex-shrink-0 cursor-pointer"
                title="Delete session"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleDeleteClick(session.session_id, sessionTitle, e);
                  }
                }}
              >
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
};
