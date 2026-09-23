/**
 * Persists an unsubmitted answer across refresh/crash. Audio blobs go to IndexedDB
 * (sessionStorage can't hold a Blob); text goes to sessionStorage under `draft_*`.
 * Nothing here ever throws or rejects: losing a draft is acceptable, breaking recording is not.
 */

const DB_NAME = 'oral-assessment';
const DB_VERSION = 1;
const AUDIO_STORE = 'drafts';

// keyPath = assessmentId: one in-flight answer per assessment on the forward-only flow.
interface AudioDraftRecord {
  assessmentId: string;
  questionId: string;
  blob: Blob;
  durationSeconds: number;
}

export interface AudioDraft {
  questionId: string;
  blob: Blob;
  durationSeconds: number;
}

export interface TextDraft {
  questionId: string;
  text: string;
}

function textKey(assessmentId: string): string {
  return `draft_text_${assessmentId}`;
}

// Merely reading `indexedDB` can throw SecurityError in sandboxed/private contexts.
function getIndexedDB(): IDBFactory | null {
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB) return indexedDB;
  } catch {
    /* fall through */
  }
  return null;
}

// Resolves null (never rejects) when unavailable or the open fails.
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const idb = getIndexedDB();
    if (!idb) {
      resolve(null);
      return;
    }
    try {
      const request = idb.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(AUDIO_STORE)) {
          db.createObjectStore(AUDIO_STORE, { keyPath: 'assessmentId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn('[draftStore] failed to open IndexedDB:', request.error);
        resolve(null);
      };
      request.onblocked = () => resolve(null);
    } catch (error) {
      console.warn('[draftStore] indexedDB.open threw:', error);
      resolve(null);
    }
  });
}

// questionId is stored so rehydrate can reject a draft for a different question.
export async function saveAudioDraft(args: {
  assessmentId: string;
  questionId: string;
  blob: Blob;
  durationSeconds: number;
}): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(AUDIO_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.warn('[draftStore] saveAudioDraft tx error:', tx.error);
        resolve();
      };
      tx.onabort = () => resolve();
      const record: AudioDraftRecord = {
        assessmentId: args.assessmentId,
        questionId: args.questionId,
        blob: args.blob,
        durationSeconds: args.durationSeconds,
      };
      tx.objectStore(AUDIO_STORE).put(record);
    });
    db.close();
  } catch (error) {
    console.warn('[draftStore] saveAudioDraft failed (non-fatal):', error);
  }
}

export async function loadAudioDraft(assessmentId: string): Promise<AudioDraft | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const record = await new Promise<AudioDraftRecord | null>((resolve) => {
      const tx = db.transaction(AUDIO_STORE, 'readonly');
      const request = tx.objectStore(AUDIO_STORE).get(assessmentId);
      request.onsuccess = () => resolve((request.result as AudioDraftRecord) ?? null);
      request.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
    db.close();
    if (
      record &&
      typeof record.questionId === 'string' &&
      record.blob instanceof Blob &&
      typeof record.durationSeconds === 'number'
    ) {
      return { questionId: record.questionId, blob: record.blob, durationSeconds: record.durationSeconds };
    }
    return null;
  } catch (error) {
    console.warn('[draftStore] loadAudioDraft failed (non-fatal):', error);
    return null;
  }
}

export async function clearAudioDraft(assessmentId: string): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(AUDIO_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
      tx.objectStore(AUDIO_STORE).delete(assessmentId);
    });
    db.close();
  } catch (error) {
    console.warn('[draftStore] clearAudioDraft failed (non-fatal):', error);
  }
}

export function saveTextDraft(assessmentId: string, questionId: string, text: string): void {
  try {
    const payload: TextDraft = { questionId, text };
    sessionStorage.setItem(textKey(assessmentId), JSON.stringify(payload));
  } catch {
    /* storage disabled or over quota */
  }
}

export function loadTextDraft(assessmentId: string): TextDraft | null {
  try {
    const raw = sessionStorage.getItem(textKey(assessmentId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as TextDraft).questionId === 'string' &&
      typeof (parsed as TextDraft).text === 'string'
    ) {
      return parsed as TextDraft;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearTextDraft(assessmentId: string): void {
  try {
    sessionStorage.removeItem(textKey(assessmentId));
  } catch {
    /* storage disabled */
  }
}
