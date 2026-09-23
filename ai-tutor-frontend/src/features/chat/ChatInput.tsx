import { useState, useRef, useEffect, type KeyboardEvent } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export const ChatInput = ({
  onSend,
  disabled = false,
  placeholder = "Ask me anything...",
}: ChatInputProps) => {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "40px";
      const newHeight = Math.min(textareaRef.current.scrollHeight, 300);
      textareaRef.current.style.height = `${newHeight}px`;
    }
  }, [input]);

  const handleSend = () => {
    if (!input.trim() || disabled) return;
    onSend(input);
    setInput("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-gray-200 bg-white px-6 py-2 pt-5 pb-5 relative">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-end space-x-2 h-[40px]">
          <div className="flex-1 relative flex flex-col justify-end">
            <div className="absolute bottom-full left-0 mb-0.5 px-1 pointer-events-none">
              {!disabled && !input ? (
                <p className="text-[10px] text-gray-400 leading-tight whitespace-nowrap">
                  <kbd className="px-1 py-0.5 bg-gray-100 rounded text-[9px] font-medium">
                    Enter
                  </kbd>{" "}
                  send •
                  <kbd className="px-1 py-0.5 bg-gray-100 rounded text-[9px] font-medium ml-0.5">
                    Shift+Enter
                  </kbd>{" "}
                  new line
                </p>
              ) : disabled ? (
                <div className="flex items-center space-x-1.5">
                  <div className="w-1 h-1 bg-primary-500 rounded-full animate-pulse" />
                  <span className="text-[10px] font-medium text-primary-600">
                    AI is thinking...
                  </span>
                </div>
              ) : null}
            </div>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              placeholder={placeholder}
              rows={1}
              aria-label="Message input"
              aria-multiline="true"
              className="w-full resize-none rounded-lg border border-gray-300 px-4 py-[7px] focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:bg-gray-50 disabled:cursor-not-allowed text-gray-600 placeholder-gray-400 leading-tight transition-colors scrollbar-hide"
              style={{
                minHeight: "40px",
                maxHeight: "300px",
                overflowY: "auto",
                height: "40px",
              }}
            />
          </div>
          <button
            onClick={handleSend}
            disabled={disabled || !input.trim()}
            className="rounded-lg bg-primary-600 px-6 py-[7px] font-semibold text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-300 disabled:cursor-not-allowed transition-all flex items-center justify-center space-x-1.5 flex-shrink-0 h-[40px]"
            aria-label="Send message"
          >
            <span>{disabled ? "Sending..." : "Send"}</span>
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M14 5l7 7m0 0l-7 7m7-7H3"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};
