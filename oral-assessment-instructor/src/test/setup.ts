import '@testing-library/jest-dom';

// Node 25+ defines its own global `localStorage`, which is undefined unless node
// runs with --localstorage-file, and it hides jsdom's. CI runs Node 20 and gets
// jsdom's; this gives newer local Nodes the same in-memory behaviour.
if (typeof localStorage === 'undefined') {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
}
