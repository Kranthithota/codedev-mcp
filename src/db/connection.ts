import { SqliteStore } from './sqlite-store.js';
import { CWD } from '../config.js';

let dbInstance: SqliteStore | null = null;
let initPromise: Promise<SqliteStore> | null = null;

/**
 * Get the singleton database instance.
 * Initializes it if not already initialized.
 * @returns The singleton SqliteStore instance.
 */
export async function getDb(): Promise<SqliteStore> {
  if (dbInstance) return dbInstance;

  if (!initPromise) {
    initPromise = (async () => {
      const store = new SqliteStore(CWD);
      await store.init(CWD);
      // Try to load existing
      await store.load();
      dbInstance = store;
      return store;
    })();
  }

  return initPromise;
}

/**
 * Close the database connection.
 */
export async function closeDb(): Promise<void> {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
