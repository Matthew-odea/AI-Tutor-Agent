import { useState } from "react";
import { getPyodide } from "../utils/pyodideLoader";
import { formatStudentFriendlyPythonError } from "../utils/pythonErrorFormatter";
import type { CodeExecutionResult } from "../types";

/** Runs Python fully in-browser via Pyodide. The interpreter is shared across runs, so stdio is reset every time. */
export function useCodeExecution() {
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<CodeExecutionResult | null>(null);

  const runCode = async (code: string): Promise<CodeExecutionResult> => {
    setIsLoading(true);
    const startTime = performance.now();

    try {
      const pyodide = await getPyodide();

      // input() would hang with no stdin, so replace it with a helpful error.
      await pyodide.runPythonAsync(`
    import sys
    import traceback
    import builtins
    from io import StringIO
    sys.stdout = StringIO()
    sys.stderr = StringIO()
    sys.stdin = StringIO()

    def _blocked_input(prompt=""):
        raise RuntimeError(
            "input() is not supported in the browser editor.\\n"
            "\\n"
            "To test your code, replace input() calls with hardcoded values.\\n"
            "For example, instead of:\\n"
            "    name = input('Enter name: ')\\n"
            "Use:\\n"
            "    name = 'Alice'  # Replace with test value"
        )

    builtins.input = _blocked_input
    `);

      try {
        await pyodide.runPythonAsync(code);
      } catch (pythonError: unknown) {
        const pythonErrorMessage =
          pythonError instanceof Error
            ? pythonError.message
            : String(pythonError);
        const formattedError = await pyodide.runPythonAsync(`
import sys
import traceback
exc_type, exc_value, exc_tb = sys.exc_info()
if exc_type:
    tb_lines = traceback.format_exception(exc_type, exc_value, exc_tb)
    ''.join(tb_lines)
else:
    str(${JSON.stringify(pythonErrorMessage)})
`);

        const stderr = await pyodide.runPythonAsync("sys.stderr.getvalue()");
        const fullError = [formattedError, stderr].filter(Boolean).join("\n");
        const conciseError = formatStudentFriendlyPythonError(
          fullError || pythonErrorMessage || "Python error",
        );

        const executionTime = performance.now() - startTime;
        const executionResult: CodeExecutionResult = {
          output: "",
          error: conciseError,
          executionTime,
        };

        setResult(executionResult);
        return executionResult;
      }

      const stdout = await pyodide.runPythonAsync("sys.stdout.getvalue()");
      const stderr = await pyodide.runPythonAsync("sys.stderr.getvalue()");

      const executionTime = performance.now() - startTime;

      const executionResult: CodeExecutionResult = {
        output: stdout || "",
        error: stderr || null,
        executionTime,
      };

      setResult(executionResult);
      return executionResult;
    } catch (error: unknown) {
      // Pyodide load/JS-level failure, not a Python exception.
      const executionTime = performance.now() - startTime;

      let errorMessage = "";

      if (error instanceof Error && error.name) {
        errorMessage += `${error.name}: `;
      }

      if (error instanceof Error && error.message) {
        errorMessage += error.message;
      } else {
        errorMessage = "Unknown error occurred";
      }

      if (errorMessage.includes("Pyodide version does not match")) {
        errorMessage =
          "Python runtime failed to load due to a version mismatch. Please refresh and try again.";
      }

      const executionResult: CodeExecutionResult = {
        output: "",
        error: errorMessage,
        executionTime,
      };

      setResult(executionResult);
      return executionResult;
    } finally {
      setIsLoading(false);
    }
  };

  const clearResult = () => {
    setResult(null);
  };

  return {
    runCode,
    clearResult,
    isLoading,
    result,
  };
}
