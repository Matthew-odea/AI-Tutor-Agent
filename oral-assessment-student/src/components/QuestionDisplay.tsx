import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import type { Question } from '../types';

interface QuestionDisplayProps {
  question: Question;
  questionNumber?: number;
  totalQuestions?: number;
}

export default function QuestionDisplay({
  question,
}: QuestionDisplayProps) {
  return (
    <div className="bg-paper rounded-xl border border-hairline p-6">
      <div className="prose prose-sm max-w-none">
        <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
          {question.text || '*Question text not yet available.*'}
        </ReactMarkdown>
      </div>

      {question.codeContext && (
        <div className="mt-4 border-t border-hairline pt-4">
          <h4 className="text-sm font-semibold text-slate mb-2">
            Your Code
          </h4>
          <div className="prose prose-sm max-w-none">
            <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
              {`\`\`\`python\n${question.codeContext}\n\`\`\``}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
