// Create every index the app relies on. Safe to re-run (createIndexes is
// idempotent). Run it after a deploy — indexes are no longer created lazily in
// front of a live request.
//
//   npm run ensure-indexes

import "dotenv/config";
import { MongoClient } from "mongodb";
import { readFileSync } from "node:fs";

// .env.local is Next's convention and is not loaded by dotenv/config.
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // no .env.local — rely on the ambient environment
}

const INDEX_SPECS = {
  categories: [{ key: { order: 1 } }],
  subcategories: [{ key: { parent: 1 } }],
  locations: [{ key: { parent: 1 } }],
  optionTrees: [{ key: { name: 1 }, unique: true }],
  optionNodes: [{ key: { treeId: 1, parent: 1 } }, { key: { parent: 1 } }],
  products: [
    { key: { productNumberKey: 1 }, unique: true },
    { key: { status: 1, name: 1 } },
    { key: { category: 1 } },
    // One drill-down path resolves to exactly one product. Partial, because only
    // a product a nested tree resolved to carries a pathKey at all — without the
    // filter every hand-typed product would collide on a missing field.
    {
      key: { treeId: 1, pathKey: 1 },
      unique: true,
      partialFilterExpression: { pathKey: { $type: "string" } },
    },
  ],
  productAttributes: [{ key: { order: 1 } }],
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
  stepLibrary: [{ key: { order: 1 } }],
  workflows: [{ key: { status: 1 } }, { key: { isDefault: 1 } }],
  workflowVersions: [{ key: { workflowId: 1, version: 1 }, unique: true }],
  telegramGroups: [{ key: { chatId: 1 }, unique: true }],
  telegramLogs: [{ key: { ts: -1 } }, { key: { chatId: 1, ts: -1 } }],
  workflowAssignments: [{ key: { chatId: 1 } }, { key: { category: 1 } }],
  botSessions: [{ key: { chatId: 1, userId: 1, status: 1 } }, { key: { status: 1 } }],
  inventoryEntries: [
    { key: { createdAt: -1 } },
    { key: { ticketNumber: 1 }, unique: true, partialFilterExpression: { ticketNumber: { $type: "string" } } },
    { key: { sessionId: 1 }, unique: true, partialFilterExpression: { sessionId: { $type: "string" } } },
  ],
  movementTypes: [{ key: { code: 1 }, unique: true }, { key: { order: 1 } }],
  stockMovements: [
    { key: { productId: 1, locationId: 1 } },
    { key: { movementKey: 1 }, unique: true, partialFilterExpression: { movementKey: { $type: "string" } } },
    { key: { requestId: 1 } },
    { key: { createdAt: -1 } },
    // The transaction history is read by type and by item, newest first.
    { key: { reason: 1, createdAt: -1 } },
    { key: { productId: 1, createdAt: -1 } },
  ],
  maintenanceUsers: [{ key: { code: 1 }, unique: true }, { key: { status: 1, order: 1 } }],
  workers: [{ key: { code: 1 }, unique: true }, { key: { status: 1, order: 1 } }],
  borrowings: [
    { key: { ticketNumber: 1 }, unique: true },
    // "What is Vijay still holding?" and "who has this item?" are the two
    // questions a borrowing record exists to answer.
    { key: { maintenanceUserId: 1, status: 1, createdAt: -1 } },
    { key: { productId: 1, createdAt: -1 } },
    { key: { chatId: 1, createdAt: -1 } },
  ],
  requests: [
    { key: { chatId: 1, requesterUserId: 1, status: 1 } },
    { key: { ticketNumber: 1 }, unique: true, partialFilterExpression: { ticketNumber: { $type: "string" } } },
    { key: { anchorMessageId: 1 } },
    { key: { status: 1, createdAt: -1 } },
    { key: { createdAt: -1 } },
  ],
};

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set.");
  process.exit(1);
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.MONGODB_DB || "inventory");

for (const [collection, specs] of Object.entries(INDEX_SPECS)) {
  const names = await db.collection(collection).createIndexes(specs);
  console.log(`✔ ${collection}: ${names.join(", ")}`);
}

await client.close();
console.log("\nAll indexes ensured.");
