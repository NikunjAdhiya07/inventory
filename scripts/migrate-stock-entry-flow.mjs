/**
 * Migrate Standard Inventory Entry to the redesigned stock-entry flow, ensure
 * Canteen Inside has Rack 1–21 (with shelves), and add common packing units.
 *
 *   node scripts/migrate-stock-entry-flow.mjs
 */
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { MongoClient } from "mongodb";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")];
    })
);

function step(type, label, config = {}, required = true, order = 0) {
  return { instanceId: randomUUID(), type, label, required, order, config };
}

function buildSteps() {
  return [
    step("item_capture", "Send a photo or type the product name", { requireImage: false }, true, 1),
    step(
      "stock_type",
      "What kind of stock entry is this?",
      { options: ["Add Stock", "Opening Stock"], optionValues: ["add-stock", "opening-stock"] },
      true,
      2
    ),
    step("category_select", "Select the category:", { dataSource: "categories" }, true, 3),
    step(
      "subcategory_select",
      "Select the subcategory:",
      { dataSource: "categories", filterByCategory: true },
      true,
      4
    ),
    step(
      "location_tree",
      "📍 Choose Location → Rack → Shelf:",
      { dataSource: "locations", flatSelect: false, allowSelectBranch: false },
      true,
      5
    ),
    step("pack_quantity", "How is this packed?", { numberMin: 1, numberMax: 0, dataSource: "units" }, true, 6),
    step("review_confirm", "📋 Review", {}, true, 7),
  ];
}

const STEP_LIBRARY_EXTRAS = [
  {
    type: "stock_type",
    name: "Stock Type",
    desc: "Ask whether this is Add Stock or Opening Stock.",
    icon: "⇄",
    category: "select",
    configSchema: [
      { key: "options", label: "Choices (comma-separated labels)", type: "text", default: "Add Stock, Opening Stock" },
    ],
    order: 3,
    status: "Active",
  },
  {
    type: "pack_quantity",
    name: "Pack Quantity",
    desc: "Number of units × packing unit × optional size/capacity per unit (e.g. 6 Bottle × 500 ml).",
    icon: "📦",
    category: "capture",
    configSchema: [
      { key: "numberMin", label: "Minimum units", type: "number", default: 1 },
      { key: "numberMax", label: "Maximum units (0 = no limit)", type: "number", default: 0 },
      { key: "dataSource", label: "Unit source", type: "dataSource", default: "units", appliesToDataSource: "units" },
    ],
    order: 10,
    status: "Active",
  },
];

async function main() {
  const c = new MongoClient(env.MONGODB_URI);
  await c.connect();
  const db = c.db(env.MONGODB_DB || "inventory");
  const now = new Date().toISOString();

  for (const entry of STEP_LIBRARY_EXTRAS) {
    await db.collection("stepLibrary").updateOne({ type: entry.type }, { $set: entry }, { upsert: true });
  }
  console.log("stepLibrary: stock_type + pack_quantity synced");

  const steps = buildSteps();
  const workflows = await db
    .collection("workflows")
    .find({ status: "Active", name: /Inventory Entry|Add to Stock/i })
    .toArray();
  for (const wf of workflows) {
    const version = Number(wf.version || 1) + 1;
    await db.collection("workflows").updateOne(
      { _id: wf._id },
      {
        $set: {
          steps,
          version,
          updatedAt: now,
          desc:
            "Photo/name → confirm exact product → Stock Type → Category → Subcategory → Location → Rack → Shelf → pack quantity → Review.",
        },
      }
    );
    await db.collection("workflowVersions").insertOne({
      workflowId: wf._id.toString(),
      version,
      name: wf.name,
      steps,
      createdAt: now,
      createdBy: "migrate:stock-entry-flow",
    });
    console.log(`workflow "${wf.name}" → v${version}`);
  }

  // Units used by pack quantity
  for (const name of ["Bottle", "Packet", "Milliliter"]) {
    const exists = await db.collection("units").findOne({ name: new RegExp(`^${name}$`, "i") });
    if (exists) continue;
    await db.collection("units").insertOne({
      name,
      symbol: name === "Milliliter" ? "ml" : "",
      status: "Active",
      createdAt: now,
      updatedAt: now,
    });
    console.log(`unit added: ${name}`);
  }

  // Ensure Canteen Inside has Rack 1..21 with Shelf 1..6 each
  const inside = await db.collection("locations").findOne({ name: "Canteen Inside", status: "Active" });
  if (!inside) {
    console.log("skip racks — Canteen Inside not found");
  } else {
    const parentId = inside._id.toString();
    const existing = await db
      .collection("locations")
      .find({ parent: parentId, status: "Active" })
      .project({ name: 1, level: 1 })
      .toArray();
    const byName = new Map(existing.map((l) => [String(l.name).toLowerCase(), l]));

    for (let n = 1; n <= 21; n++) {
      const rackName = `Rack ${n}`;
      let rack = byName.get(rackName.toLowerCase());
      if (!rack) {
        const res = await db.collection("locations").insertOne({
          name: rackName,
          code: `CI-R${String(n).padStart(2, "0")}`,
          level: "Rack",
          parent: parentId,
          status: "Active",
          order: n,
          createdAt: now,
          updatedAt: now,
        });
        rack = { _id: res.insertedId, name: rackName };
        console.log(`rack created: ${rackName}`);
      }
      const rackId = rack._id.toString();
      const shelves = await db
        .collection("locations")
        .find({ parent: rackId, status: "Active" })
        .project({ name: 1 })
        .toArray();
      const shelfNames = new Set(shelves.map((s) => String(s.name).toLowerCase()));
      for (let s = 1; s <= 6; s++) {
        const shelfName = `Shelf ${s}`;
        if (shelfNames.has(shelfName.toLowerCase())) continue;
        await db.collection("locations").insertOne({
          name: shelfName,
          code: `CI-R${String(n).padStart(2, "0")}-S${s}`,
          level: "Shelf",
          parent: rackId,
          status: "Active",
          order: s,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    console.log("Canteen Inside: Rack 1–21 with Shelf 1–6 ready");
  }

  await c.close();
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
