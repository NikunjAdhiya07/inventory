import { NextRequest, NextResponse } from "next/server";
import type { Db, Document, ObjectId } from "mongodb";
import { aiConfigured } from "@/lib/ai";
import { getDb, ensureIndexesOnce } from "@/lib/mongodb";
import { cached } from "@/lib/cache";
import { defer } from "@/lib/defer";
import { resolveWorkflow } from "@/lib/workflow-resolver";
import { renderCurrentStep, applyMessage, applyCallback, primeStep, type EngineResult } from "@/lib/workflow-engine";
import { sendMessage, editMessageText, answerCallbackQuery, type InlineKeyboard } from "@/lib/telegram";
import { groupConfig, noteBlockedGroup, recordGroupActivity, registerGroup } from "@/lib/telegram-health";
import { handleRequestUpdate } from "@/lib/request-webhook";
import { PERM_APPROVE_PURCHASE, PERM_ISSUE, PERM_REQUEST } from "@/lib/request-types";
import {
  AUTO_ENROLL_ENABLED,
  displayName,
  enrollTelegramUser,
  isGroupChat,
  type TelegramUser,
} from "@/lib/enrollment";
import type { BotSession } from "@/lib/workflow-types";

export const dynamic = "force-dynamic";

const ok = () => NextResponse.json({ ok: true });

function pickPhotoFileId(photos: { file_id: string; file_size?: number; width?: number }[] | undefined): string | undefined {
  if (!photos?.length) return undefined;
  // Prefer ~640–900px: sharp enough for Nemotron, small enough that getFile +
  // download finish before Telegram timeouts on slow links.
  const ranked = [...photos].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const mid =
    ranked.find((p) => (p.width ?? 0) >= 640 && (p.width ?? 0) <= 1000) ??
    ranked.find((p) => (p.width ?? 0) >= 500) ??
    ranked[Math.max(0, ranked.length - 2)] ??
    ranked[ranked.length - 1];
  return mid.file_id;
}

// A role's permission set changes only when an admin edits the role, so reading
// it per update was a round trip spent re-learning the same answer.
async function rolePerms(db: Db, roleName: string): Promise<string[]> {
  return cached(`roles:perms:${roleName}`, async () => {
    const role = await db.collection("roles").findOne({ name: roleName }, { projection: { perms: 1 } });
    return Array.isArray(role?.perms) ? role.perms : [];
  });
}

// Resolve the Telegram user to a console user + effective permissions. The user
// lookup itself stays uncached so that deactivating someone takes effect on the
// next update, not at the end of a TTL.
//
// Anyone in a group the bot is in who has no record yet is enrolled here and
// carries on with the same update — see `lib/enrollment.ts` for why that is
// limited to groups. An existing record is never overwritten, so a user an admin
// set to Inactive stays blocked.
async function authorize(db: Db, tgId: string, from: TelegramUser, chatId: string, chatType?: string) {
  const user = await db
    .collection("users")
    .findOne({ tgId }, { projection: { _id: 1, status: 1, role: 1, username: 1 } });
  if (user) {
    if (user.status !== "Active") return null;
    return { user, perms: await rolePerms(db, String(user.role)) };
  }

  if (!AUTO_ENROLL_ENABLED || !isGroupChat(chatType)) return null;
  const enrolled = await enrollTelegramUser(db, from, chatId);
  if (!enrolled) return null;
  return { user: enrolled, perms: await rolePerms(db, String(enrolled.role)) };
}

// Telegram reports joins, leaves, title changes and pins as messages. They are
// events about the chat, not something a person typed, so they must not open an
// entry — which is exactly what an unrecognised message used to do.
const SERVICE_MESSAGE_KEYS = [
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
  "migrate_to_chat_id",
  "migrate_from_chat_id",
  "pinned_message",
  "message_auto_delete_timer_changed",
  "video_chat_started",
  "video_chat_ended",
  "video_chat_participants_invited",
] as const;

function isServiceMessage(message: Record<string, unknown>): boolean {
  return SERVICE_MESSAGE_KEYS.some((key) => message[key] !== undefined);
}

// The bot's own numeric id is the part of the token before the colon, so
// recognising "the bot was just added here" costs no API call.
const BOT_ID = (process.env.TELEGRAM_BOT_TOKEN || "").split(":")[0];

