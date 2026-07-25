import { MongoClient, type Db } from "mongodb";

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";

// Cached on `global` so Next.js dev-mode hot reloads reuse one client instead of
// opening a fresh TCP connection (and connection-pool) per file change.
const globalForMongo = globalThis as unknown as { _mongoClientPromise?: Promise<MongoClient> };

function createClient() {
  const client = new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 0,
  });
  return client.connect();
}

const clientPromise: Promise<MongoClient> = globalForMongo._mongoClientPromise ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForMongo._mongoClientPromise = clientPromise;
}

let indexesEnsured: Promise<void> | null = null;

async function ensureIndexes(db: Db) {
  await Promise.all([
    db.collection("categories").createIndex({ order: 1 }),
    db.collection("subcategories").createIndex({ parent: 1 }),
    db.collection("locations").createIndex({ parent: 1 }),
    db.collection("statuses").createIndex({ order: 1 }),
    db.collection("colors").createIndex({ group: 1 }),
    db.collection("users").createIndex({ tgId: 1 }, { unique: true }),
    db.collection("apiKeys").createIndex({ name: 1 }),
    db.collection("auditLog").createIndex({ ts: -1 }),
    db.collection("recycleBin").createIndex({ deletedAt: -1 }),
    db.collection("importJobs").createIndex({ when: -1 }),
    // Workflow builder + Telegram bot engine collections.
    db.collection("stepLibrary").createIndex({ order: 1 }),
    db.collection("workflows").createIndex({ status: 1 }),
    db.collection("workflows").createIndex({ isDefault: 1 }),
    db.collection("workflowVersions").createIndex({ workflowId: 1, version: 1 }, { unique: true }),
    db.collection("telegramGroups").createIndex({ chatId: 1 }, { unique: true }),
    db.collection("telegramLogs").createIndex({ ts: -1 }),
    db.collection("telegramLogs").createIndex({ chatId: 1, ts: -1 }),
    db.collection("workflowAssignments").createIndex({ chatId: 1 }),
    db.collection("workflowAssignments").createIndex({ category: 1 }),
    db.collection("botSessions").createIndex({ chatId: 1, userId: 1 }),
    db.collection("botSessions").createIndex({ status: 1 }),
    db.collection("inventoryEntries").createIndex({ createdAt: -1 }),
  ]);
}

export async function getDb(): Promise<Db> {
  const client = await clientPromise;
  const db = client.db(dbName);
  // Index creation is idempotent and cheap once created; only ever run it once
  // per server process instead of on every request.
  if (!indexesEnsured) {
    indexesEnsured = ensureIndexes(db).catch(() => {
      indexesEnsured = null;
    });
  }
  return db;
}
