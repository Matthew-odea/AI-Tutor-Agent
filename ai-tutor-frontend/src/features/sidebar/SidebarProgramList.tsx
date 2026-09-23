import React from "react";
import { SessionSkeletonList } from "../chat/SessionSkeleton";
import { formatRelativeTime } from "../../utils/formatTime";
import type { CodeProgram } from "../../types";

interface SidebarProgramListProps {
  programs: CodeProgram[];
  isLoadingPrograms: boolean;
  activeProgramId: string | null;
  loadingProgramId: string | null;
  handleLoadProgram: (programId: string) => void;
  handleDeleteProgramClick: (
    programId: string,
    title: string,
    e: React.SyntheticEvent<HTMLElement>,
  ) => void;
}

export const SidebarProgramList: React.FC<SidebarProgramListProps> = ({
  programs,
  isLoadingPrograms,
  activeProgramId,
  loadingProgramId,
  handleLoadProgram,
  handleDeleteProgramClick,
}) => {
  if (isLoadingPrograms) {
    return <SessionSkeletonList count={5} />;
  }
  if (programs.length === 0) {
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
            d="M9 12h6m-6 4h6m2 4H7a2 2 0 01-2-2V6a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z"
          />
        </svg>
        <p className="text-sm text-gray-500">No programs yet</p>
        <p className="text-xs text-gray-600 mt-1">
          Create a program to get started
        </p>
      </div>
    );
  }
  return (
    <div>
      {programs.map((program) => {
        const isActive = activeProgramId === program.program_id;
        const isLoading = loadingProgramId === program.program_id;
        return (
          <button
            key={program.program_id}
            onClick={() => handleLoadProgram(program.program_id)}
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
                  <span
                    className="flex-shrink-0 w-4 h-4 rounded bg-blue-600/20 text-blue-400 text-[8px] font-bold flex items-center justify-center uppercase"
                    title={program.language || "python"}
                  >
                    {(program.language || "py").slice(0, 2)}
                  </span>
                  <p className="text-xs font-medium truncate">
                    {program.title}
                  </p>
                  {isLoading && (
                    <div className="animate-spin h-2.5 w-2.5 border border-primary-500 border-t-transparent rounded-full" />
                  )}
                </div>
                <p className="text-[10px] text-gray-500 mt-0.5">
                  {formatRelativeTime(program.last_accessed)}
                </p>
              </div>
              <div
                onClick={(e) =>
                  handleDeleteProgramClick(program.program_id, program.title, e)
                }
                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-700 rounded transition-opacity flex-shrink-0 cursor-pointer"
                title="Delete program"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleDeleteProgramClick(
                      program.program_id,
                      program.title,
                      e,
                    );
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