// Someone (possibly the bot itself) was added to the group. Enrol the people so
// their first message is handled without a round of "you're not authorized",
// and register the group so it shows up in the console.
async function handleNewMembers(db: Db, members: TelegramUser[], chat: { id: number | string; title?: string }) {
  const chatId = String(chat.id);
  const botAdded = members.some((m) => String(m.id) === BOT_ID);
  const people = members.filter((m) => !m.is_bot);

  if (botAdded) await registerGroup(db, chatId, chat.title);

  const enrolled: string[] = [];
  for (const member of people) {
    const user = await enrollTelegramUser(db, member, chatId).catch(() => null);
    if (user) enrolled.push(displayName(member));
  }

  if (botAdded) {
    await sendMessage(
      chatId,
      "✅ <b>Inventory bot connected.</b>\nEveryone in this group can add inventory — send an item name or a photo to start an entry."
    );
    return;
  }
  if (enrolled.length) {
    const who = enrolled.map((n) => `<b>${n}</b>`).join(", ");
    await sendMessage(chatId, `👋 ${who} can now add inventory — send an item name or a photo to start an entry.`);
  }
}

async function saveSession(db: Db, session: BotSession) {
  session.updatedAt = new Date().toISOString();
  if (session._id) {
    await db.collection("botSessions").replaceOne({ _id: session._id }, session as never);
  } else {
    const res = await db.collection("botSessions").insertOne(session as never);
    session._id = res.insertedId;
  }
}

