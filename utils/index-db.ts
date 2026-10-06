import type { IndexMeta, TrackEntry } from './types';

const DB_NAME = 'shazamski';
const DB_VERSION = 2;
const TRACKS_STORE = 'tracks';
const META_STORE = 'meta';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TRACKS_STORE)) {
        const s = db.createObjectStore(TRACKS_STORE, { keyPath: 'id' });
        s.createIndex('fpLen', 'fpLen', { unique: false });
      } else {
        const tx = req.transaction;
        if (tx) {
          const store = tx.objectStore(TRACKS_STORE);
          if (!(store as any).indexNames?.contains?.('fpLen')) store.createIndex('fpLen', 'fpLen', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        fn(db).then(
          (v) => {
            db.close();
            resolve(v);
          },
          (e) => {
            try {
              db.close();
            } catch {
              throw new Error('IndexedDB close failed');
            }
            reject(e);
          },
        );
      }),
  );
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function putTracks(tracks: TrackEntry[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const CHUNK = 500;
  for (let start = 0; start < tracks.length; start += CHUNK) {
    const chunk = tracks.slice(start, start + CHUNK);
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(TRACKS_STORE, 'readwrite');
        transaction.onerror = () => reject(transaction.error ?? new Error('putTracks transaction failed'));
        transaction.oncomplete = () => resolve();
        const store = transaction.objectStore(TRACKS_STORE);
        for (const t of chunk) store.put(t);
      });
    } finally {
      db.close();
    }
    onProgress?.(Math.min(tracks.length, start + chunk.length), tracks.length);
    if (start + CHUNK < tracks.length) await new Promise((r) => setTimeout(r, 0));
  }
}

export async function clearTracks(): Promise<void> {
  const db = await openDb();
  try {
    const transaction = db.transaction([TRACKS_STORE, META_STORE], 'readwrite');
    await Promise.all([
      requestToPromise(transaction.objectStore(TRACKS_STORE).clear()),
      requestToPromise(transaction.objectStore(META_STORE).clear()),
    ]);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('clear failed'));
    });
  } finally {
    db.close();
  }
}

export async function countTracks(): Promise<number> {
  const db = await openDb();
  try {
    const transaction = db.transaction(TRACKS_STORE, 'readonly');
    return await requestToPromise<number>(transaction.objectStore(TRACKS_STORE).count());
  } finally {
    db.close();
  }
}

export async function getAllTracks(): Promise<TrackEntry[]> {
  const db = await openDb();
  try {
    const transaction = db.transaction(TRACKS_STORE, 'readonly');
    const out: TrackEntry[] = await requestToPromise<any>(transaction.objectStore(TRACKS_STORE).getAll());
    return out ?? [];
  } finally {
    db.close();
  }
}

export async function iterateTracks(batchSize: number, cb: (batch: TrackEntry[]) => void): Promise<void> {
  const db = await openDb();
  try {
    const transaction = db.transaction(TRACKS_STORE, 'readonly');
    const cursorReq = transaction.objectStore(TRACKS_STORE).openCursor();
    let batch: TrackEntry[] = [];
    await new Promise<void>((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          if (batch.length) {
            try {
              cb(batch);
            } catch (e) {
              reject(e);
              return;
            }
          }
          resolve();
          return;
        }
        batch.push(cursor.value as TrackEntry);
        if (batch.length >= batchSize) {
          try {
            cb(batch);
          } catch (e) {
            reject(e);
            return;
          }
          batch = [];
        }
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error ?? new Error('cursor failed'));
    });
  } finally {
    db.close();
  }
}

export async function putMeta(meta: IndexMeta): Promise<void> {
  return tx('readwrite', async (db) => {
    const transaction = db.transaction(META_STORE, 'readwrite');
    await requestToPromise(transaction.objectStore(META_STORE).put({ key: 'meta', ...meta }));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('putMeta failed'));
    });
  });
}

export async function getMeta(): Promise<IndexMeta | null> {
  return tx('readonly', async (db) => {
    const transaction = db.transaction(META_STORE, 'readonly');
    const row = await requestToPromise<any>(transaction.objectStore(META_STORE).get('meta'));
    if (!row) return null;
    const { key: _drop, ...meta } = row;
    return meta as IndexMeta;
  });
}
