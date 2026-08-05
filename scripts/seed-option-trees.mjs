// Seeds the nested-category master and a workflow that uses it:
//   optionTrees  — "Wire", a four-level drill-down (+ a second tree so the
//                  match-by-item-name behaviour is visible with more than one)
//   optionNodes  — the options that answer its node levels
//   workflows    — "Wire Entry (Nested)" + its version 1 snapshot
//
// The Wire flow this produces is exactly:
//   1 Item  2 Type of Wire  3 Subcategory of the Wire  4 Colour  5 Size
//   6 Quantity  7 Where it will be used
//
// Idempotent: trees are synced by name and their options rebuilt to match, so
// re-running updates rather than duplicating. Safe to re-run.
//
//   node scripts/seed-option-trees.mjs   (or: npm run seed:option-trees)
import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";

// A tree is its LEVELS — the questions, in the order the bot asks them. Levels
// of input "nodes" are answered from the option forest below and are the only
// ones that drill deeper; "list", "text" and "number" levels ask without
// branching, which is why Colour can be one fixed list instead of being
// repeated under every subcategory.
const trees = [
  {
    name: "Wire",
    desc: "Electrical wire and cable: type, subcategory, colour and size.",
    matches: ["cable", "wiring", "electrical wire"],
    status: "Active",
    levels: [
      { label: "Type of Wire", input: "nodes", options: [], allowOther: false, placeholder: "", min: 0, max: 0 },
      { label: "Subcategory of the Wire", input: "nodes", options: [], allowOther: false, placeholder: "", min: 0, max: 0 },
      {
        label: "Colour",
        input: "list",
        options: ["Red", "Black", "Blue", "Yellow", "Green", "Grey", "White"],
        allowOther: true,
        placeholder: "",
        min: 0,
        max: 0,
      },
      { label: "Size", input: "nodes", options: [], allowOther: true, placeholder: "", min: 0, max: 0 },
    ],
    // The option forest, authored as nested literals and flattened on insert.
    // Depth here lines up with the node levels above: type → subcategory → size.
    nodes: [
      {
        name: "Copper",
        children: [
          { name: "Flexible (FR)", children: ["0.75 sq mm", "1.0 sq mm", "1.5 sq mm", "2.5 sq mm", "4.0 sq mm"] },
          { name: "House Wire", children: ["1.0 sq mm", "1.5 sq mm", "2.5 sq mm"] },
          { name: "Armoured", children: ["2.5 sq mm", "4.0 sq mm", "6.0 sq mm", "10 sq mm"] },
          { name: "Submersible", children: ["1.5 sq mm", "2.5 sq mm", "4.0 sq mm"] },
        ],
      },
      {
        name: "Aluminium",
        children: [
          { name: "Overhead", children: ["16 sq mm", "25 sq mm", "50 sq mm"] },
          { name: "Service Cable", children: ["10 sq mm", "16 sq mm", "25 sq mm"] },
        ],
      },
      {
        name: "Fibre Optic",
        children: [
          { name: "Single-mode", children: ["2 Core", "4 Core", "6 Core", "12 Core"] },
          { name: "Multi-mode", children: ["2 Core", "4 Core", "6 Core"] },
        ],
      },
    ],
  },
  {
    name: "Pipe",
    desc: "Pipe by material, type and diameter — a second tree, to show one workflow serving several items.",
    matches: ["pipes", "tube"],
    status: "Active",
    levels: [
      { label: "Type of Pipe", input: "nodes", options: [], allowOther: false, placeholder: "", min: 0, max: 0 },
      { label: "Subcategory of the Pipe", input: "nodes", options: [], allowOther: false, placeholder: "", min: 0, max: 0 },
      { label: "Diameter", input: "nodes", options: [], allowOther: true, placeholder: "", min: 0, max: 0 },
    ],
    nodes: [
      {
        name: "MS",
        children: [
          { name: "Round", children: ["15 mm", "20 mm", "25 mm", "50 mm", "80 mm"] },
          { name: "Square", children: ["25 mm", "40 mm", "50 mm"] },
        ],
      },
      {
        name: "PVC",
        children: [
          { name: "Plumbing", children: ["15 mm", "20 mm", "25 mm", "40 mm"] },
          { name: "Conduit", children: ["20 mm", "25 mm", "32 mm"] },
        ],
      },
      {
        name: "GI",
        children: [{ name: "Round", children: ["15 mm", "20 mm", "25 mm", "40 mm"] }],
      },
    ],
  },
];

