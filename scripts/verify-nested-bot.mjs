// End-to-end verification for the nested-category step (`nested_select`).
//
// Drives the running Next.js webhook the way Telegram would and asserts the bot
// session / inventory state in MongoDB — the same approach as verify-bot.mjs,
// narrowed to the drill-down: which level is on screen, what Back undoes, and
// what the finished ticket ends up carrying.
//
// SAFETY: point everything at a throwaway DB via MONGODB_DB.
//
// Usage (from inventory/):
//   MONGODB_DB=inventory_nested_verify node scripts/seed.mjs
//   MONGODB_DB=inventory_nested_verify node scripts/seed-workflows.mjs
//   MONGODB_DB=inventory_nested_verify node scripts/seed-option-trees.mjs
//   TELEGRAM_BOT_TOKEN= MONGODB_DB=inventory_nested_verify npm run dev   (separate shell)
//   MONGODB_DB=inventory_nested_verify node scripts/verify-nested-bot.mjs
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";
const WEBHOOK = process.env.WEBHOOK_URL || "http://localhost:3000/api/telegram/webhook";

if (dbName === "inventory") {
  console.error("Refusing to run against the primary 'inventory' DB. Set MONGODB_DB=inventory_nested_verify.");
  process.exit(2);
}

const USER_ID = 999999101;
const CHAT_ASK = -100888001; // nested step configured to ASK when nothing matches
const CHAT_SKIP = -100888002; // nested step configured to SKIP when nothing matches
const CHATS = [CHAT_ASK, CHAT_SKIP];

let uid = 800000;
const nextUid = () => ++uid;
let msgId = 9000;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function post(update) {
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.TELEGRAM_WEBHOOK_SECRET ? { "x-telegram-bot-api-secret-token": process.env.TELEGRAM_WEBHOOK_SECRET } : {}),
    },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

const sendText = (chatId, text) =>
  post({
    update_id: nextUid(),
    message: {
      message_id: ++msgId,
      from: { id: USER_ID, first_name: "Nested", username: "nested" },
      chat: { id: chatId, type: "group", title: `Chat ${chatId}` },
      text,
    },
  });

