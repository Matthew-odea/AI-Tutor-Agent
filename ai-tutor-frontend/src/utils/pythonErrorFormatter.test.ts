import { describe, expect, it } from "vitest";
import { formatStudentFriendlyPythonError } from "./pythonErrorFormatter";

describe("formatStudentFriendlyPythonError", () => {
  it("extracts concise syntax error with line and caret", () => {
    const raw = `Traceback (most recent call last):
  File "/lib/python313.zip/_pyodide/_base.py", line 597, in eval_code_async
    await CodeRunner(
  File "<exec>", line 4
    print("hi")af
               ^^
SyntaxError: invalid syntax`;

    const formatted = formatStudentFriendlyPythonError(raw);
    expect(formatted).toContain("Line 4: SyntaxError: invalid syntax");
    expect(formatted).toContain('print("hi")af');
    expect(formatted).toContain("^^");
    expect(formatted).toContain(
      "Hint: Check punctuation, quotes, and brackets on this line.",
    );
  });

  it("handles runtime errors without traceback metadata", () => {
    const raw = 'NameError: name "value" is not defined';
    const formatted = formatStudentFriendlyPythonError(raw);

    expect(formatted).toBe(
      'NameError: name "value" is not defined\nHint: A variable or function name is not defined yet.',
    );
  });
});
