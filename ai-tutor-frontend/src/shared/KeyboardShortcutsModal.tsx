import { getShortcutDisplay } from "../hooks/useKeyboardShortcuts";

interface ShortcutsModalProps {
  onClose: () => void;
}

export const KeyboardShortcutsModal = ({ onClose }: ShortcutsModalProps) => {
  const shortcuts = [
    { keys: { key: "k", ctrl: true }, description: "Start new chat" },
    { keys: { key: "b", ctrl: true }, description: "Toggle sidebar" },
    { keys: { key: "e", ctrl: true }, description: "Toggle code editor" },
    { keys: { key: "Enter", ctrl: true }, description: "Run code (in editor)" },
    { keys: { key: "/", ctrl: true }, description: "Show keyboard shortcuts" },
    { keys: { key: "Escape" }, description: "Close modal/dropdown" },
  ];

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">
              Keyboard Shortcuts
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors p-1"
              aria-label="Close"
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
        </div>

        <div className="px-6 py-4 max-h-96 overflow-y-auto">
          <div className="space-y-3">
            {shortcuts.map((shortcut, index) => (
              <div
                key={index}
                className="flex items-center justify-between py-2"
              >
                <span className="text-sm text-gray-700">
                  {shortcut.description}
                </span>
                <kbd className="px-2 py-1 bg-gray-100 border border-gray-300 rounded text-xs font-mono text-gray-700">
                  {getShortcutDisplay(shortcut.keys)}
                </kbd>
              </div>
            ))}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
          <p className="text-xs text-gray-500 text-center">
            Press{" "}
            <kbd className="px-1.5 py-0.5 bg-white border border-gray-300 rounded text-xs font-mono">
              Esc
            </kbd>{" "}
            to close
          </p>
        </div>
      </div>
    </div>
  );
};
