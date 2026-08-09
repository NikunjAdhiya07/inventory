// Seeds the Workflow Builder + Telegram bot engine collections:
//   stepLibrary        — the predefined step types (the palette)
//   workflows          — one default workflow reproducing the fixed Story-3 flow
//   workflowVersions   — its immutable snapshot #1
//   telegramGroups     — a couple of groups to assign to
//   workflowAssignments — one group -> default workflow edge
//
// Idempotent: only seeds a collection if it is currently empty. Safe to re-run.
// Run with: node scripts/seed-workflows.mjs   (or: npm run seed:workflows)
import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";

// The step library. `type` is the stable contract shared by the authoring UI,
// this seed, and the bot engine (lib/workflow-engine.ts). `configSchema` drives
// the per-step config modal in the builder.
const stepLibrary = [
  {
    type: "item_capture",
    name: "Item Name & Image",
    desc: "User sends the product name and/or a photo to start the entry.",
    icon: "🏷",
    category: "capture",
    configSchema: [{ key: "requireImage", label: "Require an image", type: "toggle", default: false }],
    order: 1,
    status: "Active",
  },
  {
    type: "product_select",
    name: "Product Select",
    desc: "Pick a product from the Product Master; its attributes are captured with the entry.",
    icon: "❐",
    category: "select",
    configSchema: [
      { key: "dataSource", label: "Product source", type: "dataSource", default: "products", appliesToDataSource: "products" },
      { key: "filterByCategory", label: "Filter by chosen category", type: "toggle", default: false },
    ],
    order: 2,
    status: "Active",
  },
  {
    type: "category_select",
    name: "Category Select",
    desc: "Pick a top-level category from an inline keyboard.",
    icon: "▦",
    category: "select",
    configSchema: [{ key: "dataSource", label: "Category source", type: "dataSource", default: "categories", appliesToDataSource: "categories" }],
    order: 3,
    status: "Active",
  },
  {
    type: "subcategory_select",
    name: "Subcategory Select",
    desc: "Pick a subcategory, optionally filtered by the chosen category.",
    icon: "▩",
    category: "select",
    configSchema: [{ key: "filterByCategory", label: "Filter by chosen category", type: "toggle", default: true }],
    order: 4,
    status: "Active",
  },
  {
    type: "category_tree",
    name: "Category Tree",
    desc: "Drill the Categories master until a leaf — typing “pipe” opens Pipe, then Material → Type → Class → Size.",
    icon: "▤",
    category: "select",
    configSchema: [
      { key: "dataSource", label: "Category source", type: "dataSource", default: "categories", appliesToDataSource: "categories" },
      { key: "matchItem", label: "Open from the item name", type: "toggle", default: true },
      { key: "whenUnmatched", label: "When no category matches", type: "select", options: ["ask", "skip"], default: "ask" },
    ],
    order: 5,
    status: "Active",
  },
  {
    type: "nested_select",
    name: "Nested Category Drill-down",
    desc: "Asks a nested category tree one level at a time — Type of Wire → Subcategory → Colour → Size.",
    icon: "⌸",
    category: "select",
    configSchema: [
      { key: "tree", label: "Nested tree", type: "dataSource", appliesToDataSource: "optionTrees", blankLabel: "Match the item name" },
      { key: "matchItem", label: "Match the tree from the item name", type: "toggle", default: true },
      { key: "whenUnmatched", label: "When no tree matches", type: "select", options: ["skip", "ask"], default: "skip" },
    ],
    order: 6,
    status: "Active",
  },
  {
    type: "location_tree",
    name: "Storage Location",
    desc: "Drill down a Warehouse → Floor → Rack tree to a storage location.",
    icon: "▧",
    category: "select",
    configSchema: [{ key: "dataSource", label: "Location source", type: "dataSource", default: "locations", appliesToDataSource: "locations" }],
    order: 7,
    status: "Active",
  },
  {
    type: "quantity",
    name: "Quantity Entry",
    desc: "Enter a quantity on an inline number keypad.",
    icon: "#",
    category: "capture",
    configSchema: [
      { key: "numberMin", label: "Minimum", type: "number", default: 1 },
      { key: "numberMax", label: "Maximum (0 = no limit)", type: "number", default: 0 },
    ],
    order: 8,
    status: "Active",
  },
  {
    type: "unit_select",
    name: "Unit Select",
    desc: "Pick a unit of measure from an inline keyboard.",
    icon: "⚖",
    category: "select",
    configSchema: [{ key: "dataSource", label: "Unit source", type: "dataSource", default: "units", appliesToDataSource: "units" }],
    order: 9,
    status: "Active",
  },
  {
    type: "custom_text",
    name: "Custom Text Field",
    desc: "A free-form labelled text input.",
    icon: "✎",
    category: "custom",
    configSchema: [{ key: "placeholder", label: "Placeholder / hint", type: "text", default: "" }],
    order: 10,
    status: "Active",
  },
  {
    type: "custom_number",
    name: "Custom Number Field",
    desc: "A labelled numeric input on an inline keypad.",
    icon: "№",
    category: "custom",
    configSchema: [
      { key: "numberMin", label: "Minimum", type: "number", default: 0 },
      { key: "numberMax", label: "Maximum (0 = no limit)", type: "number", default: 0 },
    ],
    order: 11,
    status: "Active",
  },
  {
    type: "approval",
    name: "Approval Step",
    desc: "Routes the entry to a role for approval before continuing.",
    icon: "✔",
    category: "control",
    configSchema: [
      { key: "approvalMode", label: "Approval mode", type: "select", options: ["single", "multi"], default: "single" },
      { key: "approverRole", label: "Approver role", type: "select", default: "Admin", appliesToDataSource: "roles" },
    ],
    order: 12,
    status: "Active",
  },
  {
    type: "review_confirm",
    name: "Review & Confirm",
    desc: "Shows a summary and asks the user to confirm or cancel.",
    icon: "☑",
    category: "control",
    configSchema: [],
    order: 13,
    status: "Active",
  },
];

