interface CodeEditorOutputProps {
  output: string | null;
  error: string | null;
}

export const CodeEditorOutput = ({ output, error }: CodeEditorOutputProps) => {
  if (!output && !error) {
    return null;
  }

  return (
    <div className="border-t border-gray-700">
      <div className="px-4 py-2 bg-[#2D2D2D] border-b border-gray-700">
        <h4 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
          {error ? "Error" : "Output"}
        </h4>
      </div>
      <div
        className={`px-4 py-3 font-mono text-sm ${
          error ? "bg-red-900/20 text-red-300" : "bg-[#1e1e1e] text-gray-300"
        }`}
      >
        <pre className="whitespace-pre-wrap break-words">{error || output}</pre>
      </div>
    </div>
  );
};
