import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { HTMLAttributes, ReactNode } from "react";
import type { Message } from "../../types";
import { CodeBlock } from "../code-editor";

interface MessageBubbleProps {
  message: Message;
  showAvatars?: boolean;
}

// Tidy model markdown outside fenced code blocks: collapse blank lines and keep inline code inline.
const normalizeInlineMarkdown = (text: string): string => {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\s*(\*\*`[^`\n]+`\*\*|`[^`\n]+`)\s*\n/g, " $1 ")
    .replace(/\n\s*(\*\*`[^`\n]+`\*\*|`[^`\n]+`)\s+(?=\S)/g, " $1 ")
    .replace(/`([^`\n]+)\n([^`]+)`/g, "`$1 $2`");
};

const cleanMarkdown = (text: string): string => {
  const segments = text.split(/(```[\s\S]*?```)/g);

  return segments
    .map((segment) =>
      segment.startsWith("```") ? segment : normalizeInlineMarkdown(segment),
    )
    .join("");
};

type CodeRendererProps = HTMLAttributes<HTMLElement> & {
  inline?: boolean;
  className?: string;
  children?: ReactNode;
};

type PreRendererProps = HTMLAttributes<HTMLPreElement> & {
  children?: ReactNode;
};

export const MessageBubble = ({
  message,
  showAvatars = true,
}: MessageBubbleProps) => {
  const isUser = message.role === "user";
  const isError = message.isError;
  const cleanedContent = !isUser
    ? cleanMarkdown(message.content)
    : message.content;

  return (
    <div
      className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4 message-enter`}
      role="article"
      aria-label={`${isUser ? "Your" : "AI"} message`}
    >
      <div
        className={`flex ${showAvatars ? "space-x-3" : "space-x-0"} ${isUser ? "max-w-2xl ml-auto" : "max-w-5xl w-full"}`}
      >
        {!isUser && showAvatars && (
          <div
            className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-primary-600 flex items-center justify-center shadow-md"
            aria-hidden="true"
          >
            <span className="text-white text-sm font-semibold">C9</span>
          </div>
        )}

        <div
          className={`rounded-2xl px-3 py-2.5 shadow-message transition-all duration-200 hover:shadow-message-hover ${
            isUser
              ? "bg-gray-100 text-gray-800 border border-gray-200"
              : isError
                ? "bg-amber-50 text-amber-900 border-2 border-amber-200 flex-1"
                : "bg-white text-gray-900 border border-gray-200 flex-1"
          }`}
          role={isError ? "alert" : undefined}
          aria-live={isError ? "assertive" : "polite"}
        >
          {isUser ? (
            <p className="text-gray-800 text-sm leading-relaxed m-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {message.content}
            </p>
          ) : isError ? (
            <div className="flex items-start space-x-3">
              <div className="flex-shrink-0 text-2xl">⚠️</div>
              <div className="flex-1">
                <p className="text-amber-900 leading-relaxed m-0">
                  {message.content}
                </p>
              </div>
            </div>
          ) : (
            <div className="markdown-content prose prose-sm max-w-none break-words [overflow-wrap:anywhere]">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => (
                    <p className="mb-3 last:mb-0 leading-relaxed font-semibold">
                      {children}
                    </p>
                  ),
                  h2: ({ children }) => (
                    <p className="mb-3 last:mb-0 leading-relaxed font-semibold">
                      {children}
                    </p>
                  ),
                  h3: ({ children }) => (
                    <p className="mb-3 last:mb-0 leading-relaxed font-semibold">
                      {children}
                    </p>
                  ),
                  p: ({ children }) => {
                    const text = String(children).trim();
                    // Bare punctuation or lone inline code: don't wrap in <p>, which would break it onto its own line.
                    if (text.length === 1 && /[.,!?;:]/.test(text)) {
                      return <>{children}</>;
                    }
                    if (/^(\*\*`[^`]+`\*\*|`[^`]+`)$/.test(text)) {
                      return <>{children}</>;
                    }
                    return (
                      <p className="mb-3 last:mb-0 leading-relaxed">
                        {children}
                      </p>
                    );
                  },
                  code: ({
                    inline,
                    children,
                    className,
                    ...props
                  }: CodeRendererProps) => {
                    const codeText = Array.isArray(children)
                      ? children.join("")
                      : String(children ?? "");
                    const isBlockCode =
                      inline === false ||
                      Boolean(className?.includes("language-")) ||
                      codeText.includes("\n");

                    if (!isBlockCode) {
                      return (
                        <code
                          className="bg-pink-100 text-pink-800 px-2 py-0.5 rounded text-sm font-medium"
                          {...props}
                        >
                          {children}
                        </code>
                      );
                    }
                    return (
                      <CodeBlock className={className} {...props}>
                        {children}
                      </CodeBlock>
                    );
                  },
                  pre: ({ children }: PreRendererProps) => {
                    // CodeBlock renders its own <pre>; avoid double wrapping.
                    return <>{children}</>;
                  },
                  ul: ({ children }) => (
                    <ul className="ml-4 mb-3 space-y-1 list-disc">
                      {children}
                    </ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="ml-4 mb-3 space-y-1 list-decimal">
                      {children}
                    </ol>
                  ),
                  li: ({ children }) => (
                    <li className="leading-relaxed">{children}</li>
                  ),
                  table: ({ children }) => (
                    <div className="max-w-full overflow-x-auto my-4">
                      <table className="min-w-full">{children}</table>
                    </div>
                  ),
                  a: ({ children, ...props }) => (
                    <a
                      className="text-primary-600 hover:text-primary-700 underline font-medium"
                      target="_blank"
                      rel="noopener noreferrer"
                      {...props}
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {cleanedContent}
              </ReactMarkdown>
            </div>
          )}

          {message.tokens && (
            <div
              className={`flex items-center space-x-2 text-xs mt-3 pt-2 border-t ${
                isUser
                  ? "text-gray-500 border-gray-200"
                  : isError
                    ? "text-amber-600 border-amber-200"
                    : "text-gray-500 border-gray-200"
              }`}
            >
              <span className="font-medium">{message.tokens} tokens</span>
            </div>
          )}
        </div>

        {isUser && showAvatars && (
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center shadow-md">
            <span className="text-white text-sm font-semibold">You</span>
          </div>
        )}
      </div>
    </div>
  );
};
