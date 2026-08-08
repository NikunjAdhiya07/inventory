// Process-level TTL cache for read-mostly data on the bot's hot path.
//
// Every button tap used to re-query the same master-data collections (categories,
// subcategories, units, locations, roles, the resolved workflow). Those change on
// admin action — minutes to days apart — while the bot reads them several times
// per second, so a short TTL removes almost all of the Mongo round trips from the
// latency budget without the data ever being meaningfully stale.
//
// Cached on `global` for the same reason the Mongo client is: dev hot reloads and
// warm serverless invocations reuse one map instead of starting cold.

const DEFAULT_TTL_MS = Number(process.env.CACHE_TTL_MS) || 30_000;

type Entry = { value: unknown; expires: number };

const g = globalThis as unknown as {
  _cacheStore?: Map<string, Entry>;
  _cacheInflight?: Map<string, Promise<unknown>>;
};

const store = (g._cacheStore ??= new Map<string, Entry>());
// Single-flight: a burst of taps arriving on a cold key must issue ONE query, not
// one per request. Concurrent callers await the same promise.
const inflight = (g._cacheInflight ??= new Map<string, Promise<unknown>>());

export async function cached<T>(key: string, load: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;

  const running = inflight.get(key);
  if (running) return running as Promise<T>;

  const promise = load()
    .then((value) => {
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

// Drop cache entries whose key starts with `prefix`. Called from the console's
// write paths so an admin's edit shows up in the bot immediately on this
// instance; other instances converge within the TTL.
export function invalidate(prefix: string) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

// Collections whose contents the bot renders as inline keyboards. A write to any
// of these invalidates the matching cache keys.
const CACHED_COLLECTIONS = new Set([
  "categories",
  "subcategories",
  // The nested-category master: a tree's levels and the options under them are
  // both read on every tap of a nested step.
  "optionTrees",
  "optionNodes",
  // The stock movement vocabulary: read on every movement recorded and on every
  // history page, changed only when an admin edits the master.
  "movementTypes",
  "vendors",
  "departments",
  "units",
  "locations",
  "products",
  "productAttributes",
  "productAliases",
  "roles",
  "workflows",
  "workflowVersions",
  "workflowAssignments",
  // Not a keyboard source — this is the per-chat access gate, cached because the
  // webhook reads it on every update. Approving or force-inactivating a group
  // has to take effect on the next message, not at the end of the TTL.
  "telegramGroups",
]);

export function invalidateCollection(collection: string) {
  if (CACHED_COLLECTIONS.has(collection)) invalidate(collection);
  // A workflow/assignment change can alter which workflow a group resolves to,
  // so the per-chat resolution cache has to go with it.
  if (collection.startsWith("workflow")) invalidate("resolved-workflow");
}
