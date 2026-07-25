import { NextRequest, NextResponse } from "next/server";
import type { Db } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { resolveWorkflow } from "@/lib/workflow-resolver";
import { renderCurrentStep, applyMessage, applyCallback, type EngineResult } from "@/lib/workflow-engine";
import { sendMessage, answerCallbackQuery } from "@/lib/telegram";
import { recordGroupActivity } from "@/lib/telegram-health";
import type { BotSession } from "@/lib/workflow-types";

export const dynamic = "force-dynamic";

const ok = () => NextResponse.json({ ok: true });

// Resolve the Telegram user to a console user + effective permissions.
async function authorize(db: Db, tgId: string) {
  const user = await db.collection("users").findOne({ tgId });
  if (!user || user.status !== "Active") return null;
  const role = await db.collection("roles").findOne({ name: user.role });
  const perms: string[] = Array.isArray(role?.perms) ? role.perms : [];
  return { user, perms };
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
    steps: resolved.steps,
    stepIndex: 0,
    answers: {},
    locationCursor: { parentStack: [], currentParent: null },
    status: "active",
    processedUpdateIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

// Deliver an engine result to the chat: next step, a nudge, or a terminal.
async function deliver(db: Db, session: BotSession, result: EngineResult, callbackQueryId?: string) {
  if (result.notice) {
    if (callbackQueryId) await answerCallbackQuery(callbackQueryId, result.notice);
    else await sendMessage(session.chatId, result.notice);
    return;
  }
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId);
  if (result.cancelled) {
    session.status = "cancelled";
    await sendMessage(session.chatId, result.render?.text || "Entry cancelled.");
    return;
  }
  if (result.render) {
    const sent = await sendMessage(session.chatId, result.render.text, result.render.keyboard);
    if (sent?.message_id) session.lastMessageId = sent.message_id;
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

  // 2. Authorize sender.
  const auth = await authorize(db, userId);
  if (!auth) {
    if (callback) await answerCallbackQuery(callback.id, "You are not authorized to add inventory.");
    else await sendMessage(chatId, "⛔ You are not authorized to add inventory.");
    return ok();
  }
  if (!auth.perms.includes("Add Inventory") && !(callback && String(callback.data).startsWith("appr:"))) {
    if (callback) await answerCallbackQuery(callback.id, "You are not authorized to add inventory.");
    else await sendMessage(chatId, "⛔ You are not authorized to add inventory.");
    return ok();
  }
  const name = String(auth.user.username || from.first_name || "Unknown");

  // Monitoring: mark the group as seen and log the update. Fire-and-forget so it
  // never adds latency to (or fails) the bot's reply.
  void recordGroupActivity(db, chatId, {
    isCommand: Boolean(callback) || Boolean(message?.text && String(message.text).startsWith("/")),
    text: callback ? `callback ${String(callback.data ?? "")}` : message?.text,
    actor: name,
  });

  // ---------------- Callback queries ----------------
  if (callback) {
    const data = String(callback.data ?? "");

    // Approval callbacks may come from a different authorized approver in the
    // same chat, so look up the awaiting session by chat rather than by user.
    let session: BotSession | null;
    if (data.startsWith("appr:")) {
      if (!auth.perms.includes("Approve Entries")) {
        await answerCallbackQuery(callback.id, "You are not authorized to approve entries.");
        return ok();
      }
      session = (await db.collection("botSessions").findOne({ chatId, status: "awaiting_approval" })) as BotSession | null;
      if (session) session.approval = { ...(session.approval ?? { stepInstanceId: "", awaitingRole: "" }), decidedBy: name };
    } else {
      session = (await db
        .collection("botSessions")
        .findOne({ chatId, userId, status: { $in: ["active", "awaiting_approval"] } })) as BotSession | null;
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

    const result = await applyCallback(db, session, data);
    session.processedUpdateIds = [...(session.processedUpdateIds ?? []), updateId].slice(-20);
    await deliver(db, session, result, callback.id);
    await saveSession(db, session);
    return ok();
  }

  // ---------------- Messages ----------------
  const text: string | undefined = message.text;
  const photos = message.photo as { file_id: string }[] | undefined;
  const imageFileId = photos?.length ? photos[photos.length - 1].file_id : undefined; // largest size

  let session = (await db
    .collection("botSessions")
    .findOne({ chatId, userId, status: { $in: ["active", "awaiting_approval"] } })) as BotSession | null;

  if (session && session.processedUpdateIds?.includes(updateId)) return ok();

  // No active session → start a new entry.
  if (!session) {
    const isCancel = text && /^\/cancel/i.test(text);
    if (isCancel) return ok();
    const resolved = await resolveWorkflow(db, chatId);
    if (!resolved) {
      await sendMessage(chatId, "No workflow is configured for this group yet.");
      return ok();
    }
    session = newSession(chatId, userId, name, resolved);
    session.dbUserId = auth.user._id.toString();

    const isCommand = text && text.startsWith("/");
    const firstStep = session.steps[0];
    // A plain (non-command) opening message doubles as the item-capture input.
    if (!isCommand && firstStep?.type === "item_capture" && (text || imageFileId)) {
      const result = await applyMessage(db, session, { text, imageFileId });
      session.processedUpdateIds = [updateId];
      await deliver(db, session, result);
      await saveSession(db, session);
      return ok();
    }
    // Otherwise just render the first step.
    session.processedUpdateIds = [updateId];
    const render = await renderCurrentStep(db, session);
    const sent = await sendMessage(chatId, render.text, render.keyboard);
    if (sent?.message_id) session.lastMessageId = sent.message_id;
    await saveSession(db, session);
    return ok();
  }

  // Global cancel while mid-entry.
  if (text && /^\/cancel/i.test(text)) {
    session.status = "cancelled";
    session.processedUpdateIds = [...(session.processedUpdateIds ?? []), updateId].slice(-20);
    await sendMessage(chatId, "Entry cancelled.");
    await saveSession(db, session);
    return ok();
  }

  const result = await applyMessage(db, session, { text, imageFileId });
  session.processedUpdateIds = [...(session.processedUpdateIds ?? []), updateId].slice(-20);
  await deliver(db, session, result);
  await saveSession(db, session);
  return ok();
}
