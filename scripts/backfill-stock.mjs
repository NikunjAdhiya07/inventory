// Replay existing inventory entries into the stock ledger.
//
// The ledger (`stockMovements`) is new. Every entry the bot captured before it
// existed is a real receipt that nothing ever posted, so without this the
// request bot would open on an empty warehouse and offer nothing.
//
// Safe to re-run: each movement carries the deterministic key `receipt:<ticket>`
// under a unique index, so a second pass inserts nothing. That also makes this
// the repair tool for the rare case where the live receipt write failed after
// its entry was already durable.
//
//   node scripts/backfill-stock.mjs                 # report what would be written
//   node scripts/backfill-stock.mjs --write         # actually write it
//   node scripts/backfill-stock.mjs --adopt-names   # see below
//
// An entry with no location or no quantity is skipped and counted: there is
// nowhere to add it, or no amount to add. Those entries stay a record of what
// happened without pretending to be a balance.
//
// --adopt-names
// -------------
// The ledger is per PRODUCT, but a workflow built only from `item_capture`
// records a typed item name and no product at all. On an installation whose
// Product Master is empty, that means every historical entry is unbackfillable
// and the request bot opens on an empty warehouse.
//
// `--adopt-names` creates a Product Master record for each distinct item name
// found in those entries, then posts their receipts against it. It turns the
// free-text history into a catalogue the request bot can actually search.
//
// It is opt-in because it is a data-quality decision, not a migration detail:
// names are what people typed, so "Keyboared" becomes a product exactly as
// spelled. Review the list the dry run prints before committing to it.

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

const WRITE = process.argv.includes("--write");
const ADOPT_NAMES = process.argv.includes("--adopt-names");

// Mirrors lib/products.productNumberKey EXACTLY — this is the value the unique
// index is built on, so a script that normalised differently from the app would
// happily insert a product the app then considers a duplicate.
function productNumberKey(productNumber) {
  return String(productNumber).replace(/\s+/g, "").toUpperCase();
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set.");
  process.exit(1);
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.MONGODB_DB || "inventory");

// The unique index is what makes the re-run safe, so make sure it is there
// before relying on it.
await db.collection("stockMovements").createIndexes([
  { key: { productId: 1, locationId: 1 } },
  { key: { movementKey: 1 }, unique: true, partialFilterExpression: { movementKey: { $type: "string" } } },
  { key: { requestId: 1 } },
  { key: { createdAt: -1 } },
]);

const entries = await db
  .collection("inventoryEntries")
  .find({}, { sort: { createdAt: 1 } })
  .toArray();

// Entries that carry no product but do carry a usable name, location and
// quantity. These are the ones `--adopt-names` can rescue.
const adoptable = [];
const movements = [];
const skipped = { noProduct: 0, noLocation: 0, noQuantity: 0 };

// An entry raised before ticket numbers existed is still a real receipt. Its
// _id is just as stable and just as unique, so it keys the movement instead —
// dropping those entries silently is how the first run of this script reported
// four scanned, zero posted and zero skipped.
function keyFor(entry) {
  const ticket = String(entry.ticketNumber ?? "");
  return ticket ? { movementKey: `receipt:${ticket}`, refId: ticket } : { movementKey: `receipt:id:${entry._id}`, refId: `(entry ${entry._id})` };
}

function movementFor(entry, product) {
  const f = entry.fields ?? {};
  const { movementKey, refId } = keyFor(entry);
  return {
    movementKey,
    productId: String(product.id),
    productName: String(product.name),
    productNumber: String(product.productNumber),
    locationId: String(f.locationId),
    locationPath: String(f.locationPath ?? ""),
    qty: Number(f.quantity),
    unit: String(f.unit ?? ""),
    reason: "receipt",
    refType: "inventoryEntry",
    refId,
    by: String(entry.submittedByName ?? ""),
    // Backdated to the entry, not to now: a ledger that claims every historical
    // receipt landed the day it was migrated is useless for anything that reads
    // it over time.
    createdAt: String(entry.createdAt ?? new Date().toISOString()),
  };
}

for (const e of entries) {
  const f = e.fields ?? {};

  if (!f.locationId) {
    skipped.noLocation++;
    continue;
  }
  const qty = Number(f.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    skipped.noQuantity++;
    continue;
  }

  if (f.productId) {
    movements.push(
      movementFor(e, {
        id: f.productId,
        name: f.productName ?? f.itemName ?? "",
        productNumber: f.productNumber ?? "",
      })
    );
    continue;
  }

  const name = String(f.itemName ?? "").trim();
  if (!name) {
    skipped.noProduct++;
    continue;
  }
  adoptable.push({ entry: e, name });
}

