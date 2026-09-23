interface TextAnswerInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  isSubmitting?: boolean;
  disabled?: boolean;
  minLength?: number;
}

const MIN_CHARS = 20;

export default function TextAnswerInput({
  value,
  onChange,
  onSubmit,
  isSubmitting = false,
  disabled = false,
  minLength = MIN_CHARS,
}: TextAnswerInputProps) {
  const canSubmit = value.trim().length >= minLength && !isSubmitting && !disabled;

  return (
    <div className="bg-paper rounded-xl border border-hairline p-6">
      <h3 className="text-lg font-semibold font-serif text-ink mb-4">Write Your Answer</h3>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || isSubmitting}
        rows={8}
        placeholder="Type your answer here..."
        className="w-full border border-hairline bg-paper rounded-xl p-3 text-sm text-ink placeholder-slate
                   focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent
                   disabled:bg-ink/5 disabled:cursor-not-allowed resize-y"
      />

      <div className="flex items-center justify-between mt-2 mb-4">
        <span className={`text-xs tabular-nums ${value.trim().length < minLength ? 'text-slate' : 'text-success'}`}>
          {value.trim().length} / {minLength} characters minimum
        </span>
        {value.trim().length > 0 && value.trim().length < minLength && (
          <span className="text-xs tabular-nums text-caution">
            {minLength - value.trim().length} more characters needed
          </span>
        )}
      </div>

      <button
        onClick={onSubmit}
        disabled={!canSubmit}
        className="w-full flex items-center justify-center space-x-2 bg-accent text-white px-6 py-3
                   rounded-xl hover:bg-accent-hover disabled:bg-ink/20 disabled:cursor-not-allowed
                   transition-colors font-medium"
      >
        {isSubmitting ? (
          <>
            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            <span>Submitting...</span>
          </>
        ) : (
          <>
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                clipRule="evenodd" />
            </svg>
            <span>Submit Answer</span>
          </>
        )}
      </button>

    </div>
  );
}
