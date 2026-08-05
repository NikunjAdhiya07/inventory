// End-to-end verification harness for the Material Issue / Return bot.
//
// Drives the running Next.js webhook (POST /api/telegram/webhook) exactly the
// way Telegram would — with curl-style JSON updates — and asserts the resulting
// ticket and stock-ledger state in MongoDB. No live Telegram is involved: run
// the dev server with an EMPTY TELEGRAM_BOT_TOKEN so lib/telegram.ts uses its
// console stub and nothing is ever posted to a real group.
//
// The scenario is the one the flow was built for:
//
//   store head issues 5 wire + 7 screws to Vijay   → ISS-…  stock out
//   Vijay acknowledges                              → ISS-…  acknowledged
//   Vijay returns 2 wire, consumes the rest         → RET-…  nothing moves yet
//   store head accepts the return                   → RET-…  stock in
//                                                     ISS-…  settled 2 back / 3 used
//
// It runs in an ENTRY-mode group on purpose. The whole point of the overlay is
// that one chat carries both workflows, so the checks below prove the handover
// lifecycle works there AND that plain messages still start an inventory entry
// exactly as they did before — including while a handover is half-built.
//
// SAFETY: point everything at a throwaway DB via MONGODB_DB (e.g.
// `inventory_verify`) so real inventory data is never touched.
//
// Usage (from inventory/):
//   TELEGRAM_BOT_TOKEN= MONGODB_DB=inventory_verify npm run dev   (separate shell)
//   MONGODB_DB=inventory_verify node scripts/verify-issue-bot.mjs
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";
const WEBHOOK = process.env.WEBHOOK_URL || "http://localhost:3000/api/telegram/webhook";

if (dbName === "inventory") {
  console.error("Refusing to run against the primary 'inventory' DB. Set MONGODB_DB=inventory_verify.");
  process.exit(2);
}

// ---- test identities -------------------------------------------------------
const STORE_ID = 999999101; // the store head — holds "Issue Inventory"
const VIJAY_ID = 999999102; // the maintenance worker the materials go to
const CHAT = -100888; // ONE group, running the entry workflow and this overlay

let uid = 800000;
const nextUid = () => ++uid;

