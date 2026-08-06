// Fold the flat Categories + Subcategories masters into one adjacency-list tree
// (same shape as Storage Locations). Existing category docs become roots
// (`parent: null`); each subcategory becomes a child node under its parent
// category, linked by id. Product / ticket name strings are left untouched.
//
// The old `subcategories` rows are moved to `subcategories_archived` (not
// deleted) so nothing is lost. Idempotent: safe to re-run.
//
//   node scripts/migrate-category-tree.mjs           # dry run
//   node scripts/migrate-category-tree.mjs --apply   # writes

import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "inventory";
if (!uri) {
  console.error("MONGODB_URI is not set.");
  process.exit(1);
}

const plan = [];
const note = (s) => plan.push(s);

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);
const categories = db.collection("categories");
const subcategories = db.collection("subcategories");
const archived = db.collection("subcategories_archived");

console.log(`DB: ${dbName}   mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

const cats = await categories.find({}).toArray();
const subs = await subcategories.find({}).toArray();

note(`categories in tree: ${cats.length}`);
note(`subcategories still pending: ${subs.length}`);

// ---- 1. Ensure every existing category is a root (parent: null) -------------
let rootsFixed = 0;
for (const c of cats) {
  if (c.parent === undefined) {
    rootsFixed++;
    note(`  set parent:null on root "${c.name}" (${c._id})`);
    if (APPLY) {
      await categories.updateOne(
        { _id: c._id },
        {
          $set: {
            parent: null,
            level: c.level || "Category",
          },
        }
      );
    }
  }
}
note(`roots needing parent:null: ${rootsFixed}`);

// Refresh after potential writes so name→id map is current.
const catsNow = APPLY ? await categories.find({}).toArray() : cats;
const rootByName = new Map();
for (const c of catsNow) {
  if ((c.parent ?? null) === null) rootByName.set(String(c.name), c);
}

// Already-migrated children (idempotency): same name + parent id.
const existingChildren = new Set(
  catsNow
    .filter((c) => c.parent != null && c.parent !== "")
    .map((c) => `${String(c.parent)}::${String(c.name)}`)
);

// ---- 2. Fold each subcategory into categories under its parent id -----------
let inserted = 0;
let skipped = 0;
let orphans = 0;
const toArchive = [];

for (const s of subs) {
  const parentName = String(s.parent ?? "");
  const parent = rootByName.get(parentName);
  if (!parent) {
    orphans++;
    note(`  ORPHAN subcategory "${s.name}" (parent name "${parentName}" not found) — archive only`);
    toArchive.push(s);
    continue;
  }
  const parentId = parent._id.toString();
  const key = `${parentId}::${String(s.name)}`;
  if (existingChildren.has(key) || s.migratedToCategoryId) {
    skipped++;
    note(`  skip already-migrated "${s.name}" under "${parentName}"`);
    toArchive.push(s);
    continue;
  }

  const doc = {
    parent: parentId,
    name: s.name,
    code: s.code || "",
    desc: s.desc || "",
    level: "Subcategory",
    defaultUnit: parent.defaultUnit || "Pieces",
    color: parent.color || "#3392ff",
    order: typeof s.order === "number" ? s.order : 0,
    status: s.status === "Inactive" ? "Inactive" : "Active",
    refCount: typeof s.refCount === "number" ? s.refCount : 0,
    migratedFromSubcategoryId: s._id.toString(),
  };
  inserted++;
  note(`  insert child "${s.name}" → parent "${parentName}" (${parentId})`);
  if (APPLY) {
    const result = await categories.insertOne(doc);
    existingChildren.add(key);
    s.migratedToCategoryId = result.insertedId.toString();
  }
  toArchive.push(s);
}

note(`\nto insert as children: ${inserted}`);
note(`already present / skipped: ${skipped}`);
note(`orphans (no matching root name): ${orphans}`);

// ---- 3. Archive old subcategory rows (preserve, don't destroy) --------------
if (toArchive.length) {
  note(`\narchive ${toArchive.length} subcategory row(s) → subcategories_archived`);
  if (APPLY) {
    const stamped = toArchive.map((s) => ({
      ...s,
      archivedAt: new Date(),
      archiveReason: "migrate-category-tree",
    }));
    // Upsert by original _id so re-runs don't duplicate archives.
    for (const doc of stamped) {
      const { _id, ...rest } = doc;
      await archived.updateOne({ _id }, { $set: { ...rest, _id } }, { upsert: true });
    }
    const ids = toArchive.map((s) => s._id);
    await subcategories.deleteMany({ _id: { $in: ids } });
    note(`removed ${ids.length} rows from subcategories`);
  }
}

// ---- 4. Drop denormalized subCount on roots (children are the source of truth)
if (APPLY) {
  await categories.updateMany({ parent: null }, { $unset: { subCount: "" } });
  note("cleared subCount on roots");
}

console.log("\nPlan:");
for (const line of plan) console.log(line);
console.log(APPLY ? "\nApplied." : "\nDry run only. Re-run with --apply to write.");

await client.close();
