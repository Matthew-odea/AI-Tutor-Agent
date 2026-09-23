import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  saveAudioDraft,
  loadAudioDraft,
  clearAudioDraft,
  saveTextDraft,
  loadTextDraft,
  clearTextDraft,
} from '../services/draftStore';

// Minimal IndexedDB fake (jsdom has none). Callbacks fire on a microtask so they run after
// draftStore assigns its handlers, matching real IDB ordering.
class FakeRequest {
  result: unknown = undefined;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

class FakeObjectStore {
  data: Map<string, unknown>;
  keyPath: string;
  constructor(data: Map<string, unknown>, keyPath: string) {
    this.data = data;
    this.keyPath = keyPath;
  }
  put(record: Record<string, unknown>) {
    this.data.set(record[this.keyPath] as string, record);
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }
  get(key: string) {
    const req = new FakeRequest();
    queueMicrotask(() => {
      req.result = this.data.get(key);
      req.onsuccess?.();
    });
    return req;
  }
  delete(key: string) {
    this.data.delete(key);
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }
}

class FakeTransaction {
  db: FakeDB;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: unknown = null;
  constructor(db: FakeDB) {
    this.db = db;
    // Fire completion after the put/delete microtask has had a chance to run.
    queueMicrotask(() => queueMicrotask(() => this.oncomplete?.()));
  }
  objectStore(name: string) {
    return new FakeObjectStore(this.db.stores.get(name)!, this.db.keyPaths.get(name)!);
  }
}

class FakeDB {
  stores = new Map<string, Map<string, unknown>>();
  keyPaths = new Map<string, string>();
  objectStoreNames = { contains: (n: string) => this.stores.has(n) };
  createObjectStore(name: string, opts: { keyPath: string }) {
    this.stores.set(name, new Map());
    this.keyPaths.set(name, opts.keyPath);
    return new FakeObjectStore(this.stores.get(name)!, opts.keyPath);
  }
  transaction() {
    return new FakeTransaction(this);
  }
  close() {}
}

function makeFakeIndexedDB() {
  const databases = new Map<string, FakeDB>();
  return {
    open(name: string) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        const isNew = !databases.has(name);
        if (isNew) databases.set(name, new FakeDB());
        const db = databases.get(name)!;
        req.result = db;
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

const blob = (s = 'audio-bytes') => new Blob([s], { type: 'audio/webm' });

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Text draft (sessionStorage — real in jsdom)
describe('draftStore text draft', () => {
  it('save → load round-trips the question id and text', () => {
    saveTextDraft('a1', 'q1', 'my partial answer');
    expect(loadTextDraft('a1')).toEqual({ questionId: 'q1', text: 'my partial answer' });
  });

  it('clear removes the persisted text draft', () => {
    saveTextDraft('a1', 'q1', 'gone soon');
    clearTextDraft('a1');
    expect(loadTextDraft('a1')).toBeNull();
  });

  it('load returns null when absent and for malformed JSON (never throws)', () => {
    expect(loadTextDraft('missing')).toBeNull();
    sessionStorage.setItem('draft_text_a1', '{not valid json');
    expect(loadTextDraft('a1')).toBeNull();
  });

  it('uses the draft_* namespace (no collision with the qtimer_start_* timer keys)', () => {
    saveTextDraft('a1', 'q1', 'x');
    expect(sessionStorage.getItem('draft_text_a1')).not.toBeNull();
    expect(sessionStorage.getItem('qtimer_start_a1_q1')).toBeNull();
  });

  it('degrades gracefully when sessionStorage.setItem throws (quota / private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => saveTextDraft('a1', 'q1', 'too big')).not.toThrow();
  });
});

// Audio draft graceful degradation (NO IndexedDB — real jsdom)
describe('draftStore audio draft — graceful degradation without IndexedDB', () => {
  it('save/load/clear never throw and load resolves to null when IndexedDB is unavailable', async () => {
    // jsdom has no indexedDB, so these all hit the no-op / null path.
    await expect(
      saveAudioDraft({ assessmentId: 'a1', questionId: 'q1', blob: blob(), durationSeconds: 12 }),
    ).resolves.toBeUndefined();
    await expect(loadAudioDraft('a1')).resolves.toBeNull();
    await expect(clearAudioDraft('a1')).resolves.toBeUndefined();
  });
});

// Audio draft happy path (injected fake IndexedDB)
describe('draftStore audio draft — with IndexedDB', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', makeFakeIndexedDB());
  });

  it('save → load round-trips the blob, question id and duration', async () => {
    const b = blob('hello-world');
    await saveAudioDraft({ assessmentId: 'a1', questionId: 'q1', blob: b, durationSeconds: 42 });
    const loaded = await loadAudioDraft('a1');
    expect(loaded).not.toBeNull();
    expect(loaded!.questionId).toBe('q1');
    expect(loaded!.durationSeconds).toBe(42);
    expect(loaded!.blob).toBeInstanceOf(Blob);
    expect(loaded!.blob.size).toBe(b.size);
  });

  it('load returns null for an assessment with no stored draft', async () => {
    await saveAudioDraft({ assessmentId: 'a1', questionId: 'q1', blob: blob(), durationSeconds: 1 });
    expect(await loadAudioDraft('other-assessment')).toBeNull();
  });

  it('clear removes the persisted audio draft', async () => {
    await saveAudioDraft({ assessmentId: 'a1', questionId: 'q1', blob: blob(), durationSeconds: 5 });
    await clearAudioDraft('a1');
    expect(await loadAudioDraft('a1')).toBeNull();
  });

  it('a later save overwrites the prior draft for the same assessment (single in-flight slot)', async () => {
    await saveAudioDraft({ assessmentId: 'a1', questionId: 'q1', blob: blob(), durationSeconds: 5 });
    await saveAudioDraft({ assessmentId: 'a1', questionId: 'q2', blob: blob(), durationSeconds: 9 });
    const loaded = await loadAudioDraft('a1');
    expect(loaded!.questionId).toBe('q2');
    expect(loaded!.durationSeconds).toBe(9);
  });
});
