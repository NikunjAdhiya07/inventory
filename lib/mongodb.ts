import { MongoClient, type Db, type Document } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "inventory";

// Cached on `global` so Next.js dev-mode hot reloads reuse one client instead of
// opening a fresh TCP connection (and connection-pool) per file change. Serverless
// instances reuse it across invocations for the lifetime of the container.
const globalForMongo = globalThis as unknown as { _mongoClientPromise?: Promise<MongoClient> };

function createClient() {
  if (!uri) {
    // Defaulting to localhost here turns a missing deploy-time env var into a
    // connection timeout on every single request, with nothing in the logs that
    // points at the real cause. Fail loudly instead.
    throw new Error(
      "MONGODB_URI is not set. Add it to the deployment's environment variables and redeploy."
    );
  }
  const client = new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 0,
    // The driver's 30s default outlives the serverless function itself, so an
    // unreachable cluster shows up as a hung request rather than a readable
    // error. Fail inside the function's budget so the reason reaches the logs.
    serverSelectionTimeoutMS: 8000,
    // Every query this app issues is a small indexed lookup, so anything still
    // outstanding after 10s is a dead socket, not slow work. Without this the
    // driver waits out the whole function budget on a half-open connection.
    socketTimeoutMS: 10000,
  });
  return client.connect();
}

function getClient(): Promise<MongoClient> {
  const cached = globalForMongo._mongoClientPromise;
  if (cached) return cached;

  const promise = createClient();
  // Two reasons this catch has to be attached synchronously: an unawaited
  // rejected promise is an unhandled rejection, and a cached rejected promise
  // would poison every later request on this instance. Dropping it lets the
  // next call retry a cluster that has since come back.
  promise.catch(() => {
    if (globalForMongo._mongoClientPromise === promise) delete globalForMongo._mongoClientPromise;
  });
  globalForMongo._mongoClientPromise = promise;
  return promise;
}

// One `createIndexes` command per collection rather than one per index: same
// result, a third of the round trips.
const INDEX_SPECS: Record<string, { key: Document; unique?: boolean; partialFilterExpression?: Document }[]> = {
  categories: [{ key: { order: 1 } }],
  subcategories: [{ key: { parent: 1 } }],
  locations: [{ key: { parent: 1 } }],
  // The Product Master. Uniqueness is enforced on the normalised key, not the
  // typed-in number, so "pn 1024" can't be added alongside "PN-1024".
  products: [
    { key: { productNumberKey: 1 }, unique: true },
    { key: { status: 1, name: 1 } },
    { key: { category: 1 } },
  ],
  productAttributes: [{ key: { order: 1 } }],
  // Alternate spellings / AI labels for autocorrect on the entry bot.
  productAliases: [
    { key: { aliasKey: 1 }, unique: true },
    { key: { productId: 1 } },
  ],
  statuses: [{ key: { order: 1 } }],
  colors: [{ key: { group: 1 } }],
  users: [{ key: { tgId: 1 }, unique: true }],
  apiKeys: [{ key: { name: 1 } }],
  auditLog: [{ key: { ts: -1 } }],
  recycleBin: [{ key: { deletedAt: -1 } }],
  importJobs: [{ key: { when: -1 } }],
  // Workflow builder + Telegram bot engine collections.
  stepLibrary: [{ key: { order: 1 } }],
  workflows: [{ key: { status: 1 } }, { key: { isDefault: 1 } }],
  workflowVersions: [{ key: { workflowId: 1, version: 1 }, unique: true }],
  telegramGroups: [{ key: { chatId: 1 }, unique: true }],
  telegramLogs: [{ key: { ts: -1 } }, { key: { chatId: 1, ts: -1 } }],
  workflowAssignments: [{ key: { chatId: 1 } }, { key: { category: 1 } }],
  // The bot's session lookup runs on every single update, filtered by all three
  // fields — a compound index makes it a single index hit.
  botSessions: [{ key: { chatId: 1, userId: 1, status: 1 } }, { key: { status: 1 } }],
  // A generated ticket number identifies exactly one entry, and one bot session
  // produces exactly one entry — both are enforced here rather than trusted from
  // application code, because a retried webhook update is a routine event. The
  // partial filters keep the indexes off entries written before ticketing
  // existed, which carry neither field.
  inventoryEntries: [
    { key: { createdAt: -1 } },
    { key: { ticketNumber: 1 }, unique: true, partialFilterExpression: { ticketNumber: { $type: "string" } } },
    { key: { sessionId: 1 }, unique: true, partialFilterExpression: { sessionId: { $type: "string" } } },
  ],
  // The stock ledger. On-hand is never stored — it is summed from these rows per
  // product per location, so a movement can be added or corrected without any
  // running total drifting out of agreement with its own history.
  //
  // `movementKey` is what makes a movement idempotent: the receipt for an entry
  // and the issue for a request line each derive one deterministic key, so a
  // retried webhook update writes the same row twice and the index keeps one.
  stockMovements: [
    { key: { productId: 1, locationId: 1 } },
    { key: { movementKey: 1 }, unique: true, partialFilterExpression: { movementKey: { $type: "string" } } },
    { key: { requestId: 1 } },
    { key: { createdAt: -1 } },
  ],
  // Item requests and purchase requests. A draft IS the requester's live cart —
  // there is no separate session collection — so the chat lookup that finds it
  // runs on every update in a request group and gets its own compound index.
  requests: [
    { key: { chatId: 1, requesterUserId: 1, status: 1 } },
    { key: { ticketNumber: 1 }, unique: true, partialFilterExpression: { ticketNumber: { $type: "string" } } },
    { key: { anchorMessageId: 1 } },
    { key: { status: 1, createdAt: -1 } },
    { key: { createdAt: -1 } },
  ],
};

export async function ensureIndexes(db?: Db): Promise<void> {
  const target = db ?? (await getClient()).db(dbName);
  await Promise.all(
    Object.entries(INDEX_SPECS).map(([collection, specs]) =>
      target.collection(collection).createIndexes(specs as never)
    )
  );
}

let indexesEnsured: Promise<void> | null = null;

// Idempotent, once per process. Callers schedule this OFF the request path (see
// `defer`) — firing 18 index commands into a 10-connection pool while a user is
// waiting on their reply is exactly the cold-start stall it used to cause.
export function ensureIndexesOnce(db: Db): Promise<void> {
  if (!indexesEnsured) {
    indexesEnsured = ensureIndexes(db).catch((err) => {
      console.error("[mongodb] ensureIndexes failed:", err);
      indexesEnsured = null;
    });
  }
  return indexesEnsured;
}

// A unique-index violation, as opposed to any other write failure. Callers that
// rely on an index to enforce a rule (one ticket per session, one product per
// number) use this to turn the driver's error into the right answer for a
// racing caller instead of a 500.
export function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: number }).code === 11000);
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(dbName);
}
