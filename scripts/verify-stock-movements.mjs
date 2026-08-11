// Verification for the Stock Movement module, one check per acceptance
// criterion and one per row of the story's test-case table.
//
// Drives the real HTTP API against a running server and asserts the resulting
// ledger in MongoDB — the balances are re-derived from `stockMovements` exactly
// the way the app derives them, so a check that passes here means the number a
// user sees is the number the ledger holds.
//
// SAFETY: point everything at a throwaway DB via MONGODB_DB.
//
//   MONGODB_DB=inventory_mv_verify node scripts/seed.mjs
//   MONGODB_DB=inventory_mv_verify node scripts/seed-products.mjs
//   MONGODB_DB=inventory_mv_verify node scripts/seed-movement-types.mjs
//   MONGODB_DB=inventory_mv_verify npx next start -p 3010   (separate shell)
//   MONGODB_DB=inventory_mv_verify BASE=http://localhost:3010 node scripts/verify-stock-movements.mjs
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";
const BASE = process.env.BASE || "http://localhost:3000";

if (dbName === "inventory") {
  console.error("Refusing to run against the primary 'inventory' DB. Set MONGODB_DB=inventory_mv_verify.");
  process.exit(2);
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const get = (path) => fetch(BASE + path).then((r) => r.json());
async function send(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (path, body) => send("POST", path, body);
const patch = (path, body) => send("PATCH", path, body);

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  // On-hand computed the way the app computes it: summed from the ledger.
  const onHand = async (productId, locationId) => {
    const rows = await db
      .collection("stockMovements")
      .aggregate([{ $match: { productId, locationId } }, { $group: { _id: null, qty: { $sum: "$qty" } } }])
      .toArray();
    return rows[0]?.qty ?? 0;
  };

  const types = await get("/api/movement-types");
  check("AC-02 · all configured movement types are served", types.length >= 20, `${types.length} types`);
  const inCount = types.filter((t) => t.direction === "in" && !t.isSystem).length;
  const outCount = types.filter((t) => t.direction === "out" && !t.isSystem).length;
  const trCount = types.filter((t) => t.direction === "transfer" && !t.isSystem).length;
  check("AC-02 · in / out / transfer groups all present", inCount >= 9 && outCount >= 8 && trCount >= 2, `in=${inCount} out=${outCount} transfer=${trCount}`);

  // ---- fixtures: one item, two locations -----------------------------------
  const items = await get("/api/stock/lookup?q=");
  check("AC-01 · item lookup returns items (including zero-stock)", items.length > 0, `${items.length} items`);
  const item = items[0];
  const productId = item.productId;

  const locations = (await get("/api/locations")).filter((l) => l.status === "Active");
  const boxes = locations.filter((l) => locations.some((c) => c.parent === l.id) === false).slice(0, 2);
  check("fixtures · two locations available", boxes.length === 2, boxes.map((b) => b.name).join(", "));
  const [A, B] = boxes;

  // Start from a clean ledger for this product so the arithmetic below is exact.
  await db.collection("stockMovements").deleteMany({ productId });

  const record = (typeCode, qty, extra = {}) => post("/api/stock/movements", { typeCode, productId, qty, ...extra });

  // ---- the story's test-case table -----------------------------------------
  let expectedA = 0;
  const stockIn = [
    ["opening-stock", "Record Add to Stock", 100, {}],
    ["new-purchase", "Record New Purchase", 50, { reference: "PO-1099" }],
    ["return-from-plant", "Record Return from Plant", 10, {}],
    ["department-return", "Record Department Return", 7, {}],
    ["warehouse-transfer-in", "Record Warehouse Transfer In", 20, { reference: "WT-IN-3" }],
    ["adjustment-in", "Record Inventory Adjustment (+)", 3, { remarks: "found behind the rack" }],
    ["customer-return", "Record Customer Return", 4, {}],
    ["other-stock-in", "Record Other Stock In", 1, { remarks: "sample from vendor" }],
  ];
  for (const [code, label, qty, extra] of stockIn) {
    const before = await onHand(productId, A.id);
    const res = await record(code, qty, { locationId: A.id, ...extra });
    const after = await onHand(productId, A.id);
    expectedA += qty;
    check(`AC-03 · ${label} → stock increases`, res.status === 201 && after === before + qty, `${before} → ${after}`);
  }
  check("AC-06 · balance matches the sum of every stock-in", (await onHand(productId, A.id)) === expectedA, `on hand ${expectedA}`);

  const stockOut = [
    ["issue-to-plant", "Record Issue to Plant", 12, {}],
    ["department-issue", "Record Department Issue", 8, {}],
    ["vendor-replacement", "Record Vendor Replacement", 5, { reference: "RMA-77" }],
    ["warehouse-transfer-out", "Record Warehouse Transfer Out", 5, { reference: "WT-OUT-9" }],
    ["damaged-lost", "Record Damaged/Lost", 2, { remarks: "crushed in handling" }],
    ["expired-disposed", "Record Expired/Disposed", 1, { remarks: "past shelf life" }],
    ["adjustment-out", "Record Inventory Adjustment (-)", 3, { remarks: "recount short" }],
    ["customer-dispatch", "Record Customer Dispatch", 6, { reference: "SO-4412" }],
    ["other-stock-out", "Record Other Stock Out", 1, { remarks: "given as a sample" }],
  ];
  for (const [code, label, qty, extra] of stockOut) {
    const before = await onHand(productId, A.id);
    const res = await record(code, qty, { locationId: A.id, ...extra });
    const after = await onHand(productId, A.id);
    expectedA -= qty;
    check(`AC-04 · ${label} → stock decreases`, res.status === 201 && after === before - qty, `${before} → ${after}`);
  }

  // ---- transfers -----------------------------------------------------------
  const beforeA = await onHand(productId, A.id);
  const beforeB = await onHand(productId, B.id);
  const move = 15;
  const tr = await record("bin-transfer", move, { fromLocationId: A.id, toLocationId: B.id });
  const afterA = await onHand(productId, A.id);
  const afterB = await onHand(productId, B.id);
  check(
    "AC-05 · Record Warehouse Transfer → stock moves between locations correctly",
    tr.status === 201 && afterA === beforeA - move && afterB === beforeB + move,
    `A ${beforeA}→${afterA}, B ${beforeB}→${afterB}`
  );
  check("AC-05 · a transfer does not change how much exists", beforeA + beforeB === afterA + afterB, `${beforeA + beforeB} total both sides`);

  const w2w = await record("warehouse-transfer", 5, { fromLocationId: B.id, toLocationId: A.id });
  check("AC-05 · Warehouse to Warehouse transfer recorded", w2w.status === 201, String(w2w.body.movement));

  // ---- validation ----------------------------------------------------------
  const available = await onHand(productId, A.id);
  const tooMuch = await record("issue-to-plant", available + 1, { locationId: A.id });
  const unchanged = await onHand(productId, A.id);
  check("AC-08 · issuing more than available is rejected", tooMuch.status === 409, String(tooMuch.body.error));
  check("AC-08 · the rejected movement changed nothing", unchanged === available, `still ${unchanged}`);

  const noRemarks = await record("damaged-lost", 1, { locationId: A.id });
  check("mandatory remarks enforced per type", noRemarks.status === 400, String(noRemarks.body.error));
  const noRef = await record("new-purchase", 1, { locationId: A.id });
  check("mandatory reference enforced per type", noRef.status === 400, String(noRef.body.error));
  const zero = await record("opening-stock", 0, { locationId: A.id });
  check("zero / negative quantity rejected", zero.status === 400, String(zero.body.error));
  const sameBin = await record("bin-transfer", 1, { fromLocationId: A.id, toLocationId: A.id });
  check("transfer to the same location rejected", sameBin.status === 400, String(sameBin.body.error));
  const systemType = await record("receipt", 1, { locationId: A.id });
  check("system types can't be recorded by hand", systemType.status === 400, String(systemType.body.error));

  // allowNegative is the explicit permission in AC-08. Flipped through the API,
  // the way an admin does it — which is also what makes the change take effect
  // immediately rather than at the end of the master-data cache TTL.
  const overdrawn = types.find((t) => t.code === "other-stock-out");
  await patch(`/api/movement-types/${overdrawn.id}`, { allowNegative: true });
  const negative = await record("other-stock-out", available + 50, { locationId: A.id, remarks: "reconciled later" });
  check("AC-08 · a type marked allowNegative may exceed available", negative.status === 201, String(negative.body.error ?? "recorded"));
  check("AC-08 · that movement really did drive the balance negative", (await onHand(productId, A.id)) < 0, String(await onHand(productId, A.id)));
  await patch(`/api/movement-types/${overdrawn.id}`, { allowNegative: false });
  const blockedAgain = await record("other-stock-out", 10_000, { locationId: A.id, remarks: "should be refused now" });
  check("AC-08 · turning the permission back off restores the block", blockedAgain.status === 409, String(blockedAgain.body.error));

  // ---- confirmation + history ---------------------------------------------
  const confirmed = await record("opening-stock", 9, { locationId: B.id });
  check(
    "AC-09 · confirmation names the movement and the resulting balance",
    confirmed.status === 201 && confirmed.body.movement === "Add to Stock" && confirmed.body.balances?.[0]?.qty === (await onHand(productId, B.id)),
    JSON.stringify(confirmed.body.balances)
  );

  const history = await get(`/api/stock/movements?productId=${productId}&limit=500`);
  const ledgerCount = await db.collection("stockMovements").countDocuments({ productId });
  check("AC-07 · every transaction is in the history", history.length === ledgerCount, `${history.length} rows`);
  const detailed = history.find((h) => h.reference === "PO-1099");
  check(
    "AC-07 · movement is recorded with all details",
    Boolean(detailed && detailed.typeName === "New Purchase" && detailed.qty === 50 && detailed.locationPath && detailed.by && detailed.createdAt),
    detailed ? `${detailed.typeName} ${detailed.qty} @ ${detailed.locationPath} by ${detailed.by}` : "not found"
  );
  const transferRow = history.find((h) => h.typeCode === "bin-transfer" && h.qty < 0);
  check("AC-07 · a transfer row names the other end", Boolean(transferRow?.counterpartLocationPath), transferRow?.counterpartLocationPath || "missing");
  const filtered = await get(`/api/stock/movements?productId=${productId}&type=damaged-lost`);
  check("history filters by movement type", filtered.length > 0 && filtered.every((h) => h.typeCode === "damaged-lost"), `${filtered.length} rows`);

  // ---- configurability (the story's future-enhancement direction) ----------
  const custom = await post("/api/movement-types", {
    name: "Scrap to Vendor",
    direction: "out",
    desc: "verification",
    requireReference: true,
  });
  check("custom movement type can be added without code changes", custom.status === 201 && custom.body.code === "scrap-to-vendor", String(custom.body.code));
  const usedCustom = await record("scrap-to-vendor", 2, { locationId: B.id, reference: "SCRAP-1" });
  check("a custom type is immediately recordable", usedCustom.status === 201, String(usedCustom.body.error ?? "recorded"));
  const customHistory = await get(`/api/stock/movements?productId=${productId}&type=scrap-to-vendor`);
  check("a custom type's movements show its name in history", customHistory[0]?.typeName === "Scrap to Vendor", customHistory[0]?.typeName);
  const delUsed = await fetch(`${BASE}/api/movement-types/${custom.body.id}`, { method: "DELETE" });
  check("a type with history can't be deleted", delUsed.status === 409, String((await delUsed.json()).error));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await client.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
