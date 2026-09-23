const FRIENDLY_HINTS: Record<string, string> = {
  SyntaxError: "Check punctuation, quotes, and brackets on this line.",
  IndentationError: "Check indentation spacing for this block.",
  TabError: "Use consistent indentation (spaces only is recommended).",
  NameError: "A variable or function name is not defined yet.",
  TypeError: "An operation is being used with an incompatible type.",
  ValueError: "A function received a value in the wrong format.",
  ZeroDivisionError: "A division by zero occurred.",
  IndexError: "You tried to access a list index that does not exist.",
  KeyError: "A dictionary key was not found.",
  AttributeError: "An object does not have that attribute or method.",
  ModuleNotFoundError:
    "A required module is not available in this environment.",
};

const extractLastErrorSummary = (lines: string[]): string => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (/^[A-Za-z_][\w.]*Error(?::|$)/.test(line)) {
      return line;
    }
  }
  return lines.find((line) => line.trim())?.trim() || "Python error";
};

export function formatStudentFriendlyPythonError(rawError: string): string {
  if (!rawError?.trim()) {
    return "Python error";
  }

  const lines = rawError
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));

  const summary = extractLastErrorSummary(lines);
  const errorType = summary.split(":")[0].trim();

  let lineNumber: string | null = null;
  let codeLine: string | null = null;
  let caretLine: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/File "<exec>", line (\d+)/);
    if (!match) continue;

    lineNumber = match[1];
    const nextLine = lines[index + 1]?.trim() || "";
    const pointerLine = lines[index + 2] || "";

    if (nextLine && !nextLine.startsWith('File "')) {
      codeLine = nextLine;
    }

    if (pointerLine.includes("^")) {
      caretLine = pointerLine.trimEnd();
    }
  }

  const messageLines: string[] = [];
  messageLines.push(lineNumber ? `Line ${lineNumber}: ${summary}` : summary);

  if (codeLine) {
    messageLines.push(codeLine);
  }

  if (caretLine) {
    messageLines.push(caretLine);
  }

  const hint = FRIENDLY_HINTS[errorType];
  if (hint) {
    messageLines.push(`Hint: ${hint}`);
  }

  return messageLines.join("\n");
}
