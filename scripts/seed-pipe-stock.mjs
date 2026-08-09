// Seed pipe products across categories + stock at multiple locations so the
// search-group bot can demo: type "pipe" → pick category → pick product →
// pick location → Choose action (Record movement / Request).
//
// Idempotent upserts by productNumber. Safe to re-run.
//
//   npm run seed:pipe-stock
//   node scripts/seed-pipe-stock.mjs
import { MongoClient, ObjectId } from "mongodb";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";
const now = new Date().toISOString();

function product(name, productNumber, extra) {
  return {
    name,
    productNumber,
    productNumberKey: productNumber.replace(/\s+/g, "").toUpperCase(),
    category: "",
    subcategory: "",
    unit: "Meter",
    desc: "",
    attributes: [],
    status: "Active",
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

const PIPES = [
  product("MS Round Pipe 50mm", "PIPE-MS-50", {
    category: "MS Pipe",
    subcategory: "Round",
    unit: "Meter",
    attributes: [
      { name: "Material", value: "Mild Steel" },
      { name: "Size", value: "50 mm" },
      { name: "Grade", value: "IS 2062" },
    ],
    desc: "Mild steel round pipe — common plant stock.",
  }),
  product("MS Square Pipe 40mm", "PIPE-MS-SQ40", {
    category: "MS Pipe",
    subcategory: "Square",
    unit: "Meter",
    attributes: [
      { name: "Material", value: "Mild Steel" },
      { name: "Size", value: "40 mm" },
    ],
  }),
  product("PVC Pressure Pipe 110mm", "PIPE-PVC-110", {
    category: "PVC Pipe",
    subcategory: "Pressure",
    unit: "Meter",
    attributes: [
      { name: "Material", value: "PVC" },
      { name: "Size", value: "110 mm" },
    ],
  }),
  product("PVC Conduit Pipe 25mm", "PIPE-PVC-C25", {
    category: "PVC Pipe",
    subcategory: "Conduit",
    unit: "Meter",
    attributes: [
      { name: "Material", value: "PVC" },
      { name: "Size", value: "25 mm" },
    ],
  }),
  product("GI Pipe Medium 32mm", "PIPE-GI-32", {
    category: "GI Pipe",
    subcategory: "Medium",
    unit: "Meter",
    attributes: [
      { name: "Material", value: "Galvanised Iron" },
      { name: "Size", value: "32 mm" },
    ],
  }),
  product("UPVC Pipe Class B 63mm", "PIPE-UPVC-63", {
    category: "UPVC Pipe",
    subcategory: "Class B",
    unit: "Meter",
    attributes: [
      { name: "Material", value: "UPVC" },
      { name: "Size", value: "63 mm" },
    ],
  }),
];

// qty per location path fragment (matched by name contains)
const STOCK_PLAN = [
  { productNumber: "PIPE-MS-50", stocks: [["Main", 120], ["Plant", 40], ["Store", 25]] },
  { productNumber: "PIPE-MS-SQ40", stocks: [["Main", 80], ["Plant", 15]] },
  { productNumber: "PIPE-PVC-110", stocks: [["Main", 200], ["Yard", 60], ["Plant", 30]] },
  { productNumber: "PIPE-PVC-C25", stocks: [["Main", 500], ["Store", 100]] },
  { productNumber: "PIPE-GI-32", stocks: [["Main", 90], ["Plant", 20], ["Yard", 10]] },
  { productNumber: "PIPE-UPVC-63", stocks: [["Main", 150], ["Yard", 45]] },
];

async function ensureLocations(db) {
  const wanted = ["Main warehouse", "Plant shelf", "Store room", "Yard"];
  const existing = await db.collection("locations").find({ status: { $ne: "Inactive" } }).toArray();
  const byName = new Map(existing.map((l) => [String(l.name).toLowerCase(), l]));
  const out = [...existing];

  for (const [i, name] of wanted.entries()) {
    if (byName.has(name.toLowerCase())) continue;
    const doc = {
      _id: new ObjectId(),
      name,
      parent: null,
      order: 100 + i,
      status: "Active",
      createdAt: now,
      updatedAt: now,
    };
    await db.collection("locations").insertOne(doc);
    out.push(doc);
    byName.set(name.toLowerCase(), doc);
    console.log(`+ location ${name}`);
  }
  return out;
}

function pathOf(loc, byId) {
  const parts = [];
  let cur = loc;
  const seen = new Set();
  while (cur && !seen.has(String(cur._id))) {
    seen.add(String(cur._id));
    parts.unshift(cur.name);
    cur = cur.parent ? byId.get(String(cur.parent)) : null;
  }
  return parts.join(" › ");
}

function findLoc(locations, hint) {
  const h = hint.toLowerCase();
  const exact = locations.find((l) => String(l.name).toLowerCase() === h);
  if (exact) return exact;
  const soft = locations.find((l) => String(l.name).toLowerCase().includes(h));
  if (soft) return soft;
  // Prefer our seeded names
  const preferred = ["main warehouse", "plant shelf", "store room", "yard"];
  for (const p of preferred) {
    if (p.includes(h) || h.includes(p.split(" ")[0])) {
      const hit = locations.find((l) => String(l.name).toLowerCase() === p);
      if (hit) return hit;
    }
  }
  return locations.find((l) => /warehouse|plant|store|yard/i.test(String(l.name))) ?? locations[0];
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const locations = await ensureLocations(db);
  const byId = new Map(locations.map((l) => [String(l._id), l]));

  for (const p of PIPES) {
    const { createdAt, ...fields } = p;
    await db.collection("products").updateOne(
      { productNumberKey: p.productNumberKey },
      { $set: { ...fields, updatedAt: now }, $setOnInsert: { createdAt } },
      { upsert: true }
    );
  }
  console.log(`upserted ${PIPES.length} pipe products`);

  for (const plan of STOCK_PLAN) {
    const prod = await db.collection("products").findOne({ productNumberKey: plan.productNumber.replace(/\s+/g, "").toUpperCase() });
    if (!prod) continue;
    const productId = prod._id.toString();

    for (const [hint, qty] of plan.stocks) {
      const loc = findLoc(locations, hint);
      if (!loc) continue;
      const locationId = loc._id.toString();
      const locationPath = pathOf(loc, byId);
      const key = `seed:pipe:${plan.productNumber}:${locationId}`;

      const exists = await db.collection("stockMovements").findOne({ key });
      if (exists) continue;

      await db.collection("stockMovements").insertOne({
        key,
        productId,
        productName: prod.name,
        productNumber: prod.productNumber,
        locationId,
        locationPath,
        qty,
        unit: prod.unit || "Meter",
        reason: "opening-stock",
        reference: "seed-pipe-stock",
        remarks: "Demo pipe stock for search-group category → location flow",
        by: "seed-pipe-stock",
        at: now,
        createdAt: now,
        movementId: randomUUID(),
      });
      console.log(`  + ${prod.name} @ ${locationPath}: ${qty}`);
    }
  }

  await client.close();
  console.log("done — search “pipe” in a Requests group to try category → location lists");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
