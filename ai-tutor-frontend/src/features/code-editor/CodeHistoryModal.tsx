import type { CodeExecutionHistoryEntry } from "../../types";

interface CodeHistoryModalProps {
  history: CodeExecutionHistoryEntry[];
  onClose: () => void;
  onLoadEntry: (entry: CodeExecutionHistoryEntry) => void;
}

export const CodeHistoryModal = ({
  history,
  onClose,
  onLoadEntry,
}: CodeHistoryModalProps) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">
            Execution History
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded hover:bg-gray-100"
            aria-label="Close history"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {history.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <svg
                className="w-16 h-16 mx-auto mb-4 text-gray-300"
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
              <p>No execution history yet</p>
              <p className="text-sm mt-1">
                Run your code to see execution history here
              </p>
            </div>
          ) : (
            history.map((entry, index) => (
              <div
                key={entry.timestamp}
                className="border border-gray-200 rounded-lg overflow-hidden hover:border-blue-300 transition-colors cursor-pointer"
                onClick={() => {
                  onLoadEntry(entry);
                  onClose();
                }}
              >
                <div className="bg-gray-50 px-4 py-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">
                    Run #{history.length - index}
                  </span>
                  <span className="text-xs text-gray-500">
                    {new Date(entry.timestamp).toLocaleString()}
                  </span>
                </div>
                <div className="p-4">
                  <div className="bg-[#1e1e1e] rounded p-3 mb-2">
                    <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                      {entry.code}
                    </pre>
                  </div>
                  {entry.error ? (
                    <div className="bg-red-50 border border-red-200 rounded p-3">
                      <div className="text-xs font-semibold text-red-800 mb-1">
                        Error:
                      </div>
                      <pre className="text-xs text-red-700 font-mono whitespace-pre-wrap break-words">
                        {entry.error}
                      </pre>
                    </div>
                  ) : (
                    <div className="bg-green-50 border border-green-200 rounded p-3">
                      <div className="text-xs font-semibold text-green-800 mb-1">
                        Output:
                      </div>
                      <pre className="text-xs text-green-700 font-mono whitespace-pre-wrap break-words">
                        {entry.output || "(no output)"}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
