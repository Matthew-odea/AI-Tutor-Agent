/**
 * Delete confirmation modal for session deletion
 */
import { useEffect } from "react";

interface DeleteConfirmModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  sessionTitle?: string;
  entityLabel?: string;
}

export const DeleteConfirmModal = ({
  isOpen,
  onConfirm,
  onCancel,
  sessionTitle,
  entityLabel = "Session",
}: DeleteConfirmModalProps) => {
  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onCancel();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-800 rounded-xl p-6 max-w-sm w-full shadow-2xl border border-gray-700">
        {/* Icon */}
        <div className="w-12 h-12 rounded-full bg-red-900/30 flex items-center justify-center mx-auto mb-4">
          <svg
            className="w-6 h-6 text-red-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </div>

        {/* Title */}
        <h3 className="text-lg font-semibold text-white text-center mb-2">
          Delete {entityLabel}?
        </h3>

        {/* Message */}
        <p className="text-sm text-gray-400 text-center mb-6">
          {sessionTitle ? (
            <>
              <span className="text-gray-300 font-medium">
                "{sessionTitle}"
              </span>{" "}
              will be permanently deleted.
            </>
          ) : (
            `This ${entityLabel.toLowerCase()} will be permanently deleted.`
          )}{" "}
          This action cannot be undone.
        </p>

        {/* Buttons */}
        <div className="flex space-x-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors font-medium text-sm"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors font-medium text-sm"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};