function step(type, label, cfg = {}, required = true, order = 0) {
  return { instanceId: randomUUID(), type, label, required, order, config: cfg };
}

// The seven-step flow, one question at a time. The nested step carries no tree
// name on purpose: it resolves from whatever the user named in step 1, so the
// same workflow asks wire questions for wire and pipe questions for pipe.
function wireWorkflowSteps() {
  return [
    step("item_capture", "What are you adding? Send the item name or a photo.", { requireImage: false }, true, 1),
    step("nested_select", "Tell me more about this item:", { matchItem: true, whenUnmatched: "ask" }, true, 2),
    step("quantity", "Quantity required:", { numberMin: 1, numberMax: 0 }, true, 3),
    step("unit_select", "Select a unit:", { dataSource: "units" }, false, 4),
    step("custom_text", "Where will it be used? (purpose / location)", { placeholder: "e.g. Block B second floor rewiring" }, true, 5),
    step("review_confirm", "Please review your entry:", {}, true, 6),
  ];
}

// Flatten the authored literals into optionNodes rows, parent by parent.
function flattenNodes(treeId, children, parent = null, out = []) {
  children.forEach((child, i) => {
    const node = typeof child === "string" ? { name: child, children: [] } : child;
    const _id = out.length + 1; // placeholder index; real ids are assigned on insert
    out.push({ _idx: _id, treeId, parent, name: node.name, order: i + 1, status: "Active" });
    if (node.children?.length) flattenNodes(treeId, node.children, _id, out);
  });
  return out;
}

async function syncTree(db, tree) {
  const { nodes, ...doc } = tree;
  const now = new Date().toISOString();
  await db.collection("optionTrees").updateOne(
    { name: doc.name },
    { $set: { ...doc, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  const saved = await db.collection("optionTrees").findOne({ name: doc.name });
  const treeId = saved._id.toString();

  // Rebuild the forest for this tree. Options are seed-owned reference data, so
  // replacing them keeps a re-run honest rather than accumulating duplicates.
  await db.collection("optionNodes").deleteMany({ treeId });
  const flat = flattenNodes(treeId, nodes);
  // Parents are stored by placeholder index; insert level by level so a child
  // can reference the real _id of its parent.
  const realId = new Map();
  for (const row of flat) {
    const { _idx, parent, ...rest } = row;
    const res = await db.collection("optionNodes").insertOne({ ...rest, parent: parent === null ? null : realId.get(parent) });
    realId.set(_idx, res.insertedId.toString());
  }
  console.log(`optionTrees: ${doc.name} — ${doc.levels.length} levels, ${flat.length} options`);
  return treeId;
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  for (const tree of trees) await syncTree(db, tree);

  const name = "Wire Entry (Nested)";
  const existing = await db.collection("workflows").findOne({ name });
  if (existing) {
    console.log(`skip workflow "${name}" (already exists)`);
  } else {
    const now = new Date().toISOString();
    const steps = wireWorkflowSteps();
    const wf = await db.collection("workflows").insertOne({
      name,
      desc: "Item → nested drill-down (type, subcategory, colour, size) → quantity → unit → where it will be used.",
      status: "Active",
      version: 1,
      isDefault: false,
      steps,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection("workflowVersions").insertOne({
      workflowId: wf.insertedId.toString(),
      version: 1,
      name,
      steps,
      createdAt: now,
      createdBy: "seed",
    });
    console.log(`seeded workflow "${name}" (v1) — assign it to a group in Workflows → Assign`);
  }

  await client.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
