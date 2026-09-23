import { useChat } from "../../hooks/useChat";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";

export const ChatContainer = () => {
  const { messages, isLoading, error, sendMessage } = useChat();

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden">
      {error && (
        <div className="bg-red-50 border-l-4 border-red-500 px-6 py-4 animate-fade-in">
          <div className="flex items-start space-x-3">
            <span className="text-red-500 text-lg">⚠️</span>
            <div className="flex-1">
              <p className="text-sm font-medium text-red-800">Error occurred</p>
              <p className="text-sm text-red-700 mt-1">{error}</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-hidden bg-white flex flex-col">
        <div className="flex-1 overflow-hidden w-full">
          <MessageList
            messages={messages}
            isLoading={isLoading}
            onSendMessage={sendMessage}
          />
        </div>
        <ChatInput onSend={sendMessage} disabled={isLoading} />
      </div>
    </div>
  );
};
