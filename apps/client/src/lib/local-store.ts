type StoreName = "channels" | "messages" | "sync" | "users";

type StoredRecord = {
  id: string;
};

const DB_NAME = "loam-poc";
const DB_VERSION = 1;
const STORE_NAMES: StoreName[] = ["channels", "messages", "sync", "users"];

let databasePromise: Promise<IDBDatabase> | undefined;

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
  if (!hasIndexedDb()) {
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
  if (!hasIndexedDb() || !records.length) {
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
  if (!hasIndexedDb()) {
    return;
  }

  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(id);
  await transactionDone(transaction);
}
