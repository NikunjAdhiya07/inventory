// Seeds the stock movement vocabulary (`movementTypes`).
//
// Two kinds of row live here:
//   • the CONFIGURED types an organisation records by hand — the Stock In /
//     Stock Out / Stock Transfer lists below. Admins edit these, add their own,
//     and retire the ones they don't use, all from /movement-types.
//   • the SYSTEM types the software writes itself: an entry-bot receipt, a
//     request issue, a storage-map count correction. They are seeded so history
//     and reports can name them like any other type, and they are marked
//     `isSystem` so the manual form never offers them.
//
// Synced by `code` rather than only seeded into an empty collection, so an
// install that predates a type still gets it — the same rule seed-workflows.mjs
// uses for the step library. Admin edits to name/flags are preserved; only
// missing types are added.
//
//   node scripts/seed-movement-types.mjs   (or: npm run seed:movement-types)
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";

// direction: "in" adds at one location, "out" removes from one, "transfer"
// writes a matched pair that sums to zero. requireRemarks / requireReference are
// the per-type mandatory fields; allowNegative is the explicit permission to
// take out more than is on hand.
const movementTypes = [
  // ---- Stock In ----------------------------------------------------------
  { code: "opening-stock", name: "Opening Stock", direction: "in", desc: "One-time go-live: what was already on the shelf. Day-to-day stock-in is the Entries bot (receipt).", requireReference: false, requireRemarks: false, order: 10 },
  {
    code: "new-purchase",
    name: "New Purchase",
    direction: "in",
    desc: "Purchase from a Vendor Master vendor into a storage location. Inventory increases on ticket Accept only when status is Received (Expected / Ordered does not move stock).",
    requireReference: true,
    requireRemarks: false,
    order: 11,
  },
  { code: "return-from-plant", name: "Return from Plant", direction: "in", desc: "Unused material coming back from the plant.", requireReference: false, requireRemarks: false, order: 12 },
  { code: "department-return", name: "Department Return", direction: "in", desc: "Material previously issued to a department, returned to warehouse storage. Increases warehouse stock after ticket Accept.", requireReference: true, requireRemarks: false, order: 14 },
  { code: "warehouse-transfer-in", name: "Warehouse Transfer In", direction: "in", desc: "Arriving from another warehouse that this system does not hold.", requireReference: true, requireRemarks: false, order: 15 },
  { code: "adjustment-in", name: "Inventory Adjustment (+)", direction: "in", desc: "A count correction that adds stock. Say why.", requireReference: false, requireRemarks: true, order: 16 },
  { code: "customer-return", name: "Customer Return", direction: "in", desc: "Goods returned by a customer.", requireReference: false, requireRemarks: false, order: 17 },
  { code: "other-stock-in", name: "Other Stock In", direction: "in", desc: "Anything inward the other types do not cover.", requireReference: false, requireRemarks: true, order: 18 },

  // ---- Stock Out ---------------------------------------------------------
  { code: "issue-to-plant", name: "Issue to Plant", direction: "out", desc: "Material issued to the plant.", requireReference: false, requireRemarks: false, order: 30 },
  { code: "department-issue", name: "Department Issue", direction: "out", desc: "Material issued to a department.", requireReference: false, requireRemarks: false, order: 31 },
  {
    code: "vendor-replacement",
    name: "Vendor Replacement",
    direction: "out",
    desc: "Defective, damaged, incorrect, expired, or rejected goods returned to the vendor for replacement. Decreases warehouse stock; replacement receipt is a separate inbound later.",
    requireReference: true,
    requireRemarks: false,
    order: 38,
  },
  { code: "warehouse-transfer-out", name: "Warehouse Transfer Out", direction: "out", desc: "Sent to another warehouse that this system does not hold.", requireReference: true, requireRemarks: false, order: 32 },
  { code: "damaged-lost", name: "Damaged/Lost", direction: "out", desc: "Written off as damaged or missing. Say what happened.", requireReference: false, requireRemarks: true, order: 33 },
  { code: "expired-disposed", name: "Expired/Disposed", direction: "out", desc: "Past its life and disposed of. Say what happened.", requireReference: false, requireRemarks: true, order: 34 },
  { code: "adjustment-out", name: "Inventory Adjustment (-)", direction: "out", desc: "A count correction that removes stock. Say why.", requireReference: false, requireRemarks: true, order: 35 },
  { code: "customer-dispatch", name: "Customer Dispatch", direction: "out", desc: "Dispatched to a customer against an order.", requireReference: true, requireRemarks: false, order: 36 },
  { code: "other-stock-out", name: "Other Stock Out", direction: "out", desc: "Anything outward the other types do not cover.", requireReference: false, requireRemarks: true, order: 37 },

  // ---- Stock Transfer ----------------------------------------------------
  { code: "warehouse-transfer", name: "Warehouse to Warehouse", direction: "transfer", desc: "Between two sites both held in this system.", requireReference: false, requireRemarks: false, order: 50 },
  { code: "bin-transfer", name: "Location/Bin Transfer", direction: "transfer", desc: "Between two bins, shelves or racks.", requireReference: false, requireRemarks: false, order: 51 },

  // ---- System types (written by the software, never offered on the form) --
  { code: "receipt", name: "Inventory Entry Receipt", direction: "in", desc: "A completed entry in a Telegram entry group.", isSystem: true, order: 70 },
  { code: "purchase-receipt", name: "Purchase Receipt", direction: "in", desc: "A purchase received through the request flow.", isSystem: true, order: 71 },
  { code: "return", name: "Returned to Stock", direction: "in", desc: "An accepted request was cancelled and the items went back.", isSystem: true, order: 72 },
  { code: "issue", name: "Issued on Request", direction: "out", desc: "An Inventory Manager accepted a request and handed items over.", isSystem: true, order: 73 },
  { code: "transfer", name: "Storage Map Transfer", direction: "transfer", desc: "Goods carried between boxes on the storage map.", isSystem: true, order: 74 },
  { code: "adjustment", name: "Stock Count Correction", direction: "adjust", desc: "A box's count set by hand on the storage map.", isSystem: true, order: 75 },
];

