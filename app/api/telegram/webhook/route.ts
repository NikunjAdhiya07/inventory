import { NextRequest, NextResponse } from "next/server";
import type { Db, Document, ObjectId } from "mongodb";
import { getDb, ensureIndexesOnce } from "@/lib/mongodb";
import { cached } from "@/lib/cache";
import { defer } from "@/lib/defer";
import { resolveWorkflow } from "@/lib/workflow-resolver";
import { renderCurrentStep, applyMessage, applyCallback, primeStep, type EngineResult } from "@/lib/workflow-engine";
import { sendMessage, editMessageText, answerCallbackQuery, type InlineKeyboard } from "@/lib/telegram";
import { recordGroupActivity } from "@/lib/telegram-health";
import type { BotSession } from "@/lib/workflow-types";

export const dynamic = "force-dynamic";

const ok = () => NextResponse.json({ ok: true });

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
async function authorize(db: Db, tgId: string) {
  const user = await db
    .collection("users")
    .findOne({ tgId }, { projection: { _id: 1, status: 1, role: 1, username: 1 } });
  if (!user || user.status !== "Active") return null;
  return { user, perms: await rolePerms(db, String(user.role)) };
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

function newSession(chatId: string, userId: string, name: string, resolved: { workflowId: string; version: number; steps: BotSession["steps"] }): BotSession {
  const now = new Date().toISOString();
  return {
    chatId,
    userId,
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

  const callbackData = callback ? String(callback.data ?? "") : "";
  const isApprovalCallback = callbackData.startsWith("appr:");

  // 2. Authorize the sender and load the session concurrently. Both are keyed off
  //    data we already have, so running them in series was one round trip of pure
  //    waiting. Approval callbacks may come from a different authorized approver in
  //    the same chat, so that session is looked up by chat rather than by user.
  const sessionQuery: Document = isApprovalCallback
    ? { chatId, status: "awaiting_approval" }
    : { chatId, userId, status: { $in: ["active", "awaiting_approval"] } };

  // Started speculatively for plain messages: the result is cached, so when this
  // update turns out to begin a new entry the three-round-trip resolution has
  // already happened alongside the lookups above instead of after them.
  const workflowPromise = callback ? null : resolveWorkflow(db, chatId).catch(() => null);

  const [auth, sessionDoc] = await Promise.all([
    authorize(db, userId),
    db.collection("botSessions").findOne(sessionQuery),
  ]);

  if (!auth) {
    if (callback) await answerCallbackQuery(callback.id, "You are not authorized to add inventory.");
    else await sendMessage(chatId, "⛔ You are not authorized to add inventory.");
    return ok();
  }
  if (!auth.perms.includes("Add Inventory") && !isApprovalCallback) {
    if (callback) await answerCallbackQuery(callback.id, "You are not authorized to add inventory.");
    else await sendMessage(chatId, "⛔ You are not authorized to add inventory.");
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
    })
  );
  defer(() => ensureIndexesOnce(db));

  // ---------------- Callback queries ----------------
  if (callback) {
    const data = callbackData;

    // The session was already fetched above with the right query for this kind of
    // callback (by chat for approvals, by chat+user otherwise).
    const session = sessionDoc as BotSession | null;
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
    const tappedMessageId = callback.message?.message_id;
    if (typeof tappedMessageId === "number") session.lastMessageId = tappedMessageId;

    const result = await applyCallback(db, session, data);
    session.processedUpdateIds = [...(session.processedUpdateIds ?? []), updateId].slice(-20);
    await deliverAndSave(db, session, result, callback.id);
    return ok();
  }

  // ---------------- Messages ----------------
  const text: string | undefined = message.text;
  const photos = message.photo as { file_id: string }[] | undefined;
  const imageFileId = photos?.length ? photos[photos.length - 1].file_id : undefined; // largest size

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
    session = newSession(chatId, userId, name, resolved);
    session.dbUserId = auth.user._id.toString();
    // Covers a workflow whose very first step needs priming (a location step, a
    // number step); every later step is primed by the engine as it advances into it.
    await primeStep(db, session);

    const isCommand = text && text.startsWith("/");
    const firstStep = session.steps[0];
    // A plain (non-command) opening message doubles as the item-capture input.
    if (!isCommand && firstStep?.type === "item_capture" && (text || imageFileId)) {
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

  const result = await applyMessage(db, session, { text, imageFileId });
  session.processedUpdateIds = [...(session.processedUpdateIds ?? []), updateId].slice(-20);
  await deliverAndSave(db, session, result);
  return ok();
}
