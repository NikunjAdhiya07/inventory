import type { Db, ObjectId } from "mongodb";
import { locationPathById } from "./locations";
import {
  applyDeliveryLocation,
  applyDraftCallback,
  applyRequestMessage,
  esc,
  money,
  renderDeliveryChoice,
  renderDeliveryLocation,
  renderRequest,
  type RenderResult,
} from "./request-engine";
import {
  acceptInventoryRequest,
  approvePurchase,
  cancelRequest,
  confirmCollected,
  findByAnchor,
  findDraft,
  markProcured,
  newDraft,
  receivePurchaseIntoStock,
  rejectRequest,
  saveRequest,
  submitInventoryRequest,
  submitPurchaseRequest,
  type TransitionResult,
} from "./requests";
import {
  isTerminal,
  MANAGER_ROLE,
  PERM_APPROVE_PURCHASE,
  PERM_ISSUE,
  PERM_REQUEST,
  PURCHASE_ROLE,
  type ItemRequest,
} from "./request-types";
import { answerCallbackQuery, editMessageText, sendMessage, type InlineKeyboard } from "./telegram";
import { isMoveCallback } from "./move-engine";

// Recording a ledger movement from the search group: Inventory Managers (Issue)
// and anyone who can Add Inventory. Request-only roles stay on the request path.
const PERM_ADD = "Add Inventory";
function canRecordMovement(perms: string[]): boolean {
  return perms.includes(PERM_ISSUE) || perms.includes(PERM_ADD);
}

// Everything the bot does in a `request`-mode group.
//
// Live path: search → cart → submit → Inventory Manager Accept (issues stock and
// closes). Purchase / collection callbacks below remain only for tickets opened
// before that simplification.
//
// Kept out of the webhook route for the same reason the workflow engine is: the
// route's job is to authenticate an update and decide which flow owns it, and
// that decision is hard to see when the flows themselves are inlined around it.

export type RequestContext = {
  chatId: string;
  updateId: number;
  userId: string;
  name: string;
  handle: string;
  dbUserId: string;
  perms: string[];
  message?: { text?: string };
  callback?: { id: string; data: string; messageId?: number };
};

// Draft-stage callbacks, which only the requester may drive. Everything else is
// a status transition and carries its own permission check.
const DRAFT_PREFIXES = [
  "rq:cart",
  "rq:back",
  "rq:new",
  "rq:pf:",
  "rq:pg:",
  "rq:s:",
  "rq:l:",
  "rq:q:",
  "rq:rm:",
  "rq:mv:",
];

function isDraftCallback(data: string): boolean {
  return DRAFT_PREFIXES.some((p) => data.startsWith(p));
}

// Draw into the ticket's single anchor message, sending a fresh one if the edit
// fails (message deleted, or past Telegram's 48h edit window) so a ticket can
// never dead-end mid-flow.
async function render(request: ItemRequest, result: RenderResult): Promise<void> {
  if (request.anchorMessageId) {
    const res = await editMessageText(request.chatId, request.anchorMessageId, result.text, result.keyboard);
    if (res.ok || res.notModified) return;
  }
  const sent = await sendMessage(request.chatId, result.text, result.keyboard);
  if (sent?.message_id) request.anchorMessageId = sent.message_id;
}

export async function handleRequestUpdate(db: Db, ctx: RequestContext): Promise<void> {
  if (ctx.callback) return handleCallback(db, ctx, ctx.callback);
  return handleMessage(db, ctx);
}

// ---------------------------------------------------------------------------
// Typed messages
// ---------------------------------------------------------------------------