function newSession(
  chatId: string,
  userId: string,
  name: string,
  resolved: { workflowId: string; version: number; steps: BotSession["steps"] },
  startUpdateId: number
): BotSession {
  const now = new Date().toISOString();
  return {
    chatId,
    userId,
    // Identifies the entry before it has ever been written; see `entryKey` in
    // the engine, which uses it to keep a redelivered opening update from
    // raising a second ticket.
    startUpdateId,
    dbUserId: "",
    submittedByName: name,
    workflowId: resolved.workflowId,
    version: resolved.version,
    // The resolved workflow is cached and shared between sessions, so the pinned
    // snapshot has to be a copy — a session must never be able to write through
    // to the cached steps.
    steps: structuredClone(resolved.steps),
    stepIndex: 0,
    answers: {},
    locationCursor: { parentStack: [], currentParent: null },
    numberDraft: "",
    status: "active",
    processedUpdateIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

// Render into the session's single anchor message. The whole entry — every step,
// nudge, and the terminal summary — lives in ONE chat message that gets edited in
// place, so a multi-step entry never floods the group. Only the first step of an
// entry sends; everything after edits.
//
// If the edit fails (message deleted, or older than Telegram's 48h edit window)
// we send a fresh message and re-anchor to it, so the flow never dead-ends.
async function render(session: BotSession, text: string, keyboard?: InlineKeyboard) {
  if (session.lastMessageId) {
    const res = await editMessageText(session.chatId, session.lastMessageId, text, keyboard);
    if (res.ok || res.notModified) return;
  }
  const sent = await sendMessage(session.chatId, text, keyboard);
  if (sent?.message_id) session.lastMessageId = sent.message_id;
}

// Deliver an engine result to the chat: next step, a nudge, or a terminal.
async function deliver(db: Db, session: BotSession, result: EngineResult, callbackQueryId?: string) {
  if (result.notice) {
    // A button tap that can't be honoured answers as a toast — the anchor message
    // is still on screen and unchanged, so there's nothing to redraw.
    if (callbackQueryId) {
      await answerCallbackQuery(callbackQueryId, result.notice);
      return;
    }
    // A nudge triggered by a typed message (failed validation, wrong input for
    // the step). Redraw the anchor with the reason above the step and its
    // keyboard, so the user can act on it in place.
    const step = session.status === "active" ? await renderCurrentStep(db, session) : null;
    if (step) await render(session, `${result.notice}\n\n${step.text}`, step.keyboard);
    else await render(session, result.notice);
    return;
  }
  // Clearing the tapped button's spinner and redrawing the anchor are two
  // independent Telegram calls. Awaiting the ack before starting the edit put a
  // whole extra round trip in front of every tap; they now go out together.
  const ack = callbackQueryId ? answerCallbackQuery(callbackQueryId) : null;
  const redraw = result.cancelled
    ? // Terminal: no keyboard, so the buttons clear off the finished entry.
      render(session, result.render?.text || "Entry cancelled.")
    : result.render
      ? render(session, result.render.text, result.render.keyboard)
      : null;
  await Promise.all([ack, redraw]);
}

// Deliver to the chat and persist the session at the same time.
//
// By this point the engine has applied every state transition, so the session
// snapshot is final and the write does not need to wait for Telegram. The one
// thing delivery can still change is the anchor message id, and only when it had
// to send a fresh message — handled explicitly below.
async function deliverAndSave(db: Db, session: BotSession, result: EngineResult, callbackQueryId?: string) {
  if (!session.lastMessageId) {
    // No anchor yet: delivery will send, which mutates the session. Nothing to
    // overlap, so keep it sequential and write once.
    await deliver(db, session, result, callbackQueryId);
    await saveSession(db, session);
    return;
  }

  const anchorBefore = session.lastMessageId;
  await Promise.all([deliver(db, session, result, callbackQueryId), saveSession(db, session)]);

  // Only reachable when the edit failed and `render` re-anchored to a new message.
  if (session.lastMessageId !== anchorBefore && session._id) {
    await db
      .collection("botSessions")
      .updateOne({ _id: session._id as ObjectId }, { $set: { lastMessageId: session.lastMessageId } });
  }
}

export async function POST(req: NextRequest) {
  // 1. Verify the webhook secret (skipped only when none is configured, e.g. dev).
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const update = await req.json().catch(() => null);
  if (!update) return ok();
  const updateId: number = update.update_id ?? 0;

  const message = update.message;
  const callback = update.callback_query;
  const from = message?.from ?? callback?.from;
  const chat = message?.chat ?? callback?.message?.chat;
  if (!from || !chat) return ok();

  const chatId = String(chat.id);
  const userId = String(from.id);
  const db = await getDb();

  // 1a. The group gate, before anything else reads or writes on this chat's
  //     behalf. Being in the group is the credential for adding inventory, so
  //     WHICH group has to be an admin's decision: the bot's username is public
  //     and anyone can create a chat and add it. An unapproved chat enrols
  //     nobody, starts no entry and resolves no workflow — it only registers
  //     itself as pending so an admin has something to approve.
  const group = isGroupChat(chat.type) ? await groupConfig(db, chatId) : { allowed: true, mode: "entry" as const };
  if (isGroupChat(chat.type) && !group.allowed) {
    const announce = await noteBlockedGroup(db, chatId, chat.title);
    const reason = "⛔ This group isn't approved for the inventory bot yet. An admin has to enable it in the console.";
    if (callback) await answerCallbackQuery(callback.id, reason.replace("⛔ ", ""));
    else if (announce) await sendMessage(chatId, reason);
    return ok();
  }

  // 1b. Chat events. A join enrols the people who arrived;
  //     every other service message is acknowledged and dropped, so leaves, pins
  //     and title changes no longer open an entry nobody asked for.
  if (message) {
    const newMembers = message.new_chat_members as TelegramUser[] | undefined;
    if (newMembers?.length) {
      if (AUTO_ENROLL_ENABLED && isGroupChat(chat.type)) {
        await handleNewMembers(db, newMembers, chat);
      }
      return ok();
    }
    if (isServiceMessage(message)) return ok();
    // Another bot talking in the group is not an inventory entry.
    if (from.is_bot) return ok();
  }

  const callbackData = callback ? String(callback.data ?? "") : "";
  const isApprovalCallback = callbackData.startsWith("appr:");
  const tappedMessageId: number | undefined = callback?.message?.message_id;

  // 2. Authorize the sender and load the session concurrently. Both are keyed off
  //    data we already have, so running them in series was one round trip of pure
  //    waiting. Approval callbacks may come from a different authorized approver in
  //    the same chat, so that session is looked up by chat rather than by user.
  //
  //    Which entry an approval belongs to is decided by the message the button is
  //    attached to, not by the chat: a chat-wide query returns an arbitrary one of
  //    the entries awaiting approval there, so with two in flight an approver
  //    could approve an entry they were never shown. The chat-wide form is kept
  //    as a fallback for a button whose anchor id has drifted.
  const sessionQuery: Document = isApprovalCallback
    ? typeof tappedMessageId === "number"
      ? { chatId, status: "awaiting_approval", lastMessageId: tappedMessageId }
      : { chatId, status: "awaiting_approval" }
    : { chatId, userId, status: { $in: ["active", "awaiting_approval"] } };

  // Started speculatively for plain messages: the result is cached, so when this
  // update turns out to begin a new entry the three-round-trip resolution has
  // already happened alongside the lookups above instead of after them. A
  // request group runs no workflow at all, so it resolves none.
  const isRequestGroup = group.mode === "request";
  const workflowPromise = callback || isRequestGroup ? null : resolveWorkflow(db, chatId).catch(() => null);

  const [auth, sessionDoc] = await Promise.all([
    authorize(db, userId, from, chatId, chat.type),
    // Entry sessions do not exist in a request group; looking for one would be a
    // round trip spent proving it every single update.
    isRequestGroup ? Promise.resolve(null) : db.collection("botSessions").findOne(sessionQuery),
  ]);

  // Reaching here without an account now means one of two deliberate things:
  // the person is deactivated, or this is a private chat (where nobody is
  // enrolled automatically). Both deserve a reason rather than a flat refusal.
  if (!auth) {
    const reason = isGroupChat(chat.type)
      ? "⛔ Your access to the inventory bot is switched off. Ask an admin to reactivate you."
      : "⛔ Inventory entries are added in the group, not in a direct message.";
    if (callback) await answerCallbackQuery(callback.id, reason.replace("⛔ ", ""));
    else await sendMessage(chatId, reason);
    return ok();
  }
  // Which permission opens the door depends on what this group is for. An entry
  // group needs "Add Inventory"; a request group needs any one of the three
  // request permissions, because the same chat is where requesters, Inventory
  // Managers and Purchase Officers all act. Which of the three a given button
  // actually requires is checked again next to that button's handler.
  const REQUEST_PERMS = [PERM_REQUEST, PERM_ISSUE, PERM_APPROVE_PURCHASE];
  const needed = isRequestGroup ? REQUEST_PERMS : ["Add Inventory"];
  if (!needed.some((p) => auth.perms.includes(p)) && !isApprovalCallback) {
    const reason = isRequestGroup
      ? `⛔ The ${auth.user.role} role can't use the request bot. Ask an admin to grant it the "${PERM_REQUEST}" permission.`
      : `⛔ The ${auth.user.role} role can't add inventory. Ask an admin to grant it the "Add Inventory" permission.`;
    if (callback) await answerCallbackQuery(callback.id, reason.replace("⛔ ", ""));
    else await sendMessage(chatId, reason);
    return ok();
  }
  const name = String(auth.user.username || from.first_name || "Unknown");

  // Monitoring and index creation both run AFTER the response is sent. As bare
  // unawaited promises they still competed for the same 10-connection pool the
  // reply needed, and could be cut off when the instance froze.
  defer(() =>
    recordGroupActivity(db, chatId, {
      isCommand: Boolean(callback) || Boolean(message?.text && String(message.text).startsWith("/")),
      text: callback ? `callback ${callbackData}` : message?.text,
      actor: name,
      title: chat.title,
    })
  );
  defer(() => ensureIndexesOnce(db));

  // ---------------- Request groups ----------------
  // Everything below this point is the inventory-entry flow. A request group
  // never reaches it: no session is opened, no workflow is resolved, and a typed
  // message is a product search rather than the start of an entry.
  if (isRequestGroup) {
    await handleRequestUpdate(db, {
      chatId,
      updateId,
      userId,
      name,
      handle: String(auth.user.handle || (from.username ? `@${from.username}` : "")),
      dbUserId: auth.user._id.toString(),
      perms: auth.perms,
      ...(message ? { message: { text: message.text as string | undefined } } : {}),
      ...(callback
        ? { callback: { id: callback.id, data: callbackData, messageId: tappedMessageId } }
        : {}),
    });
    return ok();
  }

  // ---------------- Callback queries ----------------
  if (callback) {
    const data = callbackData;

    // The session was already fetched above with the right query for this kind of
    // callback (by the tapped message for approvals, by chat+user otherwise).
    let session = sessionDoc as BotSession | null;
    if (!session && isApprovalCallback && typeof tappedMessageId === "number") {
      // The button's anchor no longer matches any session — fall back to the
      // chat-wide lookup rather than telling the approver the entry is gone.
      session = (await db
        .collection("botSessions")
        .findOne({ chatId, status: "awaiting_approval" })) as BotSession | null;
    }
    if (isApprovalCallback) {
      if (!auth.perms.includes("Approve Entries")) {
        await answerCallbackQuery(callback.id, "You are not authorized to approve entries.");
        return ok();
      }
      if (session) session.approval = { ...(session.approval ?? { stepInstanceId: "", awaitingRole: "" }), decidedBy: name };
    }

    if (!session) {
      await answerCallbackQuery(callback.id, "This entry is no longer active. Send an item name to start again.");
      return ok();
    }

    // 3. Idempotency: ignore a retried update we've already processed.
    if (session.processedUpdateIds?.includes(updateId)) {
      await answerCallbackQuery(callback.id);
      return ok();
    }

    // Re-anchor to the message the button actually lives on. It is normally the
    // session's anchor already, but this keeps the flow editing what the user is
    // looking at even if the stored id drifted.
    if (typeof tappedMessageId === "number") session.lastMessageId = tappedMessageId;

    const result = await applyCallback(db, session, data);
    session.processedUpdateIds = [...(session.processedUpdateIds ?? []), updateId].slice(-20);
    await deliverAndSave(db, session, result, callback.id);
    return ok();
  }

  // ---------------- Messages ----------------
  // Caption rides with photos; without this, "photo + name" loses the name.
  const text: string | undefined =
    (typeof message.text === "string" && message.text) ||
    (typeof message.caption === "string" && message.caption) ||
    undefined;
  const photos = message.photo as { file_id: string; file_size?: number; width?: number }[] | undefined;
  const imageFileId = pickPhotoFileId(photos);

  let session = sessionDoc as BotSession | null;

  if (session && session.processedUpdateIds?.includes(updateId)) return ok();

  // No active session → start a new entry.
  if (!session) {
    const isCancel = text && /^\/cancel/i.test(text);
    if (isCancel) return ok();
    // Already in flight since before the auth/session lookups resolved.
    const resolved = await (workflowPromise ?? resolveWorkflow(db, chatId));
    if (!resolved) {
      await sendMessage(chatId, "No workflow is configured for this group yet.");
      return ok();
    }
    session = newSession(chatId, userId, name, resolved, updateId);
    session.dbUserId = auth.user._id.toString();
    // Covers a workflow whose very first step needs priming (a location step, a
    // number step); every later step is primed by the engine as it advances into it.
    await primeStep(db, session);

    const isCommand = text && text.startsWith("/");
    const firstStep = session.steps[0];
    // A plain (non-command) opening message doubles as the item-capture input.
    if (!isCommand && firstStep?.type === "item_capture" && (text || imageFileId)) {
      // Vision can take several seconds — show progress on the anchor first.
      if (imageFileId && aiConfigured()) {
        await render(session, "🔍 Identifying photo…", []);
        await saveSession(db, session);
      }
      const result = await applyMessage(db, session, { text, imageFileId });
      session.processedUpdateIds = [updateId];
      await deliverAndSave(db, session, result);
      return ok();
    }
    // Otherwise just render the first step. No anchor exists yet, so this is the
    // one send of the entry — every later step edits this message.
    session.processedUpdateIds = [updateId];
    const first = await renderCurrentStep(db, session);
    await render(session, first.text, first.keyboard);
    await saveSession(db, session);
    return ok();
  }

  // Global cancel while mid-entry.
  if (text && /^\/cancel/i.test(text)) {
    session.status = "cancelled";
    session.processedUpdateIds = [...(session.processedUpdateIds ?? []), updateId].slice(-20);
    await deliverAndSave(db, session, { cancelled: true, render: { text: "Entry cancelled.", keyboard: [] } });
    return ok();
  }

  if (imageFileId && aiConfigured() && session.steps[session.stepIndex]?.type === "item_capture") {
    await render(session, "🔍 Identifying photo…", []);
    await saveSession(db, session);
  }

  const result = await applyMessage(db, session, { text, imageFileId });
  session.processedUpdateIds = [...(session.processedUpdateIds ?? []), updateId].slice(-20);
  await deliverAndSave(db, session, result);
  return ok();
}