// Build one step instance for the default workflow.
function step(type, label, config = {}, required = true, order = 0) {
  return { instanceId: randomUUID(), type, label, required, order, config };
}

// The default workflow: item → category tree (matched from the name) → location → qty → unit → review.
function defaultSteps() {
  return [
    step("item_capture", "Send the item name and/or a photo of the product.", { requireImage: false }, true, 1),
    step(
      "category_tree",
      "Choose the category:",
      { dataSource: "categories", matchItem: true, whenUnmatched: "ask" },
      true,
      2
    ),
    step("location_tree", "Choose the storage location:", { dataSource: "locations" }, true, 3),
    step("quantity", "Enter the quantity:", { numberMin: 1, numberMax: 0 }, true, 4),
    step("unit_select", "Select a unit:", { dataSource: "units" }, true, 5),
    step("review_confirm", "Please review your entry:", {}, true, 6),
  ];
}

// Seeded by an admin, so approved — the bot refuses any group without it.
const telegramGroups = [
  { chatId: "-1001111111111", title: "Main Inventory Group", status: "Active", approved: true },
  { chatId: "-1002222222222", title: "High-Value Items Group", status: "Active", approved: true },
];

async function seedEmpty(db, collection, docs) {
  const count = await db.collection(collection).countDocuments();
  if (count > 0) {
    console.log(`skip ${collection} (already has ${count} docs)`);
    return false;
  }
  if (docs.length) await db.collection(collection).insertMany(docs);
  console.log(`seeded ${collection}: ${docs.length} docs`);
  return true;
}

// The step library is the palette the builder renders, and it is owned by this
// seed rather than by any console screen — so it is synced by `type` instead of
// only being written into an empty collection. Without this, an install that was
// seeded before a step type existed would never see the new one.
async function syncStepLibrary(db) {
  let added = 0;
  for (const entry of stepLibrary) {
    const res = await db.collection("stepLibrary").updateOne({ type: entry.type }, { $set: entry }, { upsert: true });
    if (res.upsertedCount) added++;
  }
  console.log(`stepLibrary: ${stepLibrary.length} step types synced (${added} new)`);
}

// Replace legacy category_select + subcategory_select with category_tree so
// existing installs get the Pipe → Material → Type → … drill-down without a
// manual rebuild. Only rewrites workflows that still use that exact pair and
// do not already include category_tree.
async function migrateCategoryTreeSteps(db) {
  const workflows = await db.collection("workflows").find({}).toArray();
  let updated = 0;
  for (const wf of workflows) {
    const steps = Array.isArray(wf.steps) ? [...wf.steps] : [];
    if (steps.some((s) => s.type === "category_tree")) continue;
    const catIdx = steps.findIndex((s) => s.type === "category_select");
    const subIdx = steps.findIndex((s) => s.type === "subcategory_select");
    if (catIdx < 0) continue;

    const treeStep = step(
      "category_tree",
      "Choose the category:",
      { dataSource: "categories", matchItem: true, whenUnmatched: "ask" },
      true,
      steps[catIdx].order ?? catIdx + 1
    );
    const remove = new Set([catIdx, subIdx].filter((i) => i >= 0));
    const next = steps.filter((_, i) => !remove.has(i));
    next.splice(Math.min(catIdx, next.length), 0, treeStep);
    next.forEach((s, i) => {
      s.order = i + 1;
    });

    const now = new Date().toISOString();
    const version = Number(wf.version || 1) + 1;
    await db.collection("workflows").updateOne(
      { _id: wf._id },
      {
        $set: {
          steps: next,
          version,
          updatedAt: now,
          desc: wf.desc || "Guided flow with category tree drill-down from the item name.",
        },
      }
    );
    await db.collection("workflowVersions").insertOne({
      workflowId: wf._id.toString(),
      version,
      name: wf.name,
      steps: next,
      createdAt: now,
      createdBy: "seed:category_tree",
    });
    updated++;
    console.log(`migrated workflow "${wf.name}" → category_tree (v${version})`);
  }
  if (!updated) console.log("skip category_tree migration (nothing to rewrite)");
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  await syncStepLibrary(db);
  await seedEmpty(db, "telegramGroups", telegramGroups);

  // Workflow + its version snapshot + a group assignment, seeded together so the
  // webhook resolves out of the box. Only runs when there are no workflows yet.
  const wfCount = await db.collection("workflows").countDocuments();
  if (wfCount === 0) {
    const now = new Date().toISOString();
    const steps = defaultSteps();
    const wf = await db.collection("workflows").insertOne({
      name: "Standard Inventory Entry",
      desc: "The default guided flow: item → category tree → location → quantity → unit → review.",
      status: "Active",
      version: 1,
      isDefault: true,
      steps,
      createdAt: now,
      updatedAt: now,
    });
    const workflowId = wf.insertedId.toString();
    await db.collection("workflowVersions").insertOne({
      workflowId,
      version: 1,
      name: "Standard Inventory Entry",
      steps,
      createdAt: now,
      createdBy: "seed",
    });
    // Assign the default workflow to the Main Inventory Group.
    await db.collection("workflowAssignments").insertOne({
      workflowId,
      scope: "group",
      chatId: "-1001111111111",
      priority: 0,
      status: "Active",
      createdAt: now,
    });
    console.log("seeded workflows: 1 default workflow + version 1 snapshot + 1 group assignment");
  } else {
    console.log(`skip workflows (already has ${wfCount} docs)`);
    await migrateCategoryTreeSteps(db);
  }

  await client.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
