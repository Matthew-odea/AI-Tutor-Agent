import { useChatStore } from "../../store/chatStore";
import chatIcon from "../../assets/person.png";
import ideIcon from "../../assets/code.png";
import questionIcon from "../../assets/exam.png";
import { trackModeChanged } from "../../utils/analytics";

export const ModeSelector = () => {
  const { setAppMode } = useChatStore();

  return (
    <div className="flex items-center justify-center h-full p-6">
      <div className="w-full max-w-5xl animate-fade-in space-y-8">
        <div className="text-center mb-4">
          <div className="mb-6 flex justify-center">
            <div className="relative">
              <div className="bg-gradient-to-br from-primary-500 to-primary-600 w-20 h-20 rounded-3xl flex items-center justify-center shadow-2xl">
                <span className="text-white text-4xl font-bold">C9</span>
              </div>
              <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-green-500 rounded-full border-2 border-white"></div>
            </div>
          </div>
          <h2 className="text-3xl font-bold text-gray-900 mb-2">
            Use AI to improve learning, not replace it
          </h2>
          <p className="text-lg text-gray-600">
            Choose how you want to learn today.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <button
            onClick={() => {
              trackModeChanged("none", "chat");
              setAppMode("chat");
            }}
            className="group rounded-2xl border border-gray-200 bg-white p-6 text-left shadow-sm hover:shadow-lg transition-all"
          >
            <div className="flex items-center justify-between">
              <img src={chatIcon} alt="General Chat" className="w-7 h-7" />
              <span className="text-xs font-semibold text-gray-400 group-hover:text-gray-500">
                Enter
              </span>
            </div>
            <h3 className="mt-4 text-lg font-semibold text-gray-900">
              General Chat
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              Ask questions and learn like ChatGPT-style tutoring.
            </p>
          </button>

          <button
            onClick={() => {
              trackModeChanged("none", "ide");
              setAppMode("ide");
            }}
            className="group rounded-2xl border border-gray-200 bg-white p-6 text-left shadow-sm hover:shadow-lg transition-all"
          >
            <div className="flex items-center justify-between">
              <img src={ideIcon} alt="AI-First IDE" className="w-7 h-7" />
              <span className="text-xs font-semibold text-gray-400 group-hover:text-gray-500">
                Enter
              </span>
            </div>
            <h3 className="mt-4 text-lg font-semibold text-gray-900">
              Code with AI
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              Code and run Python with an AI assistant on the right.
            </p>
          </button>

          <button
            disabled
            className="rounded-2xl border border-gray-200 bg-gray-50 p-6 text-left text-gray-400 cursor-not-allowed"
          >
            <div className="flex items-center justify-between">
              <img
                src={questionIcon}
                alt="Question Generation"
                className="w-7 h-7 opacity-60"
              />
              <span className="text-xs font-semibold">Coming soon</span>
            </div>
            <h3 className="mt-4 text-lg font-semibold">Question Generation</h3>
            <p className="mt-2 text-sm">
              Generate tailored assessment questions from student work.
            </p>
          </button>
        </div>
      </div>
    </div>
  );
};