const cb = (chatId, data) =>
  post({
    update_id: nextUid(),
    callback_query: {
      id: `cbq${nextUid()}`,
      from: { id: USER_ID, first_name: "Nested", username: "nested" },
      message: { message_id: ++msgId, chat: { id: chatId } },
      data,
    },
  });

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const session = (chatId) =>
    db.collection("botSessions").findOne({ chatId: String(chatId), userId: String(USER_ID) }, { sort: { updatedAt: -1 } });

  const wireTree = await db.collection("optionTrees").findOne({ name: "Wire" });
  const wf = await db.collection("workflows").findOne({ name: "Wire Entry (Nested)" });
  check("Wire tree seeded", !!wireTree, wireTree ? `${wireTree.levels.length} levels` : "missing");
  check("nested workflow seeded", !!wf, wf ? `v${wf.version}` : "missing");
  if (!wireTree || !wf) {
    console.error("Run seed-option-trees.mjs against this DB first. Aborting.");
    await client.close();
    process.exit(1);
  }

  // ---- fixtures -----------------------------------------------------------
  await db.collection("users").updateOne(
    { tgId: String(USER_ID) },
    { $set: { tgId: String(USER_ID), username: "Nested Tester", handle: "@nested", role: "Admin", status: "Active" } },
    { upsert: true }
  );
  await db.collection("roles").updateOne(
    { name: "Admin" },
    { $setOnInsert: { name: "Admin", desc: "verify", status: "Active", perms: ["Add Inventory"] } },
    { upsert: true }
  );
  const chatIds = CHATS.map(String);
  await db.collection("botSessions").deleteMany({ chatId: { $in: chatIds } });
  await db.collection("inventoryEntries").deleteMany({ chatId: { $in: chatIds } });
  await db.collection("telegramGroups").deleteMany({ chatId: { $in: chatIds } });
  await db.collection("telegramGroups").insertMany(
    CHATS.map((id) => ({ chatId: String(id), title: `Chat ${id}`, status: "Active", approved: true, source: "verify", createdAt: new Date().toISOString() }))
  );

  // Two copies of the same workflow, differing only in what the nested step does
  // when nothing matches the item.
  const wfId = wf._id.toString();
  const skipSteps = wf.steps.map((s) => (s.type === "nested_select" ? { ...s, config: { ...s.config, whenUnmatched: "skip" } } : s));
  await db.collection("workflows").deleteMany({ name: "Wire Entry (Nested) — skip" });
  const skipWf = await db.collection("workflows").insertOne({
    ...wf,
    _id: undefined,
    name: "Wire Entry (Nested) — skip",
    steps: skipSteps,
    version: 1,
    isDefault: false,
    status: "Active",
  });
  await db.collection("workflowVersions").deleteMany({ workflowId: skipWf.insertedId.toString() });
  await db.collection("workflowVersions").insertOne({
    workflowId: skipWf.insertedId.toString(),
    version: 1,
    name: "Wire Entry (Nested) — skip",
    steps: skipSteps,
    createdAt: new Date().toISOString(),
    createdBy: "verify",
  });
  await db.collection("workflowAssignments").deleteMany({ chatId: { $in: chatIds } });
  await db.collection("workflowAssignments").insertMany([
    { workflowId: wfId, scope: "group", chatId: String(CHAT_ASK), priority: 0, status: "Active", createdAt: new Date().toISOString() },
    { workflowId: skipWf.insertedId.toString(), scope: "group", chatId: String(CHAT_SKIP), priority: 0, status: "Active", createdAt: new Date().toISOString() },
  ]);

  // ---- 1. "Wire" reaches the nested step and lands on its first level ------
  await sendText(CHAT_ASK, "Wire");
  let s = await session(CHAT_ASK);
  if (s?.itemSuggest?.awaiting) {
    // The item step offered fuzzy matches; take the typed name, as a user would.
    await cb(CHAT_ASK, "ai:as:typed");
    s = await session(CHAT_ASK);
  }
  check("1. item 'Wire' → nested step", s?.stepIndex === 1, `stepIndex=${s?.stepIndex}`);
  check("1. Wire tree matched from the item name", s?.nestedCursor?.treeName === "Wire", String(s?.nestedCursor?.treeName));
  check("1. opens on the first level", s?.nestedCursor?.level === 0 && s?.nestedCursor?.path?.length === 0, `level=${s?.nestedCursor?.level}`);

  // ---- 2. Drill: Copper → Flexible (FR) → Red → 2.5 sq mm -----------------
  const nodes = await db.collection("optionNodes").find({ treeId: wireTree._id.toString() }).sort({ order: 1, name: 1 }).toArray();
  const kids = (parent) => nodes.filter((n) => (n.parent ?? null) === parent).sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name)));
  const copper = kids(null).findIndex((n) => n.name === "Copper");
  await cb(CHAT_ASK, `nest:${copper}`);
  s = await session(CHAT_ASK);
  check("2. type chosen → level 2", s?.nestedCursor?.level === 1 && s?.nestedCursor?.path?.[0]?.value === "Copper", `path=${JSON.stringify(s?.nestedCursor?.path?.map((p) => p.value))}`);

  const copperId = kids(null)[copper]._id.toString();
  const flexible = kids(copperId).findIndex((n) => n.name === "Flexible (FR)");
  await cb(CHAT_ASK, `nest:${flexible}`);
  s = await session(CHAT_ASK);
  check("2. subcategory chosen → colour level", s?.nestedCursor?.level === 2, `level=${s?.nestedCursor?.level}`);
  check("2. subcategory recorded with its level label", s?.nestedCursor?.path?.[1]?.label === "Subcategory of the Wire", String(s?.nestedCursor?.path?.[1]?.label));

  // Colour is a fixed list, so it must NOT move the position in the forest.
  const flexibleId = kids(copperId)[flexible]._id.toString();
  await cb(CHAT_ASK, "nest:opt:0"); // Red
  s = await session(CHAT_ASK);
  check("3. list level answered", s?.nestedCursor?.path?.[2]?.value === "Red", String(s?.nestedCursor?.path?.[2]?.value));
  check("3. list level did not drill deeper", s?.nestedCursor?.parentNodeId === flexibleId, `parent=${s?.nestedCursor?.parentNodeId}`);

  const sizes = kids(flexibleId);
  const sizeIdx = sizes.findIndex((n) => n.name === "2.5 sq mm");
  check("3. sizes offered are the ones under the chosen subcategory", sizeIdx >= 0, sizes.map((n) => n.name).join(", "));

  // ---- 4. Back undoes one LEVEL, not the whole step ----------------------
  await cb(CHAT_ASK, "cb:back");
  s = await session(CHAT_ASK);
  check("4. Back undoes the colour level only", s?.stepIndex === 1 && s?.nestedCursor?.level === 2 && s?.nestedCursor?.path?.length === 2, `level=${s?.nestedCursor?.level} path=${s?.nestedCursor?.path?.length}`);
  await cb(CHAT_ASK, "nest:opt:1"); // Black this time
  s = await session(CHAT_ASK);
  check("4. re-answering after Back takes the new value", s?.nestedCursor?.path?.[2]?.value === "Black", String(s?.nestedCursor?.path?.[2]?.value));

  // ---- 5. Last level completes the step ----------------------------------
  await cb(CHAT_ASK, `nest:${sizeIdx}`);
  s = await session(CHAT_ASK);
  const nestedStepId = s?.steps?.[1]?.instanceId;
  const answer = s?.answers?.[nestedStepId];
  check("5. last level → next step", s?.stepIndex === 2, `stepIndex=${s?.stepIndex}`);
  check("5. answer keeps every level", answer?.path?.length === 4, JSON.stringify(answer?.path?.map((p) => `${p.label}=${p.value}`)));
  check("5. answer displays the trail", answer?.display === "Copper › Flexible (FR) › Black › 2.5 sq mm", String(answer?.display));

  // ---- 6. Back from the following step re-enters the drill-down ----------
  await cb(CHAT_ASK, "cb:back");
  s = await session(CHAT_ASK);
  check("6. Back from quantity re-opens the nested step at its first level", s?.stepIndex === 1 && s?.nestedCursor?.level === 0, `stepIndex=${s?.stepIndex} level=${s?.nestedCursor?.level}`);

  // Walk it again and finish the entry.
  await cb(CHAT_ASK, `nest:${copper}`);
  await cb(CHAT_ASK, `nest:${flexible}`);
  await cb(CHAT_ASK, "nest:opt:0"); // Red
  await cb(CHAT_ASK, `nest:${sizeIdx}`);
  await cb(CHAT_ASK, "num:2");
  await cb(CHAT_ASK, "num:5");
  await cb(CHAT_ASK, "num:ok");
  s = await session(CHAT_ASK);
  check("7. quantity accepted → unit step", s?.stepIndex === 3, `stepIndex=${s?.stepIndex}`);
  await cb(CHAT_ASK, "cb:skip"); // unit is optional
  await sendText(CHAT_ASK, "Block B second floor rewiring");
  s = await session(CHAT_ASK);
  check("7. purpose captured → review", s?.stepIndex === 5, `stepIndex=${s?.stepIndex}`);
  await cb(CHAT_ASK, "confirm");

  const entry = await db.collection("inventoryEntries").findOne({ chatId: String(CHAT_ASK) });
  const custom = entry?.fields?.custom ?? {};
  check("8. ticket raised", !!entry?.ticketNumber, String(entry?.ticketNumber));
  check("8. each level is its own field on the ticket", custom["Type of Wire"] === "Copper" && custom["Subcategory of the Wire"] === "Flexible (FR)" && custom["Colour"] === "Red" && custom["Size"] === "2.5 sq mm", JSON.stringify(custom));
  check("8. quantity + purpose kept alongside", entry?.fields?.quantity === 25 && String(custom["Where will it be used? (purpose / location)"] || "").startsWith("Block B"), `qty=${entry?.fields?.quantity}`);

  // ---- 9. An item with no tree: ask vs skip -------------------------------
  await sendText(CHAT_SKIP, "Cement Bag");
  s = await session(CHAT_SKIP);
  if (s?.itemSuggest?.awaiting) {
    await cb(CHAT_SKIP, "ai:as:typed");
    s = await session(CHAT_SKIP);
  }
  const skipStepId = s?.steps?.[1]?.instanceId;
  check("9. unmatched item with whenUnmatched=skip walks past the step", s?.stepIndex === 2, `stepIndex=${s?.stepIndex}`);
  check("9. the skipped step is recorded as skipped", s?.answers?.[skipStepId]?.display === "(skipped)", String(s?.answers?.[skipStepId]?.display));

  await db.collection("botSessions").deleteMany({ chatId: String(CHAT_ASK) });
  await sendText(CHAT_ASK, "Cement Bag");
  s = await session(CHAT_ASK);
  if (s?.itemSuggest?.awaiting) {
    await cb(CHAT_ASK, "ai:as:typed");
    s = await session(CHAT_ASK);
  }
  check("9. unmatched item with whenUnmatched=ask stops to ask which tree", s?.stepIndex === 1 && !s?.nestedCursor?.treeId, `stepIndex=${s?.stepIndex} tree=${s?.nestedCursor?.treeName}`);

  const trees = await db.collection("optionTrees").find({ status: "Active" }).sort({ name: 1 }).toArray();
  const pipeIdx = trees.findIndex((t) => t.name === "Pipe");
  await cb(CHAT_ASK, `nest:tree:${pipeIdx}`);
  s = await session(CHAT_ASK);
  check("10. picking a tree starts its own levels", s?.nestedCursor?.treeName === "Pipe" && s?.nestedCursor?.level === 0, `tree=${s?.nestedCursor?.treeName} level=${s?.nestedCursor?.level}`);
  await cb(CHAT_ASK, "nest:0");
  await cb(CHAT_ASK, "cb:back");
  await cb(CHAT_ASK, "cb:back");
  s = await session(CHAT_ASK);
  check("10. Back past the first level returns to the tree picker", s?.stepIndex === 1 && !s?.nestedCursor?.treeId, `stepIndex=${s?.stepIndex} tree=${s?.nestedCursor?.treeName}`);

  // ---- summary ------------------------------------------------------------
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await client.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
