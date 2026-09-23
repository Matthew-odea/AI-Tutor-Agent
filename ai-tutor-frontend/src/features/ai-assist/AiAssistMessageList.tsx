import type { Message } from "../../types";
import { AiAssistMessageBubble } from "./AiAssistMessageBubble";

interface AiAssistMessageListProps {
  messages: Message[];
  isLoading: boolean;
}

export const AiAssistMessageList = ({
  messages,
  isLoading,
}: AiAssistMessageListProps) => {
  return (
    <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 scrollbar-hide">
      {messages.length === 0 ? (
        <div className="text-xs text-gray-500 leading-relaxed">
          Ask about the code, an error, or the output.
        </div>
      ) : (
        messages.map((message, index) => (
          <AiAssistMessageBubble
            key={`${message.timestamp}-${index}`}
            message={message}
          />
        ))
      )}

      {isLoading && <div className="text-xs text-gray-500">Thinking…</div>}
    </div>
  );
};