async function handleMessage(db: Db, ctx: RequestContext): Promise<void> {
  const text = (ctx.message?.text ?? "").trim();
  if (!text) return;

  // `/cancel` drops whatever draft is open. Handled before the permission check
  // so someone whose access was just removed can still clear their own cart.
  if (/^\/cancel\b/i.test(text)) {
    const draft = await findDraft(db, ctx.chatId, ctx.userId);
    if (!draft) return;
    const res = await cancelRequest(db, draft, ctx.name);
    if (res.ok) await render(res.request, await renderRequest(db, res.request));
    return;
  }

  if (!ctx.perms.includes(PERM_REQUEST)) {
    await sendMessage(
      ctx.chatId,
      `⛔ Your role can't raise requests. Ask an admin to grant it the "${PERM_REQUEST}" permission.`
    );
    return;
  }

  // A slash command that is not one of ours is chatter, not a search. Without
  // this, `/start` in a busy group would open a cart nobody asked for.
  const query = /^\/(find|request|search|need)\b/i.test(text) ? text.replace(/^\/\w+\s*/, "") : text;
  if (text.startsWith("/") && query === text) return;

  let draft = await findDraft(db, ctx.chatId, ctx.userId);
  if (draft && draft.processedUpdateIds?.includes(ctx.updateId)) return;

  if (!draft) {
    draft = newDraft(ctx.chatId, ctx.userId, ctx.dbUserId, ctx.name, ctx.handle);
    // A bare `/request` with nothing after it opens an empty cart and its prompt
    // rather than searching for the empty string.
    if (query) {
      draft.ui.query = query.slice(0, 60);
      draft.ui.page = 0;
    }
    draft.processedUpdateIds = [ctx.updateId];
    await render(draft, await renderRequest(db, draft));
    await saveRequest(db, draft);
    return;
  }

  const result = await applyRequestMessage(db, draft, query);
  draft.processedUpdateIds = [...(draft.processedUpdateIds ?? []), ctx.updateId].slice(-20);
  if (result.render) await render(draft, result.render);
  else if (result.notice) await sendMessage(ctx.chatId, result.notice);
  await saveRequest(db, draft);
}

// ---------------------------------------------------------------------------
// Button taps
// ---------------------------------------------------------------------------

async function handleCallback(
  db: Db,
  ctx: RequestContext,
  callback: { id: string; data: string; messageId?: number }
): Promise<void> {
  const data = callback.data;

  const request =
    typeof callback.messageId === "number" ? await findByAnchor(db, ctx.chatId, callback.messageId) : null;

  if (!request) {
    await answerCallbackQuery(callback.id, "This request is no longer open. Send what you need to start again.");
    return;
  }

  if (request.processedUpdateIds?.includes(ctx.updateId)) {
    await answerCallbackQuery(callback.id);
    return;
  }
  request.processedUpdateIds = [...(request.processedUpdateIds ?? []), ctx.updateId].slice(-20);

  const outcome = await routeCallback(db, ctx, request, data);

  // A refusal leaves the ticket exactly as it was, so there is nothing to
  // redraw — the toast is the whole response.
  if (outcome.notice && !outcome.render) {
    await Promise.all([answerCallbackQuery(callback.id, outcome.notice), persist(db, request)]);
    return;
  }

  await Promise.all([
    answerCallbackQuery(callback.id, outcome.notice),
    (async () => {
      if (outcome.render) await render(outcome.request ?? request, outcome.render);
    })(),
  ]);
  await persist(db, outcome.request ?? request);
}

// Persist the replay guard and anchor id without clobbering fields a transition
// wrote straight to the database.
//
// A transition returns the document as it stood AFTER its own conditional
// update, so writing the whole thing back would be safe — but a draft that never
// transitioned has only ever existed in memory, and that one has to be saved
// whole. The two cases are told apart by whether the ticket has a number yet.
async function persist(db: Db, request: ItemRequest): Promise<void> {
  if (!request.ticketNumber) {
    await saveRequest(db, request);
    return;
  }
  await db.collection("requests").updateOne(
    { _id: request._id as ObjectId },
    {
      $set: {
        processedUpdateIds: request.processedUpdateIds,
        anchorMessageId: request.anchorMessageId,
        ui: request.ui,
        updatedAt: new Date().toISOString(),
      },
    }
  );
}

type Outcome = { render?: RenderResult; notice?: string; request?: ItemRequest };

