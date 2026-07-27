// End-to-end verification harness for the Inventory Entry Bot (Story-3).
//
// Drives the running Next.js webhook (POST /api/telegram/webhook) exactly the
// way Telegram would — with curl-style JSON updates — and asserts the resulting
// bot session / inventory state in MongoDB. No live Telegram is involved: run
// the dev server with an empty TELEGRAM_BOT_TOKEN so lib/telegram.ts uses its
// console stub.
//
// SAFETY: point everything at a throwaway DB via MONGODB_DB (e.g.
// `inventory_verify`) so the real inventory data is never touched.
//
// Usage (from inventory/):
//   MONGODB_DB=inventory_verify node scripts/seed.mjs
//   MONGODB_DB=inventory_verify node scripts/seed-workflows.mjs
//   TELEGRAM_BOT_TOKEN= MONGODB_DB=inventory_verify npm run dev   (separate shell)
//   MONGODB_DB=inventory_verify node scripts/verify-bot.mjs
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
const USER_ID = 999999001; // authorized tester
const UNAUTH_ID = 111000; // no user doc → unauthorized
const CHAT_MAIN = -100999; // happy-path chat
const CHAT_UNAUTH = -100998; // unauthorized-path chat
const CHAT_CANCEL = -100997; // cancel-path chat

