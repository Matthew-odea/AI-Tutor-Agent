interface CodeEditorControlsProps {
  onRunCode: () => void;
  onAskAI: () => void;
  onShowHistory: () => void;
  isExecuting: boolean;
  isLoading: boolean;
  hasHistory: boolean;
  showAskAI?: boolean;
  showRunHistory?: boolean;
}

export const CodeEditorControls = ({
  onRunCode,
  onAskAI,
  onShowHistory,
  isExecuting,
  isLoading,
  hasHistory,
  showAskAI = true,
  showRunHistory = true,
}: CodeEditorControlsProps) => {
  if (!showRunHistory && !showAskAI) {
    return null;
  }

  return (
    <div className="px-4 py-2.5 bg-[#2D2D2D] flex items-center justify-between">
      <div className="flex items-center space-x-2">
        {showRunHistory && (
          <button
            onClick={onRunCode}
            disabled={isLoading || isExecuting}
            className="flex items-center space-x-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-semibold"
          >
            {isLoading || isExecuting ? (
              <>
                <svg
                  className="animate-spin h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <span>Running...</span>
              </>
            ) : (
              <>
                <svg
                  className="w-3.5 h-3.5"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span>Run</span>
              </>
            )}
          </button>
        )}

        {showAskAI && (
          <button
            onClick={onAskAI}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-gray-700 text-gray-100 rounded-lg hover:bg-gray-600 transition-colors text-sm font-medium"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
            </svg>
            <span>Ask AI</span>
          </button>
        )}
        {showRunHistory && (
          <button
            onClick={onShowHistory}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-gray-700 text-gray-100 rounded-lg hover:bg-gray-600 transition-colors text-sm font-medium"
            disabled={!hasHistory}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>History</span>
          </button>
        )}
      </div>
    </div>
  );
};