async function routeCallback(
  db: Db,
  ctx: RequestContext,
  request: ItemRequest,
  data: string
): Promise<Outcome> {
  const isRequester = request.requesterUserId === ctx.userId;

  if (isTerminal(request.status) && data !== "rq:cancel") {
    return { notice: "This request is already closed." };
  }

  // ---- draft stage: the requester's cart / stock-movement sub-flow ----
  if (isDraftCallback(data)) {
    if (!isRequester) return { notice: "Only the person who opened this request can change it." };
    if (request.status !== "draft") return { notice: "This request has already been submitted." };

    // Record movement needs Issue Inventory or Add Inventory; Request item stays
    // on the existing Request Items permission (checked when submitting).
    if (isMoveCallback(data) && (data === "rq:mv:rec" || data === "rq:mv:ok")) {
      if (!canRecordMovement(ctx.perms)) {
        return {
          notice: `Your role can't record stock movements. Ask an admin to grant "${PERM_ISSUE}" or "${PERM_ADD}".`,
        };
      }
    }

    const res = await applyDraftCallback(db, request, data, ctx.name);
    return { render: res.render, notice: res.notice };
  }

  if (data === "rq:cancel") {
    // A requester withdraws their own; a manager can clear one that is stuck.
    if (!isRequester && !ctx.perms.includes(PERM_ISSUE)) {
      return { notice: "Only the requester or an Inventory Manager can cancel this." };
    }
    return transition(db, request, await cancelRequest(db, request, ctx.name));
  }

  if (data === "rq:sub") {
    if (!isRequester) return { notice: "Only the person who opened this request can submit it." };
    if (!ctx.perms.includes(PERM_REQUEST)) return { notice: `Your role can't raise requests.` };
    const res =
      request.kind === "purchase"
        ? await submitPurchaseRequest(db, request)
        : await submitInventoryRequest(db, request);
    return transition(db, request, res);
  }

  // ---- Inventory Manager ----
  if (data === "rq:acc" || data === "rq:rej") {
    if (!ctx.perms.includes(PERM_ISSUE)) {
      return { notice: `Only the ${MANAGER_ROLE} can action this request.` };
    }
    const res =
      data === "rq:acc"
        ? await acceptInventoryRequest(db, request, ctx.name, ctx.userId)
        : await rejectRequest(db, request, ctx.name, ctx.userId, MANAGER_ROLE);
    return transition(db, request, res);
  }

  // ---- Purchase Officer (legacy open purchase tickets) ----
  if (data === "rq:papp" || data === "rq:prej") {
    if (!ctx.perms.includes(PERM_APPROVE_PURCHASE)) {
      return { notice: `Only the ${PURCHASE_ROLE} can approve purchases.` };
    }
    const res =
      data === "rq:papp"
        ? await approvePurchase(db, request, ctx.name, ctx.userId)
        : await rejectRequest(db, request, ctx.name, ctx.userId, PURCHASE_ROLE);
    return transition(db, request, res);
  }

  // ---- delivery of a purchased item (legacy) ----
  if (data === "rq:deliv" || data.startsWith("rq:dl:") || data.startsWith("rq:dloc:") || data.startsWith("rq:rq:")) {
    if (!ctx.perms.includes(PERM_APPROVE_PURCHASE) && !ctx.perms.includes(PERM_ISSUE)) {
      return { notice: "You can't mark this delivered." };
    }
    return handleDelivery(db, ctx, request, data);
  }

  // Legacy collection confirm — new Accepts complete immediately.
  if (data === "rq:got") {
    if (!isRequester) return { notice: "Only the requester can confirm they received the items." };
    return transition(db, request, await confirmCollected(db, request, ctx.name));
  }

  return { notice: "Use the buttons above." };
}

// Turn a transition result into a redraw or a toast.
async function transition(db: Db, fallback: ItemRequest, res: TransitionResult): Promise<Outcome> {
  if (!res.ok) return { notice: res.reason };
  // The transition already wrote the status; carry the in-memory replay guard
  // and anchor across so `persist` does not lose them.
  res.request.processedUpdateIds = fallback.processedUpdateIds;
  res.request.anchorMessageId = fallback.anchorMessageId;
  return { render: await renderRequest(db, res.request), request: res.request };
}

