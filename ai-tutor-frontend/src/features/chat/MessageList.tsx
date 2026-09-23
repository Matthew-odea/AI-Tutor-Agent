import {
  useEffect,
  useRef,
  lazy,
  Suspense,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import { MessageBubble } from "./MessageBubble";
import { MessageSkeleton } from "../../shared/Skeletons";
import { useChatStore } from "../../store/chatStore";
import type { Message } from "../../types";

const CodeEditor = lazy(() =>
  import("../code-editor").then((module) => ({ default: module.CodeEditor })),
) as LazyExoticComponent<
  ComponentType<{ onSendMessage: (message: string) => void }>
>;

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
  onSendMessage: (message: string) => void;
  hideSplitEditor?: boolean;
}

export const MessageList = ({
  messages,
  isLoading,
  onSendMessage,
  hideSplitEditor = false,
}: MessageListProps) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const prevIsLoadingRef = useRef(isLoading);
  const prevMessageCountRef = useRef(messages.length);
  const { codeEditor, setEditorMinimized, appMode } = useChatStore();

  // New assistant replies scroll to their top (so long answers start in view); everything else scrolls to the bottom.
  useEffect(() => {
    const messageCountIncreased = messages.length > prevMessageCountRef.current;

    if (messageCountIncreased && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];

      if (lastMessage.role === "assistant") {
        setTimeout(() => {
          lastMessageRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }, 100);
      } else {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    } else if (
      codeEditor.isOpen ||
      codeEditor.lastOutput ||
      codeEditor.lastError
    ) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }

    prevMessageCountRef.current = messages.length;
  }, [
    messages,
    codeEditor.isOpen,
    codeEditor.lastOutput,
    codeEditor.lastError,
  ]);

  // Minimise the inline editor once a reply lands so the response is visible.
  useEffect(() => {
    const aiJustResponded =
      prevIsLoadingRef.current === true && isLoading === false;

    if (aiJustResponded && codeEditor.isOpen && !codeEditor.isMinimized) {
      setTimeout(() => setEditorMinimized(true), 500);
    }

    prevIsLoadingRef.current = isLoading;
  }, [
    isLoading,
    codeEditor.isOpen,
    codeEditor.isMinimized,
    setEditorMinimized,
  ]);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <div className="w-full max-w-4xl animate-fade-in space-y-6">
          <div className="text-center mb-6">
            <div className="mb-6 flex justify-center">
              <div className="relative">
                <div className="bg-gradient-to-br from-primary-500 to-primary-600 w-20 h-20 rounded-3xl flex items-center justify-center shadow-2xl">
                  <span className="text-white text-4xl font-bold">C9</span>
                </div>
                <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-green-500 rounded-full border-2 border-white"></div>
              </div>
            </div>

            <h2 className="text-3xl font-bold text-gray-900 mb-2">
              Which python concepts would you like to explore?
            </h2>
          </div>

          <div className="bg-gradient-to-br from-primary-50 to-primary-100 rounded-2xl p-6 border border-primary-200">
            <p className="text-sm font-semibold text-gray-900 mb-3 flex items-center">
              Try one of these:
            </p>
            <div className="space-y-2">
              {[
                "Help me learn week 4 content",
                "How do I print text in Python?",
                "What's the difference between = and ==?",
                "How do I get user input in my program?",
              ].map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => onSendMessage(prompt)}
                  className="w-full bg-white rounded-lg px-4 py-3 text-sm text-gray-700 shadow-sm hover:shadow-md transition-all text-left hover:bg-gray-50"
                >
                  "{prompt}"
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-6 md:px-8 pt-8 pb-[20vh] bg-white">
      <div className="max-w-5xl mx-auto">
        {messages.map((message, index) => {
          const isLastMessage = index === messages.length - 1;
          return (
            <div
              key={`${message.timestamp}-${index}`}
              ref={isLastMessage ? lastMessageRef : null}
            >
              <MessageBubble message={message} />
            </div>
          );
        })}

        {/* Inline editor; hidden in split view (rendered alongside) and in general chat mode */}
        {!hideSplitEditor && appMode !== "chat" && (
          <Suspense fallback={<MessageSkeleton />}>
            <CodeEditor onSendMessage={onSendMessage} />
          </Suspense>
        )}

        {isLoading && (
          <div className="flex justify-start mb-6 animate-fade-in">
            <div className="flex space-x-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-primary-600 flex items-center justify-center shadow-md animate-pulse">
                <span className="text-white text-sm font-semibold">C9</span>
              </div>
              <div className="bg-white rounded-2xl px-5 py-4 shadow-message border border-gray-200">
                <div className="flex items-center space-x-3">
                  <div className="relative w-5 h-5">
                    <div className="absolute inset-0 border-2 border-gray-200 rounded-full"></div>
                    <div className="absolute inset-0 border-2 border-primary-500 rounded-full border-t-transparent animate-spin"></div>
                  </div>
                  <span className="text-sm text-gray-600">Thinking...</span>
                </div>
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
};
