import { loadPyodide, type PyodideInterface } from "pyodide";

let pyodideInstance: PyodideInterface | null = null;
let loadingPromise: Promise<PyodideInterface> | null = null;

/** Lazily loads one shared Pyodide instance; concurrent callers share the in-flight load. */
export async function getPyodide(): Promise<PyodideInterface> {
  if (pyodideInstance) {
    return pyodideInstance;
  }

  if (loadingPromise) {
    return loadingPromise;
  }

  // indexURL version must match the installed pyodide npm package, or loading fails with a version mismatch.
  loadingPromise = loadPyodide({
    indexURL: "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/",
  });

  try {
    pyodideInstance = await loadingPromise;
    return pyodideInstance;
  } finally {
    loadingPromise = null;
  }
}

export function isPyodideLoaded(): boolean {
  return pyodideInstance !== null;
}

export function resetPyodide(): void {
  pyodideInstance = null;
  loadingPromise = null;
}
