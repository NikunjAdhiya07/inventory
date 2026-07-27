// Reshape the bot's location tree to:
//
//   Canteen            <- the location step opens here
//   ├─ Canteen Inside
//   └─ Canteen Outside
//   Others
//   ├─ 136 (Building)
//   └─ Sci Prec
//
// Everything else is set to status "Inactive" — nothing is deleted, so the old
// tree can be switched back on from the console and historical inventory
// entries keep resolving. Also sets `defaultLocation: "Canteen"` on the active
// workflow's location step and publishes it as a new version.
//
// Idempotent: safe to re-run.
//
//   node scripts/migrate-locations-canteen.mjs           # dry run, prints the plan
//   node scripts/migrate-locations-canteen.mjs --apply   # writes

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

// Root sites that stay reachable in the bot. Everything else is deactivated.
const KEEP_ROOT = "Canteen";
const OTHERS = "Others";
const UNDER_OTHERS = ["136 (Building)", "Sci Prec"];
const CANTEEN_CHILDREN = ["Canteen Inside", "Canteen Outside"];

const plan = [];
const note = (s) => plan.push(s);

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);
const locations = db.collection("locations");

console.log(`DB: ${dbName}   mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

const all = await locations.find({}).toArray();
const byName = (n) => all.find((l) => String(l.name) === n && (l.parent ?? null) === null);

const canteen = byName(KEEP_ROOT);
if (!canteen) {
  console.error(`No root location named "${KEEP_ROOT}". Aborting.`);
  await client.close();
  process.exit(1);
}
const canteenId = canteen._id.toString();

// Everything below a node, following active + inactive alike.
function descendants(rootId) {
  const out = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    for (const l of all) {
      if (String(l.parent ?? "") === id) {
        out.push(l);
        stack.push(l._id.toString());
      }
    }
  }
  return out;
}

// ---- 1. "Others" root -------------------------------------------------------
let others = byName(OTHERS);
if (others) {
  note(`keep existing root "${OTHERS}" (${others._id})`);
} else {
  note(`CREATE root "${OTHERS}" (level Site)`);
}

// ---- 2. Canteen Inside / Outside -------------------------------------------
const canteenKids = all.filter((l) => String(l.parent ?? "") === canteenId);
for (const name of CANTEEN_CHILDREN) {
  const existing = canteenKids.find((l) => String(l.name) === name);
  if (existing) note(`keep "${name}" under Canteen -> ensure Active`);
  else note(`CREATE "${name}" under Canteen (level Area)`);
}
const staleCanteenKids = canteenKids.filter(
  (l) => !CANTEEN_CHILDREN.includes(String(l.name)) && l.status === "Active"
);
for (const l of staleCanteenKids) note(`DEACTIVATE Canteen child "${l.name}"`);

// ---- 3. 136 + Sci Prec under Others ----------------------------------------
const moving = [];
for (const name of UNDER_OTHERS) {
  const node = all.find((l) => String(l.name) === name);
  if (!node) {
    note(`!! "${name}" not found — skipping`);
    continue;
  }
  moving.push(node);
  note(`REPARENT "${name}" -> Others, ensure Active`);
  const kids = descendants(node._id.toString()).filter((l) => l.status === "Active");
  for (const k of kids) note(`  DEACTIVATE descendant "${k.name}" (of ${name})`);
}
const movingIds = new Set(moving.map((m) => m._id.toString()));

// ---- 4. Deactivate every other root and its subtree ------------------------
const otherRoots = all.filter(
  (l) =>
    (l.parent ?? null) === null &&
    l._id.toString() !== canteenId &&
    String(l.name) !== OTHERS &&
    !movingIds.has(l._id.toString())
);
const toDeactivate = [];
for (const r of otherRoots) {
  if (r.status === "Active") toDeactivate.push(r);
  for (const d of descendants(r._id.toString())) if (d.status === "Active") toDeactivate.push(d);
}
for (const l of toDeactivate) note(`DEACTIVATE "${l.name}" (${l.level ?? "?"})`);

console.log("PLAN\n----");
for (const p of plan) console.log("  " + p);

if (!APPLY) {
  console.log(`\n${plan.length} change(s). Re-run with --apply to write.`);
  await client.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
console.log("\nAPPLYING…");

if (!others) {
  const res = await locations.insertOne({
    parent: null,
    name: OTHERS,
    level: "Site",
    code: "",
    capacity: "",
    status: "Active",
    refCount: 0,
  });
  others = { _id: res.insertedId, name: OTHERS };
  console.log(`  created root "${OTHERS}"`);
} else {
  await locations.updateOne({ _id: others._id }, { $set: { status: "Active", parent: null } });
}
const othersId = others._id.toString();

await locations.updateOne({ _id: canteen._id }, { $set: { status: "Active", parent: null } });

for (const name of CANTEEN_CHILDREN) {
  const existing = canteenKids.find((l) => String(l.name) === name);
  if (existing) {
    await locations.updateOne({ _id: existing._id }, { $set: { status: "Active", parent: canteenId } });
  } else {
    await locations.insertOne({
      parent: canteenId,
      name,
      level: "Area",
      code: "",
      capacity: "",
      status: "Active",
      refCount: 0,
    });
    console.log(`  created "${name}"`);
  }
}

if (staleCanteenKids.length) {
  await locations.updateMany(
    { _id: { $in: staleCanteenKids.map((l) => l._id) } },
    { $set: { status: "Inactive" } }
  );
}

for (const node of moving) {
  await locations.updateOne({ _id: node._id }, { $set: { parent: othersId, status: "Active" } });
  const kids = descendants(node._id.toString());
  if (kids.length) {
    await locations.updateMany({ _id: { $in: kids.map((k) => k._id) } }, { $set: { status: "Inactive" } });
  }
}

if (toDeactivate.length) {
  await locations.updateMany(
    { _id: { $in: toDeactivate.map((l) => l._id) } },
    { $set: { status: "Inactive" } }
  );
}

// ---- 5. Point the workflow's location step at Canteen, publish a version ----
const wf = await db.collection("workflows").findOne({ isDefault: true, status: "Active" });
if (!wf) {
  console.log("  !! no active default workflow — skipped the step config update");
} else {
  const steps = (wf.steps ?? []).map((s) =>
    s.type === "location_tree"
      ? { ...s, config: { ...s.config, defaultLocation: KEEP_ROOT } }
      : s
  );
  const locStep = (wf.steps ?? []).find((s) => s.type === "location_tree");
  if (!locStep) {
    console.log("  !! workflow has no location step — nothing to configure");
  } else if (locStep.config?.defaultLocation === KEEP_ROOT) {
    // Already published. Re-running must not churn out identical versions.
    console.log(`  workflow already at defaultLocation="${KEEP_ROOT}" (v${wf.version}) — no new version`);
  } else {
    const nextVersion = (wf.version || 0) + 1;
    await db.collection("workflowVersions").insertOne({
      workflowId: wf._id.toString(),
      version: nextVersion,
      name: String(wf.name ?? ""),
      steps,
      createdAt: new Date().toISOString(),
      createdBy: "migrate-locations-canteen",
    });
    await db.collection("workflows").updateOne(
      { _id: wf._id },
      { $set: { steps, version: nextVersion, updatedAt: new Date().toISOString() } }
    );
    console.log(`  workflow "${wf.name}" -> v${nextVersion} with defaultLocation="${KEEP_ROOT}"`);
  }
}

// ---- 6. Expose the setting in the workflow builder --------------------------
await db.collection("stepLibrary").updateOne(
  { type: "location_tree", "configSchema.key": { $ne: "defaultLocation" } },
  {
    $push: {
      configSchema: {
        key: "defaultLocation",
        label: "Open at (default location)",
        type: "select",
        appliesToDataSource: "locations",
      },
    },
  }
);

// ---- report ----------------------------------------------------------------
const after = await locations.find({ status: "Active" }).sort({ name: 1 }).toArray();
console.log("\nActive tree now:");
const roots = after.filter((l) => (l.parent ?? null) === null);
for (const r of roots) {
  console.log(`  - ${r.name}`);
  for (const k of after.filter((l) => String(l.parent ?? "") === r._id.toString())) {
    console.log(`      - ${k.name}`);
  }
}
console.log(`\n${after.length} active / ${await locations.countDocuments()} total locations.`);

await client.close();