const adoptableNames = [...new Set(adoptable.map((a) => a.name))].sort();

console.log(`Entries scanned:          ${entries.length}`);
console.log(`Receipts to post:         ${movements.length}`);
console.log(`Skipped — no location:    ${skipped.noLocation}`);
console.log(`Skipped — no quantity:    ${skipped.noQuantity}`);
console.log(`Skipped — no item at all: ${skipped.noProduct}`);

if (adoptable.length) {
  console.log(
    `\n${adoptable.length} entr${adoptable.length === 1 ? "y has" : "ies have"} an item name but no product record, ` +
      `covering ${adoptableNames.length} distinct name(s):`
  );
  for (const n of adoptableNames) console.log(`  • ${n}`);
  if (!ADOPT_NAMES) {
    console.log(
      "\n  These cannot be ledgered as they stand — stock is tracked per product.\n" +
        "  Re-run with --adopt-names to create a Product Master record for each of the\n" +
        "  names above and post their receipts against it."
    );
  }
}

// Turn the adoptable entries into real products, then into receipts.
if (ADOPT_NAMES && adoptable.length) {
  const byName = new Map();
  for (const name of adoptableNames) {
    const existing = await db.collection("products").findOne({ name }, { projection: { name: 1, productNumber: 1 } });
    if (existing) {
      byName.set(name, {
        id: existing._id.toString(),
        name: String(existing.name),
        productNumber: String(existing.productNumber ?? ""),
      });
      continue;
    }
    // Visibly synthetic so an admin can find these later and give them a real
    // number. Derived from the name, not a counter, so re-running is stable.
    const productNumber = `AUTO-${name.replace(/[^A-Za-z0-9]+/g, "-").toUpperCase().slice(0, 40)}`;
    const unit = adoptable.find((a) => a.name === name)?.entry?.fields?.unit ?? "";
    const now = new Date().toISOString();
    const doc = {
      name,
      productNumber,
      productNumberKey: productNumberKey(productNumber),
      category: "",
      subcategory: "",
      unit: String(unit),
      desc: "Created automatically from an inventory entry that predates the Product Master.",
      attributes: [],
      status: "Active",
      createdAt: now,
      updatedAt: now,
    };
    if (!WRITE) {
      byName.set(name, { id: `(new) ${productNumber}`, name, productNumber });
      continue;
    }
    const res = await db.collection("products").insertOne(doc);
    byName.set(name, { id: res.insertedId.toString(), name, productNumber });
    console.log(`  + created product ${productNumber} — ${name}`);
  }
  for (const { entry, name } of adoptable) movements.push(movementFor(entry, byName.get(name)));
  console.log(`\nReceipts to post after adoption: ${movements.length}`);
}

if (!WRITE) {
  console.log("\nDry run. Re-run with --write to post these to the ledger.");
  await client.close();
  process.exit(0);
}

let inserted = 0;
if (movements.length) {
  try {
    // Unordered so an already-posted receipt does not stop the ones after it.
    const res = await db.collection("stockMovements").insertMany(movements, { ordered: false });
    inserted = res.insertedCount;
  } catch (err) {
    const dupes = (err.writeErrors ?? []).filter((e) => e.code === 11000).length;
    const other = (err.writeErrors ?? []).filter((e) => e.code !== 11000);
    inserted = err.result?.insertedCount ?? 0;
    if (other.length) {
      console.error(`\n${other.length} movement(s) failed for reasons other than a duplicate:`);
      for (const e of other.slice(0, 5)) console.error(`  ${e.errmsg}`);
      await client.close();
      process.exit(1);
    }
    console.log(`\n${dupes} receipt(s) were already posted and were left alone.`);
  }
}

console.log(`\n✔ Posted ${inserted} receipt(s) to the ledger.`);

// Show the resulting balances so the operator can sanity-check the migration
// against what they know is on the shelves.
const balances = await db
  .collection("stockMovements")
  .aggregate([
    { $group: { _id: { p: "$productId", l: "$locationId" }, name: { $last: "$productName" }, path: { $last: "$locationPath" }, qty: { $sum: "$qty" }, unit: { $last: "$unit" } } },
    { $match: { qty: { $gt: 0 } } },
    { $sort: { name: 1 } },
    { $limit: 25 },
  ])
  .toArray();

console.log(`\nOn hand (first ${balances.length}):`);
for (const b of balances) {
  console.log(`  ${b.name} @ ${b.path || "(unknown)"} — ${b.qty} ${b.unit ?? ""}`.trimEnd());
}

await client.close();
