import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import { useChatStore } from "../../store/chatStore";
import { AiAssistPanel } from "../ai-assist";

type CodeEditorProps = {
  onSendMessage: (message: string) => void;
  showAskAI?: boolean;
};

const CodeEditor = lazy(() =>
  import("./CodeEditor").then((module) => ({ default: module.CodeEditor })),
) as LazyExoticComponent<ComponentType<CodeEditorProps>>;

export const IdeWorkspace = () => {
  const { setEditorOpen, setEditorMinimized, setLayoutMode } = useChatStore();
  const [panelWidth, setPanelWidth] = useState(360);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(360);

  useEffect(() => {
    setEditorOpen(true);
    setEditorMinimized(false);
    setLayoutMode("split");
  }, [setEditorOpen, setEditorMinimized, setLayoutMode]);

  useEffect(() => {
    if (!isResizing) return;

    let rafId = 0;
    const handleMouseMove = (event: MouseEvent) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const delta = resizeStartX.current - event.clientX;
        const nextWidth = Math.min(
          Math.max(resizeStartWidth.current + delta, 280),
          520,
        );
        setPanelWidth(nextWidth);
      });
    };

    const handleMouseUp = () => {
      cancelAnimationFrame(rafId);
      setIsResizing(false);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      cancelAnimationFrame(rafId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  const handleResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    setIsResizing(true);
    resizeStartX.current = event.clientX;
    resizeStartWidth.current = panelWidth;
  };

  return (
    <div className="flex h-full bg-white">
      <div className="w-px bg-gray-100/80" aria-hidden="true" />
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-hidden">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full bg-white">
                <div className="flex flex-col items-center space-y-2">
                  <svg
                    className="animate-spin h-6 w-6 text-gray-400"
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
                  <div className="text-gray-500 text-xs">Loading editor...</div>
                </div>
              </div>
            }
          >
            <CodeEditor onSendMessage={() => {}} showAskAI={false} />
          </Suspense>
        </div>
      </div>
      <div
        onMouseDown={handleResizeStart}
        className="w-px cursor-col-resize bg-gray-100/80 hover:bg-gray-200"
        aria-hidden="true"
      />
      <div style={{ width: panelWidth }} className="flex-shrink-0">
        <AiAssistPanel />
      </div>
    </div>
  );
};
