import { useState, type ReactNode } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useChatStore } from "../../store/chatStore";

interface CodeBlockProps {
  children: ReactNode;
  language?: string;
  className?: string;
}

export const CodeBlock = ({
  children,
  language,
  className,
}: CodeBlockProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const { insertCodeIntoEditor, appMode, setAppMode } = useChatStore();

  const match = /language-(\w+)/.exec(className || "");
  const lang = language || match?.[1] || "python";

  const code = (
    Array.isArray(children) ? children.join("") : String(children ?? "")
  ).replace(/\n$/, "");
  const lineCount = code.split("\n").length;

  if (lineCount === 1) {
    return (
      <pre className="bg-gray-100 text-gray-800 px-3 py-2 rounded-lg text-sm font-mono my-2 border border-gray-200 overflow-x-auto">
        <code>{code}</code>
      </pre>
    );
  }

  const isLong = lineCount > 10;

  // Blocks over 10 lines collapse to their first 8.
  const displayCode =
    isLong && !isExpanded ? code.split("\n").slice(0, 8).join("\n") : code;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const canInsert =
    code.trim().length > 10 && (lang === "python" || lang === "py");

  return (
    <div className="relative group my-3 rounded-lg overflow-hidden bg-[#1E1E1E] shadow-lg">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#2D2D2D] border-b border-gray-700">
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
          {lang}
        </span>
        <div className="flex items-center space-x-1">
          {canInsert && (
            <button
              onClick={() => {
                insertCodeIntoEditor(code);
                if (appMode !== "ide") {
                  setAppMode("ide");
                }
              }}
              className="flex items-center space-x-1 px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
              title="Open in code editor"
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
                  d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                />
              </svg>
              <span>Open in Editor</span>
            </button>
          )}
          <button
            onClick={handleCopy}
            className="flex items-center space-x-1 px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
            title="Copy code"
          >
            {isCopied ? (
              <>
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
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span>Copied!</span>
              </>
            ) : (
              <>
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
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      <div className="relative">
        <SyntaxHighlighter
          language={lang}
          style={vscDarkPlus}
          customStyle={{
            margin: 0,
            padding: "12px 16px",
            fontSize: "0.8125rem",
            lineHeight: "1.5",
            background: "#1E1E1E",
          }}
          showLineNumbers={lineCount > 5}
          lineNumberStyle={{
            minWidth: "2.5em",
            paddingRight: "1em",
            color: "#858585",
            userSelect: "none",
          }}
        >
          {displayCode}
        </SyntaxHighlighter>

        {isLong && !isExpanded && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[#1E1E1E] to-transparent pointer-events-none" />
        )}
      </div>

      {isLong && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-white hover:bg-[#2D2D2D] border-t border-gray-700 transition-colors flex items-center justify-center space-x-1"
        >
          <span>
            {isExpanded ? "Show less" : `Show all ${lineCount} lines`}
          </span>
          <svg
            className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`}
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
      )}
    </div>
  );
};