// ---- results ---------------------------------------------------------------
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---- webhook drivers -------------------------------------------------------
async function post(update) {
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

let msgId = 9000;
const who = (id) =>
  id === STORE_ID
    ? { id, first_name: "Store", username: "storehead" }
    : { id, first_name: "Vijay", username: "vijay" };

function sendText(chatId, fromId, text, updateId = nextUid()) {
  return post({
    update_id: updateId,
    message: {
      message_id: ++msgId,
      from: who(fromId),
      chat: { id: chatId, type: "group", title: "Store Group" },
      text,
    },
  });
}

// Callbacks must carry the anchor message id: the flow resolves which ticket a
// button belongs to from the message it is attached to, never from the chat.
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

  const issueDoc = (q = {}) =>
    db.collection("issueTickets").findOne({ chatId: String(CHAT), kind: "issue", ...q }, { sort: { updatedAt: -1 } });
  const returnDoc = (q = {}) =>
    db.collection("issueTickets").findOne({ chatId: String(CHAT), kind: "return", ...q }, { sort: { updatedAt: -1 } });

  // On-hand read straight from the ledger, the same way lib/stock.onHandLive
  // does — deliberately not through the app's cache, so an assertion can never
  // pass on a stale balance.
  async function onHand(productId, locationId) {
    const rows = await db
      .collection("stockMovements")
      .aggregate([{ $match: { productId, locationId } }, { $group: { _id: null, qty: { $sum: "$qty" } } }])
      .toArray();
    return rows[0]?.qty ?? 0;
  }

  // ---------------- fixtures ----------------
  const now = new Date().toISOString();

  await db.collection("roles").updateOne(
    { name: "Store Head" },
    { $set: { name: "Store Head", desc: "verify-issue-bot", status: "Active", perms: ["Issue Inventory", "Add Inventory"] } },
    { upsert: true }
  );
  // Deliberately powerless: Vijay must be able to acknowledge and return with no
  // inventory permission at all. If this test ever needs to grant him one, the
  // flow has locked out the people its tickets are addressed to. It also proves
  // the overlay bypasses the entry group's "Add Inventory" gate — which Vijay
  // does not hold — without opening that gate to anything else.
  await db.collection("roles").updateOne(
    { name: "Maintenance" },
    { $set: { name: "Maintenance", desc: "verify-issue-bot", status: "Active", perms: [] } },
    { upsert: true }
  );
  await db.collection("users").updateOne(
    { tgId: String(STORE_ID) },
    { $set: { tgId: String(STORE_ID), username: "Store Head", handle: "@storehead", role: "Store Head", status: "Active" } },
    { upsert: true }
  );
  await db.collection("users").updateOne(
    { tgId: String(VIJAY_ID) },
    { $set: { tgId: String(VIJAY_ID), username: "Vijay", handle: "@vijay", role: "Maintenance", status: "Active" } },
    { upsert: true }
  );

  await db.collection("issueTickets").deleteMany({ chatId: String(CHAT) });
  await db.collection("botSessions").deleteMany({ chatId: String(CHAT) });
  await db.collection("telegramGroups").deleteMany({ chatId: String(CHAT) });
  await db.collection("telegramGroups").insertOne({
    chatId: String(CHAT),
    title: "Store Group",
    status: "Active",
    approved: true,
    manualInactive: false,
    // The ORIGINAL workflow's mode. Nothing about this group says "issues" —
    // that is the point: the overlay has to work here without being configured.
    mode: "entry",
    botHealth: "unknown",
    source: "verify",
    createdAt: now,
  });

  // A location and two materials with stock on the shelf.
  await db.collection("locations").deleteMany({ name: "Verify Store A" });
  const locRes = await db
    .collection("locations")
    .insertOne({ name: "Verify Store A", parent: null, status: "Active", order: 9999, createdAt: now });
  const locId = locRes.insertedId.toString();

  const products = [
    { name: "Wire Bundle", productNumber: "VZ-WIRE-1", unit: "bundle", stock: 20 },
    { name: "Screw", productNumber: "VZ-SCREW-1", unit: "pcs", stock: 50 },
  ];
  const seeded = [];
  for (const p of products) {
    await db.collection("products").deleteMany({ productNumber: p.productNumber });
    const res = await db.collection("products").insertOne({
      name: p.name,
      productNumber: p.productNumber,
      productNumberKey: p.productNumber.toLowerCase().replace(/[^a-z0-9]/g, ""),
      category: "Verify",
      subcategory: "",
      unit: p.unit,
      desc: "",
      attributes: [],
      status: "Active",
      createdAt: now,
      updatedAt: now,
    });
    const productId = res.insertedId.toString();
    await db.collection("stockMovements").deleteMany({ productId });
    await db.collection("stockMovements").insertOne({
      movementKey: `receipt:VERIFY-${p.productNumber}`,
      productId,
      productName: p.name,
      productNumber: p.productNumber,
      locationId: locId,
      locationPath: "Verify Store A",
      qty: p.stock,
      unit: p.unit,
      reason: "receipt",
      refType: "inventoryEntry",
      refId: `VERIFY-${p.productNumber}`,
      by: "verify",
      createdAt: now,
    });
    seeded.push({ ...p, productId });
  }
  const wire = seeded[0];
  const screw = seeded[1];

  check("fixture: wire on hand = 20", (await onHand(wire.productId, locId)) === 20);
  check("fixture: screws on hand = 50", (await onHand(screw.productId, locId)) === 50);

  // The bot's product and stock reads are cached for a few seconds. Everything
  // above was written straight to Mongo behind its back, so give the caches
  // their TTL before the first search rather than racing them.
  console.log("\nwaiting out the product/stock cache TTL…");
  await new Promise((r) => setTimeout(r, 31_000));

  // ---------------- 0. the ORIGINAL workflow still owns plain messages ----------------
  // This runs first and deliberately: if the overlay had taken plain text over,
  // everything the entry bot was built for would be broken and every check below
  // would still pass.
  await sendText(CHAT, STORE_ID, "PVC T Pipe");
  const entrySession = await db
    .collection("botSessions")
    .findOne({ chatId: String(CHAT), userId: String(STORE_ID) }, { sort: { updatedAt: -1 } });
  check("0. plain text still starts an inventory entry", Boolean(entrySession), `session=${entrySession?._id ?? "none"}`);
  check("0. plain text did NOT open a handover", !(await issueDoc()), "no issue ticket expected");

  // ---------------- 1. store head opens a handover with /issue ----------------
  await sendText(CHAT, STORE_ID, "/issue wire");
  let iss = await issueDoc();
  check("1. /issue opens a handover draft", iss?.status === "draft" && iss?.ui?.query === "wire", `status=${iss?.status} query=${iss?.ui?.query}`);
  check("1. draft is authored by the store head", iss?.createdByUserId === String(STORE_ID));
  let anchor = iss?.anchorMessageId;
  check("1. draft has an anchor message", typeof anchor === "number", String(anchor));
  check("1. the open entry session was left alone", Boolean(await db.collection("botSessions").findOne({ _id: entrySession?._id })), "still there");

  await tap(CHAT, STORE_ID, "is:s:0", anchor);
  iss = await issueDoc();
  check("2. product opened", iss?.ui?.focusProductId === wire.productId, String(iss?.ui?.focusProductId));

  await tap(CHAT, STORE_ID, "is:l:0", anchor);
  iss = await issueDoc();
  check("3. location chosen", iss?.ui?.focusLocationId === locId, String(iss?.ui?.focusLocationId));

  await tap(CHAT, STORE_ID, "is:q:5", anchor);
  await tap(CHAT, STORE_ID, "is:q:ok", anchor);
  iss = await issueDoc();
  check("4. 5 wire added to the cart", iss?.lines?.length === 1 && iss.lines[0].qty === 5, JSON.stringify(iss?.lines?.map((l) => `${l.productName}×${l.qty}`)));

  // Plain text WHILE a handover draft is open belongs to the cart, not to a new
  // inventory entry — the author opened the draft themselves, so following that
  // intent is not a guess. This is the one case where the overlay takes a plain
  // message, and check 5b proves it hands the group straight back afterwards.
  const sessionsBefore = await db.collection("botSessions").countDocuments({ chatId: String(CHAT) });
  await sendText(CHAT, STORE_ID, "screw");
  iss = await issueDoc();
  check("5. typing while a draft is open searches the cart", iss?.ui?.query === "screw", `query=${iss?.ui?.query}`);
  check(
    "5. …and does not open a rival inventory entry",
    (await db.collection("botSessions").countDocuments({ chatId: String(CHAT) })) === sessionsBefore,
    `sessions=${sessionsBefore}`
  );

  await tap(CHAT, STORE_ID, "is:s:0", anchor);
  await tap(CHAT, STORE_ID, "is:l:0", anchor);
  await tap(CHAT, STORE_ID, "is:q:7", anchor);
  await tap(CHAT, STORE_ID, "is:q:ok", anchor);
  iss = await issueDoc();
  check("5b. 7 screws added to the cart", iss?.lines?.length === 2 && iss.lines[1].qty === 7, JSON.stringify(iss?.lines?.map((l) => `${l.productName}×${l.qty}`)));

  // ---------------- 2. cannot issue without a recipient ----------------
  await tap(CHAT, STORE_ID, "is:sub", anchor);
  iss = await issueDoc();
  check("6. submit refused with no recipient", iss?.status === "draft" && !iss?.ticketNumber, `status=${iss?.status} ticket=${iss?.ticketNumber}`);

  await tap(CHAT, STORE_ID, "is:who", anchor);
  await sendText(CHAT, STORE_ID, "Vijay");
  iss = await issueDoc();
  check("7. recipient picker filters on typed name", iss?.ui?.stage === "who" && iss?.ui?.whoQuery === "Vijay", `stage=${iss?.ui?.stage} q=${iss?.ui?.whoQuery}`);

  await tap(CHAT, STORE_ID, "is:u:0", anchor);
  iss = await issueDoc();
  check("8. Vijay chosen as recipient", iss?.recipient?.userId === String(VIJAY_ID), JSON.stringify(iss?.recipient));

  // ---------------- 3. issue: stock leaves ----------------
  const submitUid = nextUid();
  await tap(CHAT, STORE_ID, "is:sub", anchor, submitUid);
  iss = await issueDoc();
  check("9. issued → awaiting acknowledgement", iss?.status === "awaiting_ack", `status=${iss?.status}`);
  check("9. ISS ticket number assigned", /^ISS-\d{6}-/.test(String(iss?.ticketNumber)), String(iss?.ticketNumber));
  check("9. both lines marked issued", iss?.lines?.every((l) => l.outcome === "issued"), JSON.stringify(iss?.lines?.map((l) => l.outcome)));
  check("10. wire deducted 20 → 15", (await onHand(wire.productId, locId)) === 15, String(await onHand(wire.productId, locId)));
  check("10. screws deducted 50 → 43", (await onHand(screw.productId, locId)) === 43, String(await onHand(screw.productId, locId)));

  // A redelivered update must not deduct a second time.
  await tap(CHAT, STORE_ID, "is:sub", anchor, submitUid);
  check("11. replayed submit does not double-deduct", (await onHand(wire.productId, locId)) === 15, String(await onHand(wire.productId, locId)));

  // ---------------- 4. acknowledgement is the recipient's alone ----------------
  await tap(CHAT, STORE_ID, "is:ack", anchor);
  iss = await issueDoc();
  check("12. store head cannot acknowledge on Vijay's behalf", iss?.status === "awaiting_ack", `status=${iss?.status}`);

  await tap(CHAT, VIJAY_ID, "is:ack", anchor);
  iss = await issueDoc();
  check("13. Vijay acknowledges → acknowledged", iss?.status === "acknowledged", `status=${iss?.status}`);
  check("13. acknowledgement is timestamped", Boolean(iss?.acknowledgedAt), String(iss?.acknowledgedAt));

  // ---------------- 5. the return ----------------
  await tap(CHAT, STORE_ID, "is:ret", anchor);
  check("14. store head cannot open Vijay's return", !(await returnDoc()), "none expected");

  await tap(CHAT, VIJAY_ID, "is:ret", anchor);
  let ret = await returnDoc();
  check("15. return draft opened against the issue", ret?.status === "draft" && ret?.issueTicketNumber === iss?.ticketNumber, `status=${ret?.status} parent=${ret?.issueTicketNumber}`);
  check("15. return seeded with both issued lines at zero", ret?.lines?.length === 2 && ret.lines.every((l) => l.qty === 0), JSON.stringify(ret?.lines?.map((l) => `${l.productName}:${l.qty}/${l.issuedQty}`)));
  const retAnchor = ret?.anchorMessageId;
  check("15. return has its own anchor message", typeof retAnchor === "number" && retAnchor !== anchor, `${retAnchor} vs ${anchor}`);

  const wireLineId = ret.lines.find((l) => l.productName === "Wire Bundle").lineId;
  await tap(CHAT, VIJAY_ID, `is:rl:${wireLineId}`, retAnchor);
  await tap(CHAT, VIJAY_ID, "is:rq:2", retAnchor);
  await tap(CHAT, VIJAY_ID, "is:rq:ok", retAnchor);
  ret = await returnDoc();
  check("16. 2 wire set as coming back", ret?.lines?.find((l) => l.lineId === wireLineId)?.qty === 2, JSON.stringify(ret?.lines?.map((l) => `${l.productName}:${l.qty}`)));

  // Over-returning is the mistake this flow most has to catch.
  await tap(CHAT, VIJAY_ID, `is:rl:${wireLineId}`, retAnchor);
  await tap(CHAT, VIJAY_ID, "is:rq:9", retAnchor);
  await tap(CHAT, VIJAY_ID, "is:rq:ok", retAnchor);
  ret = await returnDoc();
  check("17. cannot return more than was issued", ret?.lines?.find((l) => l.lineId === wireLineId)?.qty === 2, String(ret?.lines?.find((l) => l.lineId === wireLineId)?.qty));

  await tap(CHAT, VIJAY_ID, "is:rsub", retAnchor);
  ret = await returnDoc();
  check("18. return submitted → pending store", ret?.status === "pending_store", `status=${ret?.status}`);
  check("18. RET ticket number assigned", /^RET-\d{6}-/.test(String(ret?.ticketNumber)), String(ret?.ticketNumber));
  check("19. nothing credited back before the store confirms", (await onHand(wire.productId, locId)) === 15, String(await onHand(wire.productId, locId)));

  // ---------------- 6. the store accepts ----------------
  await tap(CHAT, VIJAY_ID, "is:racc", retAnchor);
  ret = await returnDoc();
  check("20. Vijay cannot accept his own return", ret?.status === "pending_store", `status=${ret?.status}`);

  await tap(CHAT, STORE_ID, "is:racc", retAnchor);
  ret = await returnDoc();
  iss = await issueDoc();
  check("21. return accepted", ret?.status === "accepted", `status=${ret?.status}`);
  check("22. wire credited back 15 → 17", (await onHand(wire.productId, locId)) === 17, String(await onHand(wire.productId, locId)));
  check("22. screws unchanged at 43 (all consumed)", (await onHand(screw.productId, locId)) === 43, String(await onHand(screw.productId, locId)));

  const wireIssueLine = iss?.lines?.find((l) => l.productName === "Wire Bundle");
  const screwIssueLine = iss?.lines?.find((l) => l.productName === "Screw");
  check("23. issue settled", iss?.status === "settled", `status=${iss?.status}`);
  check("23. wire: 2 returned / 3 consumed", wireIssueLine?.returnedQty === 2 && wireIssueLine?.consumedQty === 3, `returned=${wireIssueLine?.returnedQty} consumed=${wireIssueLine?.consumedQty}`);
  check("23. screws: 0 returned / 7 consumed", screwIssueLine?.returnedQty === 0 && screwIssueLine?.consumedQty === 7, `returned=${screwIssueLine?.returnedQty} consumed=${screwIssueLine?.consumedQty}`);

  // ---------------- 7. closed means closed ----------------
  await tap(CHAT, VIJAY_ID, "is:ret", anchor);
  const extraReturns = await db.collection("issueTickets").countDocuments({ chatId: String(CHAT), kind: "return" });
  check("24. no new return can be raised against a settled issue", extraReturns === 1, `returns=${extraReturns}`);

  await tap(CHAT, STORE_ID, "is:racc", retAnchor);
  check("25. an accepted return cannot be accepted twice", (await onHand(wire.productId, locId)) === 17, String(await onHand(wire.productId, locId)));

  // ---------------- 8. the group is handed straight back ----------------
  // Once the handover is submitted there is no draft, so the entry workflow owns
  // plain messages again — which is what "both workflows in one group" has to
  // mean at the end of the day, not just at the start.
  const sessionsAfter = await db.collection("botSessions").countDocuments({ chatId: String(CHAT) });
  await sendText(CHAT, STORE_ID, "Copper Lug");
  check(
    "27. plain text starts an inventory entry again after the handover",
    (await db.collection("botSessions").countDocuments({ chatId: String(CHAT) })) >= sessionsAfter,
    `before=${sessionsAfter}`
  );
  const latest = await db
    .collection("botSessions")
    .findOne({ chatId: String(CHAT), userId: String(STORE_ID) }, { sort: { updatedAt: -1 } });
  check("27. …and it is a live entry session, not a ticket", latest?.status === "active", `status=${latest?.status}`);

  // Vijay holds no "Add Inventory" permission, so the entry gate still refuses
  // him — the overlay bypassed that gate for HIS tickets without widening it.
  const vijaySessionsBefore = await db.collection("botSessions").countDocuments({ chatId: String(CHAT), userId: String(VIJAY_ID) });
  await sendText(CHAT, VIJAY_ID, "Anything At All");
  check(
    "28. the overlay did not widen the entry permission gate",
    (await db.collection("botSessions").countDocuments({ chatId: String(CHAT), userId: String(VIJAY_ID) })) === vijaySessionsBefore,
    `sessions=${vijaySessionsBefore}`
  );

  // ---------------- 9. the console feed ----------------
  const feed = await fetch(WEBHOOK.replace("/api/telegram/webhook", "/api/tickets"))
    .then((r) => r.json())
    .catch(() => []);
  const issCard = feed.find?.((t) => t.ticketId === iss?.ticketNumber);
  const retCard = feed.find?.((t) => t.ticketId === ret?.ticketNumber);
  check("29.issue appears in the console ticket feed", issCard?.kind === "issue" && issCard?.boardStatus === "COMPLETED", `kind=${issCard?.kind} board=${issCard?.boardStatus}`);
  check("29.return appears in the console ticket feed", retCard?.kind === "return" && retCard?.boardStatus === "COMPLETED", `kind=${retCard?.kind} board=${retCard?.boardStatus}`);
  check("29.issue card names who is holding the materials", issCard?.completedBy === "Vijay", String(issCard?.completedBy));

  // ---------------- summary ----------------
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `  — ${f.detail}` : ""}`);
  }
  await client.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
