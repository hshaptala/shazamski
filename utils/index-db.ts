import type { IndexMeta, TrackEntry } from './types';
const DB_NAME = 'shazamski';
const DB_VERSION = 1;
const TRACKS_STORE = 'tracks';
const META_STORE = 'meta';
function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(TRACKS_STORE)) {
                db.createObjectStore(TRACKS_STORE, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, { keyPath: 'key' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
}
function tx<T>(mode: IDBTransactionMode, fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    return openDb().then((db) => new Promise<T>((resolve, reject) => {
        fn(db).then((v) => {
            db.close();
            resolve(v);
        }, (e) => {
            try {
                db.close();
            }
            catch {
            }
            reject(e);
        });
    }));
}
function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
}
export async function putTracks(tracks: TrackEntry[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const db = await openDb();
    try {
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(TRACKS_STORE, 'readwrite');
            transaction.onerror = () => reject(transaction.error ?? new Error('putTracks transaction failed'));
            transaction.oncomplete = () => resolve();
            const store = transaction.objectStore(TRACKS_STORE);
            const CHUNK_NOTIFY = 500;
            tracks.forEach((t, i) => {
                store.put(t);
                if (onProgress && (i % CHUNK_NOTIFY === 0 || i === tracks.length - 1)) {
                    try {
                        onProgress(i + 1, tracks.length);
                    }
                    catch {
                    }
                }
            });
        });
    }
    finally {
        db.close();
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
    }
    finally {
        db.close();
    }
}
export async function countTracks(): Promise<number> {
    const db = await openDb();
    try {
        const transaction = db.transaction(TRACKS_STORE, 'readonly');
        const n = await requestToPromise<number>(transaction.objectStore(TRACKS_STORE).count());
        return n;
    }
    finally {
        db.close();
    }
}
export async function getAllTracks(): Promise<TrackEntry[]> {
    const db = await openDb();
    try {
        const transaction = db.transaction(TRACKS_STORE, 'readonly');
        const store = transaction.objectStore(TRACKS_STORE);
        const out: TrackEntry[] = await requestToPromise<any>(store.getAll());
        return out ?? [];
    }
    finally {
        db.close();
    }
}
export async function iterateTracks(batchSize: number, cb: (batch: TrackEntry[]) => void): Promise<void> {
    const db = await openDb();
    try {
        const transaction = db.transaction(TRACKS_STORE, 'readonly');
        const store = transaction.objectStore(TRACKS_STORE);
        const cursorReq = store.openCursor();
        let batch: TrackEntry[] = [];
        await new Promise<void>((resolve, reject) => {
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor) {
                    if (batch.length) {
                        try {
                            cb(batch);
                        }
                        catch (e) {
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
                    }
                    catch (e) {
                        reject(e);
                        return;
                    }
                    batch = [];
                }
                cursor.continue();
            };
            cursorReq.onerror = () => reject(cursorReq.error ?? new Error('cursor failed'));
        });
    }
    finally {
        db.close();
    }
}
export async function putMeta(meta: IndexMeta): Promise<void> {
    return tx('readwrite', async (db) => {
        const transaction = db.transaction(META_STORE, 'readwrite');
        const done = requestToPromise(transaction.objectStore(META_STORE).put({ key: 'meta', ...meta }));
        await done;
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
        if (!row)
            return null;
        const { key: _drop, ...meta } = row;
        return meta as IndexMeta;
    });
}
