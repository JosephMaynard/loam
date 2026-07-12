type StoreName = "channels" | "messages" | "sync" | "users";

type StoredRecord = {
  id: string;
};

const DB_NAME = "loam-poc";
const DB_VERSION = 1;
const STORE_NAMES: StoreName[] = ["channels", "messages", "sync", "users"];

let databasePromise: Promise<IDBDatabase> | undefined;
// Latched by markLocalStoreWiped() for the rest of this page load: once wiped, no read or write may
// re-open (and thus re-create) the database. This closes the race where an in-flight fetch resolves
// AFTER a device wipe and its putRecords() would otherwise rebuild the just-deleted DB (docs/15 #4).
// A reload clears it (fresh module), which is the intended fresh start.
let wiped = false;

/** Latch this page load as wiped so no later read/write re-creates the just-deleted database — the
 * app calls this from its device/node wipe flow, separately from destroyDatabase() (docs/15 #4). */
export function markLocalStoreWiped(): void {
  wiped = true;
}

/** Test-only: clear the wipe latch + cached connection so each test starts from a clean module. */
export function resetLocalStoreForTests(): void {
  wiped = false;
  databasePromise = undefined;
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
    // deferred rather than complete.
    request.onblocked = () => reject(new Error("Database deletion deferred: another tab holds a connection."));
  });
}
