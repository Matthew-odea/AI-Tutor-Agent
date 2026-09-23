import React from "react";
import logo9021 from "../../assets/logo-concepts/chat9021_logo_concept_b_light.svg";
import type { AppMode } from "../../types";

interface SidebarHeaderProps {
  setAppMode: (mode: AppMode | null) => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export const SidebarHeader: React.FC<SidebarHeaderProps> = ({
  setAppMode,
  isCollapsed = false,
  onToggleCollapse,
}) => (
  <div
    className={`border-b border-gray-800 ${isCollapsed ? "py-4 px-0" : "py-2 pl-1 pr-3"}`}
  >
    <div
      className={`flex items-center gap-2 w-full ${
        isCollapsed ? "justify-center" : "justify-between"
      }`}
    >
      <div
        className={`flex items-center gap-2 min-w-0 ${
          isCollapsed ? "opacity-0 pointer-events-none w-0 flex-none" : "flex-1"
        }`}
      >
        <div className="flex-1 min-w-0">
          <button
            onClick={() => setAppMode(null)}
            className="w-full h-12 rounded-lg flex items-center justify-start hover:bg-gray-800 transition-colors px-1"
            title="Home"
            aria-label="Go to home"
          >
            <img
              src={logo9021}
              alt="Chat9021"
              className="h-10 w-auto object-contain"
            />
          </button>
        </div>
      </div>
      {onToggleCollapse && (
        <button
          onClick={onToggleCollapse}
          className={`transition-colors ${
            isCollapsed
              ? "mx-auto w-8 h-8 flex items-center justify-center p-0 rounded-full hover:bg-gray-800/70 active:bg-gray-700/70"
              : "p-2 hover:bg-gray-800 rounded-lg"
          }`}
          title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {isCollapsed ? (
            <svg
              className="w-5 h-5 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          ) : (
            <svg
              className="w-5 h-5 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          )}
        </button>
      )}
    </div>
  </div>
);