// The "purchase delivered" sub-flow: choose stock-or-direct, then (for stock) a
// location and the quantity that actually arrived.
async function handleDelivery(
  db: Db,
  ctx: RequestContext,
  request: ItemRequest,
  data: string
): Promise<Outcome> {
  const ui = request.ui;

  if (data === "rq:deliv") {
    ui.deliveryStage = "choice";
    return { render: renderDeliveryChoice(request), request };
  }

  if (data === "rq:dl:direct") {
    ui.deliveryStage = null;
    return transition(db, request, await markProcured(db, request, ctx.name));
  }

  if (data === "rq:dl:stock") {
    ui.deliveryStage = "location";
    ui.locCursor = null;
    ui.locStack = [];
    return { render: await renderDeliveryLocation(db, request), request };
  }

  if (data === "rq:dl:back") {
    // Back climbs the location tree first, then leaves the sub-flow entirely.
    if (ui.deliveryStage === "qty") {
      ui.deliveryStage = "location";
      return { render: await renderDeliveryLocation(db, request), request };
    }
    if (ui.deliveryStage === "location" && ui.locStack?.length) {
      ui.locCursor = ui.locStack.pop() ?? null;
      return { render: await renderDeliveryLocation(db, request), request };
    }
    if (ui.deliveryStage === "location") {
      ui.deliveryStage = "choice";
      return { render: renderDeliveryChoice(request), request };
    }
    ui.deliveryStage = null;
    return { render: await renderRequest(db, request), request };
  }

  if (data.startsWith("rq:dloc:")) {
    const res = await applyDeliveryLocation(db, request, data);
    if (res.notice) return { notice: res.notice };
    if (!res.chosen) return { render: await renderDeliveryLocation(db, request), request };

    ui.recvLocationId = res.chosen;
    ui.recvLocationPath = await locationPathById(db, res.chosen);
    ui.deliveryStage = "qty";
    // Pre-fill with what was asked for: the common case is that exactly the
    // requested quantity arrived, and the receiver only has to tap Confirm.
    ui.recvQtyDraft = String(request.purchase?.qty ?? "");
    return { render: renderReceiveQty(request), request };
  }

  if (data.startsWith("rq:rq:")) {
    const pressed = data.slice("rq:rq:".length);
    let draft = ui.recvQtyDraft ?? "";

    if (pressed === "ok") {
      const qty = Number(draft);
      if (!draft || !Number.isFinite(qty) || qty <= 0) return { notice: "Enter how many arrived." };
      const res = await receivePurchaseIntoStock(
        db,
        request,
        String(ui.recvLocationId),
        String(ui.recvLocationPath ?? ""),
        qty,
        ctx.name
      );
      ui.deliveryStage = null;
      return transition(db, request, res);
    }

    if (pressed === "del") draft = draft.slice(0, -1);
    else if (pressed === ".") {
      if (draft.includes(".")) return { notice: "Only one decimal point." };
      draft = draft === "" ? "0." : `${draft}.`;
    } else {
      if (draft.replace(".", "").length >= 9) return { notice: "That's as large as a quantity can get." };
      draft = draft === "0" ? pressed : draft + pressed;
    }
    ui.recvQtyDraft = draft;
    return { render: renderReceiveQty(request), request };
  }

  return { notice: "Use the buttons above." };
}

function renderReceiveQty(request: ItemRequest): RenderResult {
  const p = request.purchase;
  const draft = request.ui.recvQtyDraft ?? "";
  const text =
    `📦 <b>${esc(request.ticketNumber ?? "")}</b> — how many arrived?\n\n` +
    `<b>Item:</b> ${esc(p?.name ?? "")}\n` +
    `<b>Storing at:</b> ${esc(request.ui.recvLocationPath ?? "")}\n` +
    `<i>Requested: ${money(p?.qty ?? 0)} ${esc(p?.unit ?? "")}</i>\n\n` +
    `Received: <b>${draft || "—"}</b>\n\n` +
    `<i>Anything over the requested amount stays in stock.</i>`;

  const key = (d: string) => ({ text: d, callback_data: `rq:rq:${d}` });
  const keyboard: InlineKeyboard = [
    ["1", "2", "3"].map(key),
    ["4", "5", "6"].map(key),
    ["7", "8", "9"].map(key),
    [key("."), key("0"), { text: "⌫", callback_data: "rq:rq:del" }],
    [{ text: "✔ Confirm receipt", callback_data: "rq:rq:ok" }],
    [{ text: "⬅ Back", callback_data: "rq:dl:back" }],
  ];
  return { text, keyboard };
}
