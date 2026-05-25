/** Durable key/value persistence backed by tauri-plugin-store. Writes land in
 *  the app data dir (e.g. ~/Library/Application Support/com.pointer.editor/) so
 *  they survive across dev/build runs in a way localStorage doesn't always.
 */
import { Store, type LazyStore } from "@tauri-apps/plugin-store";

const STORE_PATH = "pointer.json";

let cached: Promise<Store | LazyStore> | null = null;

async function getStore() {
  if (!cached) {
    cached = (async () => {
      try {
        return await Store.load(STORE_PATH);
      } catch {
        // In non-Tauri contexts (e.g. plain vite preview) the plugin isn't
        // available — fall back to a no-op stub that mirrors the API.
        return makeMemoryStore() as unknown as Store;
      }
    })();
  }
  return cached;
}

function makeMemoryStore() {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string): Promise<T | undefined> {
      return m.get(k) as T | undefined;
    },
    async set(k: string, v: unknown) {
      m.set(k, v);
    },
    async save() {
      /* noop */
    },
    async delete(k: string): Promise<boolean> {
      return m.delete(k);
    },
  };
}

export async function getItem<T>(key: string): Promise<T | undefined> {
  const s = await getStore();
  return await s.get<T>(key);
}

export async function setItem<T>(key: string, value: T): Promise<void> {
  const s = await getStore();
  await s.set(key, value);
  await s.save();
}

export async function deleteItem(key: string): Promise<void> {
  const s = await getStore();
  await s.delete(key);
  await s.save();
}

/**
 * Nuke everything in the persistent store. Must be called before the Rust
 * reset removes the underlying file — the plugin keeps an in-memory copy
 * keyed by path and would otherwise rewrite the deleted file on the next
 * save, defeating the reset.
 */
export async function clearStore(): Promise<void> {
  // Drain any queued writes first so they can't land after the clear and
  // resurrect entries we just removed.
  try {
    await pending;
  } catch {
    /* ignore */
  }
  const s = await getStore();
  // Plugin v2 exposes `.entries()` so we can delete keys explicitly. If
  // `.clear()` is available we prefer that, but fall back to per-key deletes
  // for robustness across plugin versions.
  const maybe = s as unknown as { clear?: () => Promise<void> };
  if (typeof maybe.clear === "function") {
    await maybe.clear();
  } else {
    const entries = await (s as unknown as {
      entries: () => Promise<Array<[string, unknown]>>;
    }).entries();
    for (const [k] of entries) await s.delete(k);
  }
  await s.save();
  // Drop the cached promise so the next caller re-loads from the (now
  // empty) plugin state instead of any stale closure we might be holding.
  cached = null;
}

let pending: Promise<unknown> = Promise.resolve();
/** Coalesces writes — call repeatedly, they'll execute in order without
 *  thrashing the disk. */
export function persistAsync<T>(key: string, value: T): void {
  pending = pending.then(() => setItem(key, value).catch(() => {}));
}