let uid = 700000; // monotonic update_id source
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
let msgId = 5000;
function msg(chatId, fromId, patch) {
  return {
    update_id: nextUid(),
    message: { message_id: ++msgId, from: { id: fromId, first_name: "Tester", username: "tester" }, chat: { id: chatId, type: "group" }, ...patch },
  };
}
const sendText = (chatId, fromId, text) => post(msg(chatId, fromId, { text }));
const sendPhoto = (chatId, fromId) => post(msg(chatId, fromId, { photo: [{ file_id: "AgSMALL" }, { file_id: "AgLARGEST" }] }));
function cb(chatId, fromId, data) {
  return post({
    update_id: nextUid(),
    callback_query: { id: `cbq${nextUid()}`, from: { id: fromId, first_name: "Tester", username: "tester" }, message: { message_id: ++msgId, chat: { id: chatId } }, data },
  });
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const session = (chatId, userId = USER_ID) =>
    db.collection("botSessions").findOne({ chatId: String(chatId), userId: String(userId) }, { sort: { updatedAt: -1 } });

  // 0. Preconditions: master data + default workflow must be seeded.
  const [cats, units, locs, wf] = await Promise.all([
    db.collection("categories").countDocuments({ status: "Active" }),
    db.collection("units").countDocuments({ status: "Active" }),
    db.collection("locations").countDocuments({ status: "Active" }),
    db.collection("workflows").findOne({ isDefault: true, status: "Active" }),
  ]);
  check("master data seeded (categories/units/locations)", cats > 0 && units > 0 && locs > 0, `cats=${cats} units=${units} locs=${locs}`);
  check("default workflow present", !!wf, wf ? wf.name : "none");
  if (!cats || !units || !locs || !wf) {
    console.error("Seed inventory_verify first (see header). Aborting.");
    await client.close();
    process.exit(1);
  }

  // Ensure an authorized tester user; clean any prior test state.
  await db.collection("roles").updateOne(
    { name: "Tester" },
    { $set: { name: "Tester", desc: "verify-bot", status: "Active", perms: ["Add Inventory", "Approve Entries", "View Reports"] } },
    { upsert: true }
  );
  await db.collection("users").updateOne(
    { tgId: String(USER_ID) },
    { $set: { tgId: String(USER_ID), username: "Verify Tester", handle: "@verify", role: "Tester", status: "Active" } },
    { upsert: true }
  );
  await db.collection("users").deleteOne({ tgId: String(UNAUTH_ID) }); // make sure it stays unknown
  await db.collection("botSessions").deleteMany({ chatId: { $in: [String(CHAT_MAIN), String(CHAT_UNAUTH), String(CHAT_CANCEL)] } });
  await db.collection("inventoryEntries").deleteMany({ chatId: { $in: [String(CHAT_MAIN), String(CHAT_CANCEL)] } });

  // ---------------- Happy path ----------------
  // 1. Opening message (text) doubles as item capture → advances to category.
  await sendText(CHAT_MAIN, USER_ID, "PVC T Pipe");
  let s = await session(CHAT_MAIN);
  const itemStepId = s?.steps?.[0]?.instanceId;
  check("1. opening text captured → category step", s?.stepIndex === 1, `stepIndex=${s?.stepIndex}`);
  check("1. item name stored", s?.answers?.[itemStepId]?.value === "PVC T Pipe", s?.answers?.[itemStepId]?.value);

  // 2. Back from category returns to item_capture WITHOUT losing the item.
  await cb(CHAT_MAIN, USER_ID, "cb:back");
  s = await session(CHAT_MAIN);
  check("2. Back: category → item_capture", s?.stepIndex === 0, `stepIndex=${s?.stepIndex}`);
  check("2. Back preserves item name", s?.answers?.[itemStepId]?.value === "PVC T Pipe", s?.answers?.[itemStepId]?.value);

  // 3. Re-advance from item_capture, then choose category.
  await sendText(CHAT_MAIN, USER_ID, "PVC T Pipe");
  await cb(CHAT_MAIN, USER_ID, "cat:0");
  s = await session(CHAT_MAIN);
  const catStepId = s?.steps?.[1]?.instanceId;
  check("3. category chosen → subcategory step", s?.stepIndex === 2, `stepIndex=${s?.stepIndex}`);
  const catValue = s?.answers?.[catStepId]?.value;
  check("3. category value stored", !!catValue, String(catValue));

  // 4. Back from subcategory → category, category preserved.
  await cb(CHAT_MAIN, USER_ID, "cb:back");
  s = await session(CHAT_MAIN);
  check("4. Back: subcategory → category", s?.stepIndex === 1, `stepIndex=${s?.stepIndex}`);
  check("4. Back preserves category", s?.answers?.[catStepId]?.value === catValue, String(s?.answers?.[catStepId]?.value));

  // 5. Re-choose category, choose subcategory → location tree.
  await cb(CHAT_MAIN, USER_ID, "cat:0");
  await cb(CHAT_MAIN, USER_ID, "sub:0");
  s = await session(CHAT_MAIN);
  check("5. subcategory chosen → location step", s?.stepIndex === 3, `stepIndex=${s?.stepIndex}`);

  // 6. Location tree.
  //
  // The step opens INSIDE its configured `defaultLocation` (so the common case is
  // one tap), the other top-level nodes are offered alongside that node's
  // children as an escape, and a node with no children selects on tap instead of
  // opening an empty level. Everything below is derived from the data so the
  // checks hold whatever the tree currently looks like.
  const activeLocs = await db.collection("locations").find({ status: "Active" }).sort({ name: 1 }).toArray();
  const childrenOf = (pid) => activeLocs.filter((l) => String(l.parent ?? "") === String(pid ?? ""));
  const rootLocs = activeLocs.filter((l) => (l.parent ?? null) === null);
  const hasKids = (l) => childrenOf(l._id.toString()).length > 0;

  s = await session(CHAT_MAIN);
  const locStepId = s?.steps?.[3]?.instanceId;
  const defName = s?.steps?.[3]?.config?.defaultLocation;
  const defNode = defName ? rootLocs.find((l) => String(l.name) === String(defName)) : null;

  if (defNode) {
    check(
      "6. location step opens inside its default node",
      s?.locationCursor?.currentParent === defNode._id.toString(),
      `default=${defName} cursor=${s?.locationCursor?.currentParent}`
    );

    // Landing view = children of the default node, then the other roots.
    const defKids = childrenOf(defNode._id.toString());
    const otherRoots = rootLocs.filter((l) => l._id.toString() !== defNode._id.toString());
    check("6. landing view offers the default node's children", defKids.length > 0, `${defKids.length} children`);

    if (otherRoots.length) {
      // Tapping a sibling root must jump cleanly, not nest under the default.
      await cb(CHAT_MAIN, USER_ID, `loc:${defKids.length}`);
      s = await session(CHAT_MAIN);
      check(
        "6. sibling root reachable from the landing view",
        s?.locationCursor?.currentParent === otherRoots[0]._id.toString() && s?.locationCursor?.parentStack?.length === 0,
        `cursor=${s?.locationCursor?.currentParent} stack=${s?.locationCursor?.parentStack?.length}`
      );

      // Back from there returns to the top level, still inside the step.
      await cb(CHAT_MAIN, USER_ID, "cb:back");
      s = await session(CHAT_MAIN);
      check(
        "6. Back from a sibling root returns to top level (still in step)",
        s?.stepIndex === 3 && s?.locationCursor?.currentParent == null,
        `stepIndex=${s?.stepIndex} cur=${s?.locationCursor?.currentParent}`
      );

      // Re-enter the default node from the top level to continue.
      const defIdxAtRoot = rootLocs.findIndex((l) => l._id.toString() === defNode._id.toString());
      await cb(CHAT_MAIN, USER_ID, `loc:${defIdxAtRoot}`);
      s = await session(CHAT_MAIN);
    }

    // A childless child selects on tap and advances — no separate confirm.
    const leafIdx = defKids.findIndex((l) => !hasKids(l));
    if (leafIdx >= 0) {
      const leaf = defKids[leafIdx];
      await cb(CHAT_MAIN, USER_ID, `loc:${leafIdx}`);
      s = await session(CHAT_MAIN);
      check("6. tapping a leaf selects it and advances", s?.stepIndex === 4, `stepIndex=${s?.stepIndex}`);
      check(
        "6. selected path includes the full ancestry",
        s?.answers?.[locStepId]?.display === `${defNode.name} › ${leaf.name}`,
        s?.answers?.[locStepId]?.display
      );
    } else {
      // Default node has only branch children — drill then confirm.
      await cb(CHAT_MAIN, USER_ID, "loc:0");
      await cb(CHAT_MAIN, USER_ID, "locsel");
      s = await session(CHAT_MAIN);
      check("6. location selected → quantity step", s?.stepIndex === 4, `stepIndex=${s?.stepIndex}`);
    }
  } else {
    // No default configured: classic drill-down from the root.
    await cb(CHAT_MAIN, USER_ID, "loc:0");
    s = await session(CHAT_MAIN);
    check("6. location drill sets cursor", s?.locationCursor?.currentParent != null, `cur=${s?.locationCursor?.currentParent}`);
    await cb(CHAT_MAIN, USER_ID, "cb:back");
    s = await session(CHAT_MAIN);
    check("6. Back in tree climbs a level (still in location step)", s?.stepIndex === 3 && s?.locationCursor?.currentParent == null, `stepIndex=${s?.stepIndex} cur=${s?.locationCursor?.currentParent}`);
    await cb(CHAT_MAIN, USER_ID, "loc:0");
    await cb(CHAT_MAIN, USER_ID, "locsel");
    s = await session(CHAT_MAIN);
    check("6. location selected → quantity step", s?.stepIndex === 4, `stepIndex=${s?.stepIndex}`);
  }
  check("6. location path stored", !!s?.answers?.[locStepId]?.display, s?.answers?.[locStepId]?.display);

  // 7. Quantity: entered on the inline keypad, not by typing a message.
  const qtyStepId = s?.steps?.[4]?.instanceId;

  // A typed number is no longer an answer — the keypad is the only input.
  await sendText(CHAT_MAIN, USER_ID, "10");
  s = await session(CHAT_MAIN);
  check("7. typed number does not answer the step", s?.stepIndex === 4 && !s?.answers?.[qtyStepId], `stepIndex=${s?.stepIndex} answer=${JSON.stringify(s?.answers?.[qtyStepId])}`);

  // Done with an empty draft is a nudge, not an advance.
  await cb(CHAT_MAIN, USER_ID, "num:ok");
  s = await session(CHAT_MAIN);
  check("7. Done on an empty keypad does not advance", s?.stepIndex === 4, `stepIndex=${s?.stepIndex}`);

  // Key 1, 5, then backspace → draft "1"; key 0 → "10".
  await cb(CHAT_MAIN, USER_ID, "num:1");
  await cb(CHAT_MAIN, USER_ID, "num:5");
  s = await session(CHAT_MAIN);
  check("7. keypad digits accumulate in the draft", s?.numberDraft === "15", `draft=${s?.numberDraft}`);
  await cb(CHAT_MAIN, USER_ID, "num:del");
  s = await session(CHAT_MAIN);
  check("7. backspace drops the last digit", s?.numberDraft === "1", `draft=${s?.numberDraft}`);
  await cb(CHAT_MAIN, USER_ID, "num:0");
  s = await session(CHAT_MAIN);
  check("7. draft holds the full number before commit", s?.numberDraft === "10" && s?.stepIndex === 4, `draft=${s?.numberDraft} stepIndex=${s?.stepIndex}`);

  // Done commits and advances.
  await cb(CHAT_MAIN, USER_ID, "num:ok");
  s = await session(CHAT_MAIN);
  check("7. Done commits the quantity → unit step", s?.stepIndex === 5, `stepIndex=${s?.stepIndex}`);
  check("7. quantity value stored", Number(s?.answers?.[qtyStepId]?.value) === 10, String(s?.answers?.[qtyStepId]?.value));
  check("7. draft cleared after commit", !s?.numberDraft, `draft=${s?.numberDraft}`);

  // Back into the quantity step reopens the keypad on the committed value.
  await cb(CHAT_MAIN, USER_ID, "cb:back");
  s = await session(CHAT_MAIN);
  check("7. Back into a number step prefills the keypad", s?.stepIndex === 4 && s?.numberDraft === "10", `stepIndex=${s?.stepIndex} draft=${s?.numberDraft}`);
  await cb(CHAT_MAIN, USER_ID, "num:ok");
  s = await session(CHAT_MAIN);
  check("7. re-commit returns to the unit step", s?.stepIndex === 5, `stepIndex=${s?.stepIndex}`);

  // 8. Unit → review; Back from review → unit (preserved); re-select; confirm.
  await cb(CHAT_MAIN, USER_ID, "unit:0");
  s = await session(CHAT_MAIN);
  check("8. unit chosen → review step", s?.stepIndex === 6, `stepIndex=${s?.stepIndex}`);
  const unitStepId = s?.steps?.[5]?.instanceId;
  const unitValue = s?.answers?.[unitStepId]?.value;
  await cb(CHAT_MAIN, USER_ID, "cb:back");
  s = await session(CHAT_MAIN);
  check("8. Back: review → unit", s?.stepIndex === 5, `stepIndex=${s?.stepIndex}`);
  check("8. Back preserves unit", s?.answers?.[unitStepId]?.value === unitValue, String(s?.answers?.[unitStepId]?.value));
  await cb(CHAT_MAIN, USER_ID, "unit:0");

  // 9. Confirm → save.
  const beforeCount = await db.collection("inventoryEntries").countDocuments({ chatId: String(CHAT_MAIN) });
  await cb(CHAT_MAIN, USER_ID, "confirm");
  s = await session(CHAT_MAIN);
  const entry = await db.collection("inventoryEntries").findOne({ chatId: String(CHAT_MAIN) }, { sort: { createdAt: -1 } });
  const afterCount = await db.collection("inventoryEntries").countDocuments({ chatId: String(CHAT_MAIN) });
  check("9. session completed on confirm", s?.status === "completed", `status=${s?.status}`);
  check("9. inventory entry written", afterCount === beforeCount + 1, `count ${beforeCount}→${afterCount}`);
  check("9. entry has correct item/qty/unit", entry?.fields?.itemName === "PVC T Pipe" && String(entry?.fields?.quantity) === "10" && !!entry?.fields?.unit, JSON.stringify(entry?.fields ?? {}));
  check("9. entry has category + location path", !!entry?.fields?.category && !!entry?.fields?.locationPath, `${entry?.fields?.category} / ${entry?.fields?.locationPath}`);

  // ---------------- image-only entry ----------------
  await db.collection("botSessions").deleteMany({ chatId: String(CHAT_MAIN), userId: String(USER_ID) });
  await sendPhoto(CHAT_MAIN, USER_ID);
  s = await session(CHAT_MAIN);
  const imgItemId = s?.steps?.[0]?.instanceId;
  check("10. image-only opening captures entry → category", s?.stepIndex === 1 && !!s?.answers?.[imgItemId]?.imageFileId, `stepIndex=${s?.stepIndex} img=${s?.answers?.[imgItemId]?.imageFileId}`);

  // ---------------- unauthorized ----------------
  await sendText(CHAT_UNAUTH, UNAUTH_ID, "Should be blocked");
  const unauthSession = await db.collection("botSessions").findOne({ chatId: String(CHAT_UNAUTH) });
  check("11. unauthorized user creates no session", !unauthSession, unauthSession ? "session exists!" : "no session");

  // ---------------- Cancel is distinct from Back ----------------
  await sendText(CHAT_CANCEL, USER_ID, "Widget");
  let c = await session(CHAT_CANCEL);
  check("12. cancel-path entry started", c?.stepIndex === 1, `stepIndex=${c?.stepIndex}`);
  await cb(CHAT_CANCEL, USER_ID, "cb:cancel");
  c = await session(CHAT_CANCEL);
  const cancelEntries = await db.collection("inventoryEntries").countDocuments({ chatId: String(CHAT_CANCEL) });
  check("12. Cancel sets status cancelled", c?.status === "cancelled", `status=${c?.status}`);
  check("12. Cancel writes no inventory entry", cancelEntries === 0, `entries=${cancelEntries}`);

  // ---------------- summary ----------------
  const failed = results.filter((r) => !r.pass);
  console.log("\n──────────────────────────────────────────");
  console.log(`${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) console.log("FAILED:\n" + failed.map((r) => `  • ${r.name}${r.detail ? ` — ${r.detail}` : ""}`).join("\n"));

  await client.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
