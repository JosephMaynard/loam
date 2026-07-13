type StoreName = "channels" | "messages" | "sync" | "users";

type StoredRecord = {
  id: string;
};

const DB_NAME = "loam-poc";
const DB_VERSION = 1;
const STORE_NAMES: StoreName[] = ["channels", "messages", "sync", "users"];
// PERSISTENT wipe-pending flag (docs/20). A wipe whose IndexedDB deletion is DEFERRED (another tab still
// holds the DB → `deleteDatabase` blocks) leaves this set in localStorage, so it SURVIVES a reload — unlike
// the in-memory latch, which would reset and let the pending-deletion DB rehydrate. While set, the store
// stays latched (no hydration) and the deletion is retried on boot; it's cleared only once deletion succeeds.
const WIPE_PENDING_KEY = "loam.wipePending";

let databasePromise: Promise<IDBDatabase> | undefined;

function readWipePending(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(WIPE_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

// Latched by markLocalStoreWiped(): once wiped, no read or write may re-open (and thus re-create) the
// database, closing the race where an in-flight fetch resolves AFTER a wipe and rebuilds the just-deleted
// DB (docs/15 #4). Initialised from the PERSISTENT flag so a reload during a deferred wipe stays latched
// (docs/20) rather than rehydrating the DB that's still pending deletion.
let wiped = readWipePending();

function clearWipePending(): void {
  try {
    localStorage.removeItem(WIPE_PENDING_KEY);
  } catch {
    // ignore — a missing/blocked localStorage just means the flag was never persistable
  }
}

/** Latch this page load as wiped so no later read/write re-creates the just-deleted database, AND persist
 * that intent (docs/20) so a reload before the deletion finishes doesn't rehydrate the DB. The app calls
 * this from its device/node wipe flow, separately from destroyDatabase() (docs/15 #4). */
export function markLocalStoreWiped(): void {
  wiped = true;
  try {
    localStorage.setItem(WIPE_PENDING_KEY, "1");
  } catch {
    // ignore — the in-memory latch above still holds for this page load
  }
}

/**
 * Boot recovery (docs/20): if a prior wipe left the DB pending deletion (its `deleteDatabase` was deferred
 * by another open tab), keep the store latched (no hydration) and RETRY the deletion — which succeeds once
 * the other tab has closed, clearing the persistent flag. Best-effort; a still-blocked retry just leaves
 * the flag set for the next boot. Call once at startup.
 */
export async function recoverPendingWipe(): Promise<void> {
  if (!readWipePending()) {
    return;
  }
  wiped = true; // never hydrate a DB that's pending deletion
  await destroyDatabase().catch(() => undefined);
}

/** Test-only: clear the wipe latch (memory + persistent flag) + cached connection so each test starts from
 * a clean module. */
export function resetLocalStoreForTests(): void {
  wiped = false;
  databasePromise = undefined;
  clearWipePending();
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) {
    return Promise.reject(new Error("IndexedDB is not available."));
  }

  if (wiped) {
    return Promise.reject(new Error("Local database was wiped."));
  }

  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;

        for (const storeName of STORE_NAMES) {
          if (!database.objectStoreNames.contains(storeName)) {
            database.createObjectStore(storeName, { keyPath: "id" });
          }
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        databasePromise = undefined;
        reject(request.error);
      };
    });
  }

  return databasePromise;
}

export async function getAllRecords<T>(storeName: StoreName): Promise<T[]> {
  if (!hasIndexedDb() || wiped) {
    return [];
  }

  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const records = await requestToPromise<T[]>(transaction.objectStore(storeName).getAll());
  await transactionDone(transaction);
  return records;
}

export async function putRecords<T extends StoredRecord>(
  storeName: StoreName,
  records: T[],
): Promise<void> {
  if (!hasIndexedDb() || wiped || !records.length) {
    return;
  }

  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);

  for (const record of records) {
    store.put(record);
  }

  await transactionDone(transaction);
}

export async function putRecord<T extends StoredRecord>(
  storeName: StoreName,
  record: T,
): Promise<void> {
  await putRecords(storeName, [record]);
}

export async function deleteRecord(storeName: StoreName, id: string): Promise<void> {
  if (!hasIndexedDb() || wiped) {
    return;
  }

  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(id);
  await transactionDone(transaction);
}

/**
 * Delete the entire local database (kill-switch purge). Closes the cached connection first, since
 * deletion blocks while a connection is open.
 */
export async function destroyDatabase(): Promise<void> {
  if (!hasIndexedDb()) {
    clearWipePending(); // nothing to delete → the wipe is complete, not pending
    return;
  }

  if (databasePromise) {
    const database = await databasePromise.catch(() => undefined);
    database?.close();
    databasePromise = undefined;
  }

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    // Another tab still holds a connection: the browser defers the deletion until it closes
    // (that tab purges itself too on the wipe event). Surface it so callers know the wipe is
    // deferred rather than complete — the PERSISTENT flag stays set so a reload retries (docs/20).
    request.onblocked = () => reject(new Error("Database deletion deferred: another tab holds a connection."));
  });

  // Only reached when deleteDatabase actually RESOLVED — the DB is gone, so the wipe is no longer pending.
  clearWipePending();
}
