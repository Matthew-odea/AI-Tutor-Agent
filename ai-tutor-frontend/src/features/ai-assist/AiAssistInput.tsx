import { useEffect, useRef, type KeyboardEvent } from "react";

interface AiAssistInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
}

export const AiAssistInput = ({
  value,
  onChange,
  onSend,
  disabled,
}: AiAssistInputProps) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "0px";
    const nextHeight = Math.min(textareaRef.current.scrollHeight, 160);
    textareaRef.current.style.height = `${Math.max(nextHeight, 44)}px`;
  }, [value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!disabled && value.trim()) {
        onSend();
      }
    }
  };

  return (
    <div className="border-t border-gray-200 px-3 py-2">
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask the AI about your code…"
          rows={1}
          className="w-full resize-none rounded-sm border border-gray-300 px-3 py-2 pr-10 text-sm text-gray-700 focus:border-primary-500/70 focus:outline-none focus:ring-1 focus:ring-primary-500/30 transition-none scrollbar-hide"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || !value.trim()}
          className="absolute bottom-2 right-2 h-6 w-6 text-primary-600 text-[12px] font-semibold flex items-center justify-center hover:text-primary-700 disabled:text-gray-300"
          aria-label="Send message"
          title="Send"
        >
          ➤
        </button>
      </div>
    </div>
  );
};
