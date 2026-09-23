import React from "react";
import chatIcon from "../../assets/person.png";
import ideIcon from "../../assets/code.png";
import questionIcon from "../../assets/exam.png";

interface SidebarModeSwitcherProps {
  appMode: "chat" | "ide" | "questions" | null;
  handleModeChange: (mode: "chat" | "ide" | "questions") => void;
  createNewChatSession: () => void;
  createNewFile: () => void;
  compact?: boolean;
}

export const SidebarModeSwitcher: React.FC<SidebarModeSwitcherProps> = ({
  appMode,
  handleModeChange,
  createNewChatSession,
  createNewFile,
  compact = false,
}) => (
  <div
    className={`border-b border-gray-800 ${
      compact
        ? "w-full py-3 flex flex-col items-center gap-3"
        : "px-3 py-3 space-y-2"
    }`}
  >
    <button
      onClick={() => handleModeChange("chat")}
      title="General Chat"
      className={
        compact
          ? `w-10 h-10 mx-auto flex items-center justify-center rounded-md transition-colors border ${
              appMode === "chat"
                ? "bg-gray-800 text-white border-gray-700"
                : "text-gray-400 hover:bg-gray-800 hover:text-white border-transparent"
            }`
          : `w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors border ${
              appMode === "chat"
                ? "bg-gray-800 text-white border-gray-700"
                : "text-gray-400 hover:bg-gray-800 hover:text-white border-transparent"
            }`
      }
    >
      <div
        className={
          compact
            ? "flex items-center justify-center"
            : "flex items-center gap-2"
        }
      >
        <img src={chatIcon} alt="General Chat" className="w-4 h-4" />
        {!compact && <span>General Chat</span>}
      </div>
    </button>
    {appMode === "chat" && (
      <button
        onClick={createNewChatSession}
        className={
          compact
            ? "w-10 h-10 mx-auto flex items-center justify-center rounded-md transition-colors border border-dashed border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-white"
            : "w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors border border-dashed border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-white mt-1 mb-2 flex items-center gap-2"
        }
        title="Start a new chat"
        aria-label="Start a new chat"
      >
        <svg
          className={compact ? "w-4 h-4" : "w-4 h-4"}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 4v16m8-8H4"
          />
        </svg>
        {!compact && <span>New Chat</span>}
      </button>
    )}
    <button
      onClick={() => handleModeChange("ide")}
      title="Code with AI"
      className={
        compact
          ? `w-10 h-10 mx-auto flex items-center justify-center rounded-md transition-colors border ${
              appMode === "ide"
                ? "bg-gray-800 text-white border-gray-700"
                : "text-gray-400 hover:bg-gray-800 hover:text-white border-transparent"
            }`
          : `w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors border ${
              appMode === "ide"
                ? "bg-gray-800 text-white border-gray-700"
                : "text-gray-400 hover:bg-gray-800 hover:text-white border-transparent"
            }`
      }
    >
      <div
        className={
          compact
            ? "flex items-center justify-center"
            : "flex items-center gap-2"
        }
      >
        <img src={ideIcon} alt="AI-First IDE" className="w-4 h-4" />
        {!compact && <span>Code with AI</span>}
      </div>
    </button>
    {appMode === "ide" && (
      <button
        onClick={createNewFile}
        className={
          compact
            ? "w-10 h-10 mx-auto flex items-center justify-center rounded-md transition-colors border border-dashed border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-white"
            : "w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors border border-dashed border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-white mt-1 mb-2 flex items-center gap-2"
        }
        title="Create a new file"
        aria-label="Create a new file"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 4v16m8-8H4"
          />
        </svg>
        {!compact && <span>New File</span>}
      </button>
    )}
    <button
      onClick={() => handleModeChange("questions")}
      title="Question Gen"
      className={
        compact
          ? `w-10 h-10 mx-auto flex items-center justify-center rounded-md transition-colors border ${
              appMode === "questions"
                ? "bg-gray-800 text-white border-gray-700"
                : "text-gray-400 hover:bg-gray-800 hover:text-white border-transparent"
            }`
          : `w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors border ${
              appMode === "questions"
                ? "bg-gray-800 text-white border-gray-700"
                : "text-gray-400 hover:bg-gray-800 hover:text-white border-transparent"
            }`
      }
    >
      <div
        className={
          compact
            ? "flex items-center justify-center"
            : "flex items-center gap-2"
        }
      >
        <img
          src={questionIcon}
          alt="Question Generation"
          className="w-4 h-4 opacity-70"
        />
        {!compact && <span>Question Gen</span>}
      </div>
    </button>
  </div>
);
