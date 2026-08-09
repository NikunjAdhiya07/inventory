// End-to-end verification for search-group stock movements (Telegram messages only).
//
// Drives POST /api/telegram/webhook against a REQUEST-mode group: type item name →
// pick item → Record movement → type → location → qty → confirm → ledger updated.
//
// SAFETY: point everything at a throwaway DB via MONGODB_DB.
//
//   TELEGRAM_BOT_TOKEN= MONGODB_DB=inventory_mv_verify npm run dev   (separate shell)
//   MONGODB_DB=inventory_mv_verify node scripts/seed-movement-types.mjs
//   MONGODB_DB=inventory_mv_verify node scripts/verify-move-bot.mjs
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";
const WEBHOOK = process.env.WEBHOOK_URL || "http://localhost:3000/api/telegram/webhook";

if (dbName === "inventory") {
  console.error("Refusing to run against the primary 'inventory' DB. Set MONGODB_DB=inventory_mv_verify.");
  process.exit(2);
}

const STORE_ID = 999999201;
const CHAT = -100889;

let uid = 900000;
const nextUid = () => ++uid;
let msgId = 9100;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function post(update) {
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

const who = (id) => ({ id, first_name: "Store", username: "storemove" });

function sendText(chatId, fromId, text, updateId = nextUid()) {
  return post({
    update_id: updateId,
    message: {
      message_id: ++msgId,
      from: who(fromId),
      chat: { id: chatId, type: "group", title: "Search Group" },
      text,
    },
  });
}

function tap(chatId, fromId, data, anchorId, updateId = nextUid()) {
  return post({
    update_id: updateId,
    callback_query: {
      id: `cbq${nextUid()}`,
      from: who(fromId),
      message: { message_id: anchorId, chat: { id: chatId } },
      data,
    },
  });
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const onHand = async (productId, locationId) => {
    const rows = await db
      .collection("stockMovements")
      .aggregate([{ $match: { productId, locationId } }, { $group: { _id: null, qty: { $sum: "$qty" } } }])
      .toArray();
    return rows[0]?.qty ?? 0;
  };

  // ---- fixtures ------------------------------------------------------------
  await db.collection("roles").updateOne(
    { name: "Store Move" },
    {
      $set: {
        name: "Store Move",
        desc: "verify-move-bot",
        status: "Active",
        perms: ["Request Items", "Issue Inventory", "Add Inventory"],
      },
    },
    { upsert: true }
  );

  await db.collection("users").updateOne(
    { tgId: String(STORE_ID) },
    {
      $set: {
        tgId: String(STORE_ID),
        username: "Store Move",
        handle: "@storemove",
        role: "Store Move",
        status: "Active",
      },
    },
    { upsert: true }
  );

  await db.collection("telegramGroups").updateOne(
    { chatId: String(CHAT) },
    {
      $set: {
        chatId: String(CHAT),
        title: "Search Group",
        approved: true,
        manualInactive: false,
        status: "Active",
        mode: "request",
      },
    },
    { upsert: true }
  );

  const now = new Date().toISOString();
  const product = {
    name: "Verify Move Cable",
    productNumber: "VMC-001",
    category: "Cables",
    subcategory: "USB",
    unit: "pcs",
    status: "Active",
    createdAt: now,
    updatedAt: now,
  };
  const existing = await db.collection("products").findOne({ productNumber: "VMC-001" });
  let productId;
  if (existing) {
    productId = existing._id.toString();
    await db.collection("products").updateOne({ _id: existing._id }, { $set: { status: "Active", name: product.name } });
  } else {
    const ins = await db.collection("products").insertOne(product);
    productId = ins.insertedId.toString();
  }

  // Two leaf locations
  let locA = await db.collection("locations").findOne({ name: "Verify Move A", status: "Active" });
  let locB = await db.collection("locations").findOne({ name: "Verify Move B", status: "Active" });
  if (!locA) {
    const r = await db.collection("locations").insertOne({
      name: "Verify Move A",
      parent: null,
      status: "Active",
      createdAt: now,
      updatedAt: now,
    });
    locA = { _id: r.insertedId, name: "Verify Move A" };
  }
  if (!locB) {
    const r = await db.collection("locations").insertOne({
      name: "Verify Move B",
      parent: null,
      status: "Active",
      createdAt: now,
      updatedAt: now,
    });
    locB = { _id: r.insertedId, name: "Verify Move B" };
  }
  const locAId = locA._id.toString();
  const locBId = locB._id.toString();

  await db.collection("stockMovements").deleteMany({ productId });
  await db.collection("requests").deleteMany({ chatId: String(CHAT), requesterUserId: String(STORE_ID) });

  // Ensure movement types exist
  const ret = await db.collection("movementTypes").findOne({ code: "return-from-plant" });
  check("fixture: return-from-plant type exists", Boolean(ret), "run seed:movement-types");
  const transfer = await db.collection("movementTypes").findOne({ code: "bin-transfer" });
  check("fixture: bin-transfer type exists", Boolean(transfer));

  console.log("\nwaiting out product/stock cache TTL…");
  await new Promise((r) => setTimeout(r, 6_000));

  const draft = () =>
    db.collection("requests").findOne({ chatId: String(CHAT), requesterUserId: String(STORE_ID), status: "draft" });

  // ---- 1. search → intent -------------------------------------------------
  await sendText(CHAT, STORE_ID, "Verify Move Cable");
  let req = await draft();
  check("1. search opens a draft", Boolean(req), `id=${req?._id}`);
  check("1. query stored", req?.ui?.query?.includes("Verify Move"), String(req?.ui?.query));
  let anchor = req?.anchorMessageId;
  check("1. anchor message", typeof anchor === "number", String(anchor));

  // Find product index in results
  await tap(CHAT, STORE_ID, "rq:s:0", anchor);
  req = await draft();
  check("2. product opened (intent screen)", req?.ui?.focusProductId === productId, String(req?.ui?.focusProductId));
  check("2. intent not yet chosen", !req?.ui?.intent);

  // ---- 2. Record movement → Return from Plant ----------------------------
  await tap(CHAT, STORE_ID, "rq:mv:rec", anchor);
  req = await draft();
  check("3. entered move flow", req?.ui?.intent === "move" && req?.ui?.moveStage === "type", JSON.stringify({ intent: req?.ui?.intent, stage: req?.ui?.moveStage }));

  const types = await db
    .collection("movementTypes")
    .find({ status: "Active", isSystem: { $ne: true } })
    .toArray();
  const manual = types.sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name)));
  const flat = [];
  for (const d of ["in", "out", "transfer"]) {
    for (const t of manual.filter((x) => x.direction === d)) flat.push(t);
  }
  const returnIdx = flat.findIndex((t) => t.code === "return-from-plant");
  check("3. return-from-plant in picker", returnIdx >= 0, `idx=${returnIdx}`);

  await tap(CHAT, STORE_ID, `rq:mv:t:${returnIdx}`, anchor);
  req = await draft();
  check("4. type chosen → location", req?.ui?.moveTypeCode === "return-from-plant" && req?.ui?.moveStage === "location", JSON.stringify(req?.ui));

  // Root location A is a leaf — tapping loc:0 should select it if it's first child of root
  const rootChildren = await db
    .collection("locations")
    .find({ status: "Active", $or: [{ parent: null }, { parent: { $exists: false } }] })
    .sort({ name: 1 })
    .toArray();
  const aIdx = rootChildren.findIndex((l) => l._id.toString() === locAId);
  check("4. Verify Move A is a root location", aIdx >= 0, `idx=${aIdx} among ${rootChildren.length}`);

  if (aIdx >= 0) {
    await tap(CHAT, STORE_ID, `rq:mv:loc:${aIdx}`, anchor);
  } else {
    // Drill not needed — use sel after navigating; fallback: set via direct tap if listed
    await tap(CHAT, STORE_ID, "rq:mv:loc:0", anchor);
  }
  req = await draft();
  check("5. location chosen → qty", req?.ui?.moveStage === "qty" && Boolean(req?.ui?.moveLocationId), JSON.stringify({ stage: req?.ui?.moveStage, loc: req?.ui?.moveLocationId }));

  await tap(CHAT, STORE_ID, "rq:mv:q:1", anchor);
  await tap(CHAT, STORE_ID, "rq:mv:q:0", anchor);
  await tap(CHAT, STORE_ID, "rq:mv:q:ok", anchor);
  req = await draft();
  check("6. qty 10 → review", req?.ui?.moveStage === "review" && req?.ui?.moveQtyDraft === "10", JSON.stringify({ stage: req?.ui?.moveStage, qty: req?.ui?.moveQtyDraft }));

  const before = await onHand(productId, req.ui.moveLocationId);
  await tap(CHAT, STORE_ID, "rq:mv:ok", anchor);
  req = await draft();
  check("7. confirmed → done", req?.ui?.moveStage === "done", String(req?.ui?.moveStage));
  const after = await onHand(productId, req.ui.moveLocationId || locAId);
  check("7. stock increased by 10", after === before + 10, `before=${before} after=${after}`);
  const mv = await db.collection("stockMovements").findOne({ productId, reason: "return-from-plant" }, { sort: { createdAt: -1 } });
  check("7. history row written", Boolean(mv) && mv.qty === 10, JSON.stringify(mv && { qty: mv.qty, reason: mv.reason }));

  // ---- 3. oversell blocked ------------------------------------------------
  await tap(CHAT, STORE_ID, "rq:mv:again", anchor);
  req = await draft();
  await sendText(CHAT, STORE_ID, "Verify Move Cable");
  req = await draft();
  anchor = req?.anchorMessageId;
  await tap(CHAT, STORE_ID, "rq:s:0", anchor);
  await tap(CHAT, STORE_ID, "rq:mv:rec", anchor);

  const issueIdx = flat.findIndex((t) => t.code === "issue-to-plant");
  check("8. issue-to-plant in picker", issueIdx >= 0);
  await tap(CHAT, STORE_ID, `rq:mv:t:${issueIdx}`, anchor);
  req = await draft();
  // out uses stock locations — index 0
  await tap(CHAT, STORE_ID, "rq:mv:sl:0", anchor);
  req = await draft();
  await tap(CHAT, STORE_ID, "rq:mv:q:9", anchor);
  await tap(CHAT, STORE_ID, "rq:mv:q:9", anchor);
  await tap(CHAT, STORE_ID, "rq:mv:q:9", anchor);
  await tap(CHAT, STORE_ID, "rq:mv:q:ok", anchor);
  req = await draft();
  const stockBeforeOversell = await onHand(productId, req.ui.moveLocationId);
  await tap(CHAT, STORE_ID, "rq:mv:ok", anchor);
  req = await draft();
  const stockAfterOversell = await onHand(productId, req.ui.moveLocationId);
  check(
    "8. oversell refused (still on review or unchanged stock)",
    stockAfterOversell === stockBeforeOversell && req?.ui?.moveStage !== "done",
    `stage=${req?.ui?.moveStage} stock=${stockAfterOversell}`
  );

  // ---- 4. Request item still available ------------------------------------
  await db.collection("requests").deleteMany({ chatId: String(CHAT), requesterUserId: String(STORE_ID) });
  await sendText(CHAT, STORE_ID, "Verify Move Cable");
  req = await draft();
  anchor = req?.anchorMessageId;
  await tap(CHAT, STORE_ID, "rq:s:0", anchor);
  await tap(CHAT, STORE_ID, "rq:mv:req", anchor);
  req = await draft();
  check("9. Request item enters request path", req?.ui?.intent === "request", String(req?.ui?.intent));
  check("9. shows locations (not move stage)", !req?.ui?.moveStage, String(req?.ui?.moveStage));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await client.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