function full(t) {
  return {
    code: t.code,
    name: t.name,
    direction: t.direction,
    desc: t.desc ?? "",
    requireRemarks: Boolean(t.requireRemarks),
    requireReference: Boolean(t.requireReference),
    allowNegative: Boolean(t.allowNegative),
    isSystem: Boolean(t.isSystem),
    order: t.order ?? 0,
    status: "Active",
  };
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  let added = 0;
  for (const t of movementTypes) {
    const { isSystem, ...doc } = full(t);
    const now = new Date().toISOString();
    // $setOnInsert, not $set: an admin who renamed "Issue to Plant" or made a
    // reference mandatory must not have that undone by the next deploy's seed.
    // Only `isSystem` is forced, because whether the software writes a type is
    // not an opinion the console gets to hold — and it is kept out of the
    // insert half, since one field cannot be written by both operators.
    const res = await db.collection("movementTypes").updateOne(
      { code: doc.code },
      { $setOnInsert: { ...doc, createdAt: now, updatedAt: now }, $set: { isSystem } },
      { upsert: true }
    );
    if (res.upsertedCount) added++;
  }

  // Business correction: Vendor Replacement is warehouse → vendor (stock out).
  // Earlier seeds marked it as stock-in; force the meaning on existing installs.
  const vr = movementTypes.find((t) => t.code === "vendor-replacement");
  if (vr) {
    const now = new Date().toISOString();
    const { isSystem: _s, ...doc } = full(vr);
    await db.collection("movementTypes").updateOne(
      { code: "vendor-replacement" },
      {
        $set: {
          direction: doc.direction,
          desc: doc.desc,
          requireReference: doc.requireReference,
          requireRemarks: doc.requireRemarks,
          order: doc.order,
          updatedAt: now,
        },
      }
    );
    console.log("movementTypes: vendor-replacement forced to direction=out");
  }

  const dr = movementTypes.find((t) => t.code === "department-return");
  if (dr) {
    const now = new Date().toISOString();
    const { isSystem: _s, ...doc } = full(dr);
    await db.collection("movementTypes").updateOne(
      { code: "department-return" },
      {
        $set: {
          direction: doc.direction,
          desc: doc.desc,
          requireReference: doc.requireReference,
          requireRemarks: doc.requireRemarks,
          order: doc.order,
          updatedAt: now,
        },
      }
    );
    console.log("movementTypes: department-return forced requireReference=true");
  }

  const np = movementTypes.find((t) => t.code === "new-purchase");
  if (np) {
    const now = new Date().toISOString();
    const { isSystem: _s, ...doc } = full(np);
    await db.collection("movementTypes").updateOne(
      { code: "new-purchase" },
      {
        $set: {
          direction: doc.direction,
          desc: doc.desc,
          requireReference: doc.requireReference,
          requireRemarks: doc.requireRemarks,
          order: doc.order,
          updatedAt: now,
        },
      }
    );
    console.log("movementTypes: new-purchase forced direction=in + desc");
  }

  const total = await db.collection("movementTypes").countDocuments();
  console.log(`movementTypes: ${movementTypes.length} synced (${added} new), ${total} in total`);
  await client.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
