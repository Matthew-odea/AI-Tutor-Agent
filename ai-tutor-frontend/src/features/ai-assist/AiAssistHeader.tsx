import { useState, useRef, useEffect } from "react";
import type { AssistantThreadResponse } from "../../api/history";

interface AiAssistHeaderProps {
  threads: AssistantThreadResponse[];
  threadId: string | null;
  isLoadingThreads: boolean;
  onNewChat: () => void;
  onSelectThread: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
}

export const AiAssistHeader = ({
  threads,
  threadId,
  isLoadingThreads,
  onNewChat,
  onSelectThread,
  onDeleteThread,
}: AiAssistHeaderProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const activeThread = threads.find((t) => t.thread_id === threadId);
  const activeLabel = activeThread?.title || "Select thread";

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
      <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
        AI Assistant
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={onNewChat}
          className="px-2 py-1 text-[11px] font-semibold text-primary-700 bg-primary-50 border border-primary-100 rounded-md hover:bg-primary-100 transition-colors"
        >
          New
        </button>
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setIsOpen(!isOpen)}
            disabled={isLoadingThreads || threads.length === 0}
            className="h-6 min-w-[140px] text-[11px] font-semibold text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-2 text-left truncate flex items-center justify-between gap-1 hover:bg-gray-100 transition-colors disabled:opacity-50"
            aria-label="Assistant threads"
          >
            <span className="truncate">
              {isLoadingThreads
                ? "Loading..."
                : threads.length === 0
                  ? "No threads"
                  : activeLabel}
            </span>
            <svg
              className={`w-3 h-3 flex-shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          {isOpen && threads.length > 0 && (
            <div className="absolute right-0 top-full mt-1 w-56 max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg z-50">
              {threads.map((thread) => (
                <div
                  key={thread.thread_id}
                  className={`flex items-center justify-between group px-2 py-1.5 text-[11px] hover:bg-gray-50 cursor-pointer ${
                    thread.thread_id === threadId
                      ? "bg-primary-50 text-primary-700 font-semibold"
                      : "text-gray-700"
                  }`}
                >
                  <button
                    className="flex-1 text-left truncate"
                    onClick={() => {
                      onSelectThread(thread.thread_id);
                      setIsOpen(false);
                    }}
                  >
                    {thread.title || "Assistant Thread"}
                  </button>
                  {onDeleteThread && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteThread(thread.thread_id);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-red-50 hover:text-red-600 rounded transition-all flex-shrink-0 ml-1"
                      title="Delete thread"
                    >
                      <svg
                        className="w-3 h-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
