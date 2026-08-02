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
import { randomUUID } from "node:crypto";
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
const USER_ID = 999999001; // tester with an explicit console account
const UNAUTH_ID = 111000; // no user doc → auto-enrolled on first message
const BLOCKED_ID = 111001; // has an account an admin set to Inactive
const PRIVATE_ID = 111002; // messages the bot directly, never in a group
const JOINER_ID = 111003; // arrives via a new_chat_members event
const CHAT_MAIN = -100999; // happy-path chat
const CHAT_OPEN = -100998; // open-access chat (auto-enrolment)
const CHAT_CANCEL = -100997; // cancel-path chat
const CHAT_BLOCKED = -100996; // deactivated-user chat
const CHAT_JOIN = -100995; // join-event chat
const CHAT_DUP = -100994; // double-confirm / one-ticket-per-entry chat
const CHAT_PROD = -100993; // Product Master step chat
const CHAT_UNAPPROVED = -100992; // a group the console has never approved
const CHAT_OVERRIDE = -100991; // approved, then forced inactive by an admin
const STRANGER_ID = 111004; // someone in that unapproved group
const APPROVED_CHATS = [CHAT_MAIN, CHAT_OPEN, CHAT_CANCEL, CHAT_BLOCKED, CHAT_JOIN, CHAT_DUP, CHAT_PROD, CHAT_OVERRIDE];
const ALL_CHATS = [...APPROVED_CHATS, CHAT_UNAPPROVED];

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
function msg(chatId, fromId, patch, chat) {
  return {
    update_id: nextUid(),
    message: {
      message_id: ++msgId,
      from: { id: fromId, first_name: "Tester", username: "tester" },
      chat: { id: chatId, type: "group", title: `Chat ${chatId}`, ...chat },
      ...patch,
    },
  };
}
const sendText = (chatId, fromId, text) => post(msg(chatId, fromId, { text }));
// A message that is an event about the chat rather than something a person typed.
const sendService = (chatId, fromId, patch) => post(msg(chatId, fromId, patch));
const sendPrivate = (fromId, text) => post(msg(fromId, fromId, { text }, { type: "private", title: undefined }));
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
  // Everyone the open-access checks expect the bot to meet for the first time.
  await db
    .collection("users")
    .deleteMany({ tgId: { $in: [String(UNAUTH_ID), String(PRIVATE_ID), String(JOINER_ID), String(STRANGER_ID)] } });
  await db.collection("users").updateOne(
    { tgId: String(BLOCKED_ID) },
    { $set: { tgId: String(BLOCKED_ID), username: "Deactivated Member", handle: "@blocked", role: "Group Member", status: "Inactive" } },
    { upsert: true }
  );
  const chatIds = ALL_CHATS.map(String);
  await db.collection("botSessions").deleteMany({ chatId: { $in: chatIds } });
  await db.collection("inventoryEntries").deleteMany({ chatId: { $in: chatIds } });
  await db.collection("telegramGroups").deleteMany({ chatId: { $in: chatIds } });
  // Every chat below CHAT_UNAPPROVED stands in for one an admin has approved.
  // Without this the group gate refuses them all and nothing else can run.
  await db.collection("telegramGroups").insertMany(
    APPROVED_CHATS.map((id) => ({
      chatId: String(id),
      title: `Chat ${id}`,
      status: "Active",
      approved: true,
      manualInactive: false,
      botHealth: "unknown",
      source: "verify",
      createdAt: new Date().toISOString(),
    }))
  );

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
  check("9. a ticket number was generated", /^[A-Z]+-\d{6}-\d{4,}$/.test(String(entry?.ticketNumber)), String(entry?.ticketNumber));
  check("9. the ticket is tied to its session", entry?.sessionId === String(s?._id), `${entry?.sessionId} vs ${s?._id}`);
  check("9. quantity stored as a number, not a string", typeof entry?.fields?.quantity === "number", typeof entry?.fields?.quantity);

  // A second Confirm on a finished entry must not raise a second ticket.
  await cb(CHAT_MAIN, USER_ID, "confirm");
  const afterRetap = await db.collection("inventoryEntries").countDocuments({ chatId: String(CHAT_MAIN) });
  check("9. re-tapping Confirm writes no second ticket", afterRetap === afterCount, `count ${afterCount}→${afterRetap}`);

  // ---------------- image-only entry ----------------
  await db.collection("botSessions").deleteMany({ chatId: String(CHAT_MAIN), userId: String(USER_ID) });
  await sendPhoto(CHAT_MAIN, USER_ID);
  s = await session(CHAT_MAIN);
  const imgItemId = s?.steps?.[0]?.instanceId;
  check("10. image-only opening captures entry → category", s?.stepIndex === 1 && !!s?.answers?.[imgItemId]?.imageFileId, `stepIndex=${s?.stepIndex} img=${s?.answers?.[imgItemId]?.imageFileId}`);

  // ---------------- open access: anyone in the group ----------------
  // Being in the group is the credential. Someone the console has never seen is
  // enrolled by their first message, and that same message starts their entry —
  // no "you are not authorized", no admin round trip.
  await sendText(CHAT_OPEN, UNAUTH_ID, "Ceiling Fan");
  const enrolled = await db.collection("users").findOne({ tgId: String(UNAUTH_ID) });
  const memberRole = await db.collection("roles").findOne({ name: "Group Member" });
  const openSession = await db.collection("botSessions").findOne({ chatId: String(CHAT_OPEN), userId: String(UNAUTH_ID) });
  check("11. unknown group member is enrolled on first contact", enrolled?.status === "Active", `role=${enrolled?.role} status=${enrolled?.status}`);
  check("11. enrolled with the member role", enrolled?.role === "Group Member", String(enrolled?.role));
  check("11. member role grants Add Inventory and nothing else", memberRole?.perms?.length === 1 && memberRole.perms[0] === "Add Inventory", JSON.stringify(memberRole?.perms));
  check("11. their first message starts the entry", openSession?.stepIndex === 1, `stepIndex=${openSession?.stepIndex}`);
  check(
    "11. item name captured from that same message",
    openSession?.answers?.[openSession?.steps?.[0]?.instanceId]?.value === "Ceiling Fan",
    String(openSession?.answers?.[openSession?.steps?.[0]?.instanceId]?.value)
  );
  const openGroup = await db.collection("telegramGroups").findOne({ chatId: String(CHAT_OPEN) });
  check("11. the group registers itself in the console", !!openGroup, openGroup ? openGroup.title : "not registered");

  // A deactivated account is an admin decision and outranks open access.
  await sendText(CHAT_BLOCKED, BLOCKED_ID, "Should be blocked");
  const blockedSession = await db.collection("botSessions").findOne({ chatId: String(CHAT_BLOCKED) });
  const stillInactive = await db.collection("users").findOne({ tgId: String(BLOCKED_ID) });
  check("11. deactivated member still cannot enter", !blockedSession, blockedSession ? "session exists!" : "no session");
  check("11. deactivating is not undone by enrolment", stillInactive?.status === "Inactive", String(stillInactive?.status));

  // Open access is scoped to APPROVED groups. Being in a group is the credential
  // for adding inventory, so which group counts has to be an admin's decision —
  // otherwise anyone could create a chat, add the bot and write to the inventory.
  await sendText(CHAT_UNAPPROVED, STRANGER_ID, "Free stuff please");
  const strangerUser = await db.collection("users").findOne({ tgId: String(STRANGER_ID) });
  const strangerSession = await db.collection("botSessions").findOne({ chatId: String(CHAT_UNAPPROVED) });
  const pendingGroup = await db.collection("telegramGroups").findOne({ chatId: String(CHAT_UNAPPROVED) });
  check("11. an unapproved group enrols nobody", !strangerUser, strangerUser ? "enrolled!" : "not enrolled");
  check("11. an unapproved group starts no entry", !strangerSession, strangerSession ? "session exists!" : "no session");
  check("11. an unapproved group registers as pending for an admin to see", pendingGroup?.approved === false, `approved=${pendingGroup?.approved}`);

  // A force-inactive override is not just a badge — it stops the bot serving the
  // chat, even for a member who is enrolled and in an approved group. Its own
  // chat, because the server caches the gate for a TTL and this flips it.
  await db.collection("telegramGroups").updateOne({ chatId: String(CHAT_OVERRIDE) }, { $set: { manualInactive: true } });
  await sendText(CHAT_OVERRIDE, USER_ID, "Should be refused");
  const overriddenSession = await db.collection("botSessions").findOne({ chatId: String(CHAT_OVERRIDE) });
  check("11. forcing a group inactive stops the bot serving it", !overriddenSession, overriddenSession ? "session exists!" : "no session");

  // Open access is scoped to groups: a stranger who finds the bot's username
  // and DMs it is nobody.
  await sendPrivate(PRIVATE_ID, "Let me in");
  const privateUser = await db.collection("users").findOne({ tgId: String(PRIVATE_ID) });
  const privateSession = await db.collection("botSessions").findOne({ chatId: String(PRIVATE_ID) });
  check("11. a private chat enrols nobody", !privateUser, privateUser ? "enrolled!" : "not enrolled");
  check("11. a private chat starts no entry", !privateSession, privateSession ? "session exists!" : "no session");

  // Joining the group enrols you before you ever type.
  await sendService(CHAT_JOIN, USER_ID, {
    new_chat_members: [{ id: JOINER_ID, is_bot: false, first_name: "New", last_name: "Joiner", username: "newjoiner" }],
  });
  const joiner = await db.collection("users").findOne({ tgId: String(JOINER_ID) });
  const joinSession = await db.collection("botSessions").findOne({ chatId: String(CHAT_JOIN) });
  check("11. a join event enrols the new member", joiner?.status === "Active", `${joiner?.username} / ${joiner?.role}`);
  check("11. a join event does not open an entry", !joinSession, joinSession ? "session exists!" : "no session");

  // Leaves, pins and title changes are events about the chat, not entries.
  await sendService(CHAT_JOIN, USER_ID, { left_chat_member: { id: JOINER_ID, first_name: "New" } });
  await sendService(CHAT_JOIN, USER_ID, { new_chat_title: "Renamed" });
  const afterService = await db.collection("botSessions").findOne({ chatId: String(CHAT_JOIN) });
  check("11. service messages never start an entry", !afterService, afterService ? "session exists!" : "no session");

  // ---------------- Cancel is distinct from Back ----------------
  await sendText(CHAT_CANCEL, USER_ID, "Widget");
  let c = await session(CHAT_CANCEL);
  check("12. cancel-path entry started", c?.stepIndex === 1, `stepIndex=${c?.stepIndex}`);
  await cb(CHAT_CANCEL, USER_ID, "cb:cancel");
  c = await session(CHAT_CANCEL);
  const cancelEntries = await db.collection("inventoryEntries").countDocuments({ chatId: String(CHAT_CANCEL) });
  check("12. Cancel sets status cancelled", c?.status === "cancelled", `status=${c?.status}`);
  check("12. Cancel writes no inventory entry", cancelEntries === 0, `entries=${cancelEntries}`);

  // ---------------- one ticket per entry, under a double tap ----------------
  // Two Confirms landing at the same instant is the ordinary impatient-user
  // case, and it used to be two inventory rows: distinct update ids slip past
  // the replay guard, so the session claim is what has to hold.
  await sendText(CHAT_DUP, USER_ID, "Double Tap Widget");
  await cb(CHAT_DUP, USER_ID, "cat:0");
  await cb(CHAT_DUP, USER_ID, "sub:0");
  let d = await session(CHAT_DUP);
  // Walk the location step whichever shape it has, then quantity and unit.
  if (d?.locationCursor?.currentParent) {
    await cb(CHAT_DUP, USER_ID, "locsel");
  } else {
    await cb(CHAT_DUP, USER_ID, "loc:0");
    await cb(CHAT_DUP, USER_ID, "locsel");
  }
  await cb(CHAT_DUP, USER_ID, "num:7");
  await cb(CHAT_DUP, USER_ID, "num:ok");
  await cb(CHAT_DUP, USER_ID, "unit:0");
  d = await session(CHAT_DUP);
  check("13. double-tap entry reached the review step", d?.stepIndex === 6, `stepIndex=${d?.stepIndex}`);

  await Promise.all([cb(CHAT_DUP, USER_ID, "confirm"), cb(CHAT_DUP, USER_ID, "confirm")]);
  const dupEntries = await db.collection("inventoryEntries").find({ chatId: String(CHAT_DUP) }).toArray();
  check("13. two simultaneous Confirms produce exactly one ticket", dupEntries.length === 1, `entries=${dupEntries.length}`);
  check("13. that one ticket has a number", !!dupEntries[0]?.ticketNumber, String(dupEntries[0]?.ticketNumber));

  // Ticket numbers are unique across everything this run wrote.
  const allTickets = await db
    .collection("inventoryEntries")
    .find({ ticketNumber: { $exists: true } }, { projection: { ticketNumber: 1 } })
    .toArray();
  const numbers = allTickets.map((e) => e.ticketNumber);
  check("13. every ticket number is unique", new Set(numbers).size === numbers.length, `${numbers.length} tickets, ${new Set(numbers).size} distinct`);

  // ---------------- Product Master step ----------------
  // The default workflow has no product step, so this builds one and assigns it
  // to its own chat: pick a product from the master, and the entry inherits the
  // product's identity and attributes without asking for them again.
  const productCount = await db.collection("products").countDocuments({ status: "Active" });
  if (!productCount) {
    check("14. products seeded (run seed-products.mjs)", false, "no active products");
  } else {
    const pstep = (type, label, config = {}, order = 1) => ({ instanceId: randomUUID(), type, label, required: true, order, config });
    const psteps = [
      pstep("product_select", "Select the product:", { filterByCategory: false }, 1),
      pstep("quantity", "Enter the quantity:", { numberMin: 1, numberMax: 0 }, 2),
      pstep("unit_select", "Select a unit:", {}, 3),
      pstep("review_confirm", "Please review your entry:", {}, 4),
    ];
    await db.collection("workflows").deleteMany({ name: "Product Entry Verify" });
    const pwf = await db.collection("workflows").insertOne({
      name: "Product Entry Verify",
      desc: "verify-bot",
      status: "Active",
      version: 1,
      isDefault: false,
      steps: psteps,
      createdAt: new Date().toISOString(),
    });
    const pwfId = pwf.insertedId.toString();
    await db.collection("workflowVersions").updateOne(
      { workflowId: pwfId, version: 1 },
      { $set: { workflowId: pwfId, version: 1, name: "Product Entry Verify", steps: psteps, createdAt: new Date().toISOString(), createdBy: "verify" } },
      { upsert: true }
    );
    await db.collection("workflowAssignments").deleteMany({ chatId: String(CHAT_PROD) });
    await db.collection("workflowAssignments").insertOne({ workflowId: pwfId, scope: "group", chatId: String(CHAT_PROD), priority: 0, status: "Active", createdAt: new Date().toISOString() });

    // Give the product a category so the "inherited from the product" path has
    // something to inherit — this workflow never asks for one.
    await db.collection("products").updateOne({ productNumber: "PNT-2210" }, { $set: { category: "Paints & Finishes" } });

    // First message opens the step (it is not an item-capture step, so it does
    // not double as input); the next one searches.
    await sendText(CHAT_PROD, USER_ID, "start");
    let p = await session(CHAT_PROD);
    check("14. product step opens the entry", p?.stepIndex === 0 && p?.steps?.[0]?.type === "product_select", `stepIndex=${p?.stepIndex} type=${p?.steps?.[0]?.type}`);

    await sendText(CHAT_PROD, USER_ID, "Enamel");
    p = await session(CHAT_PROD);
    check("14. a typed message searches the catalogue", p?.productQuery === "Enamel", `query=${p?.productQuery}`);

    // A search that matches nothing keeps the list the user can still act on.
    await sendText(CHAT_PROD, USER_ID, "zzzzz");
    p = await session(CHAT_PROD);
    check("14. a search with no matches does not empty the list", p?.productQuery === "Enamel", `query=${p?.productQuery}`);

    // Index 0 of the FILTERED list is the product the button showed.
    await cb(CHAT_PROD, USER_ID, "prod:0");
    p = await session(CHAT_PROD);
    const chosen = p?.answers?.[p?.steps?.[0]?.instanceId];
    check("14. picking a product advances to quantity", p?.stepIndex === 1, `stepIndex=${p?.stepIndex}`);
    check("14. the product's identity is captured", chosen?.product?.productNumber === "PNT-2210", `${chosen?.display}`);
    check("14. its attributes ride along with the entry", (chosen?.product?.attributes ?? []).length === 3, JSON.stringify(chosen?.product?.attributes));

    await cb(CHAT_PROD, USER_ID, "num:5");
    await cb(CHAT_PROD, USER_ID, "num:ok");
    await cb(CHAT_PROD, USER_ID, "unit:0");
    await cb(CHAT_PROD, USER_ID, "confirm");
    const pentry = await db.collection("inventoryEntries").findOne({ chatId: String(CHAT_PROD) });
    check("14. the ticket records the product", pentry?.fields?.productNumber === "PNT-2210" && pentry?.fields?.productName === "Enamel Paint", JSON.stringify(pentry?.fields ?? {}));
    check("14. the ticket keeps the attribute snapshot", (pentry?.fields?.attributes ?? []).length === 3, JSON.stringify(pentry?.fields?.attributes));
    check("14. the item name falls back to the product", pentry?.fields?.itemName === "Enamel Paint", String(pentry?.fields?.itemName));
    check("14. a workflow with no category step inherits it from the product", pentry?.fields?.category === "Paints & Finishes", `category="${pentry?.fields?.category}"`);
    check("14. the product ticket has its own number", /^[A-Z]+-\d{6}-\d{4,}$/.test(String(pentry?.ticketNumber)), String(pentry?.ticketNumber));
  }

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
