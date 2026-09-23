import { loadPyodide, type PyodideInterface } from "pyodide";

let pyodideInstance: PyodideInterface | null = null;
let loadingPromise: Promise<PyodideInterface> | null = null;

/**
 * Load Pyodide instance (singleton pattern)
 * Lazy loads on first use and caches for subsequent calls
 */
export async function getPyodide(): Promise<PyodideInterface> {
  // Return cached instance if already loaded
  if (pyodideInstance) {
    return pyodideInstance;
  }

  // If already loading, wait for that promise
  if (loadingPromise) {
    return loadingPromise;
  }

  // Start loading
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

/**
 * Check if Pyodide is loaded
 */
export function isPyodideLoaded(): boolean {
  return pyodideInstance !== null;
}

/**
 * Reset Pyodide instance (for testing or cleanup)
 */
export function resetPyodide(): void {
  pyodideInstance = null;
  loadingPromise = null;
}
