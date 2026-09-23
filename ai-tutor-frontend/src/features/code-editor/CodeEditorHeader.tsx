interface CodeEditorHeaderProps {
  onRunCode: () => void;
  isExecuting: boolean;
  isLoading: boolean;
}

export const CodeEditorHeader = ({
  onRunCode,
  isExecuting,
  isLoading,
}: CodeEditorHeaderProps) => {
  const isRunning = isLoading || isExecuting;

  return (
    <div className="relative z-20 pointer-events-auto flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Editor
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onRunCode}
          disabled={isRunning}
          className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          title="Run code"
        >
          {isRunning ? "Running…" : "Run"}
        </button>
      </div>
    </div>
  );
};
