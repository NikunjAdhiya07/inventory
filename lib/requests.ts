import type { Db, Document, ObjectId } from "mongodb";
import { cached, invalidateCollection } from "./cache";
import { isDuplicateKeyError } from "./mongodb";
import { productNumberKey } from "./products";
import { issueKey, onHandLive, recordMovements, returnKey, type StockMovement } from "./stock";
import { nextTicketNumber, TicketSeries } from "./ticket";
import {
  isTerminal,
  MANAGER_ROLE,
  PURCHASE_ROLE,
  type ItemRequest,
  type RequestEvent,
  type RequestKind,
  type RequestLine,
  type RequestStatus,
} from "./request-types";

// Persistence and state transitions for item requests.
//
// Everything that changes a ticket's status goes through this file, and every
// one of those transitions is written as a CONDITIONAL update on the status it
// expects to find. That is not defensiveness for its own sake: a ticket's
// buttons sit in a group chat for days, so "two managers tap Accept a second
// apart" and "somebody taps a button on a ticket that was closed yesterday" are
// both routine. A conditional update makes the loser of that race a no-op
// instead of a second stock deduction.

const COLLECTION = "requests";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// The requester's live cart in this chat, if they have one.
export async function findDraft(db: Db, chatId: string, requesterUserId: string): Promise<ItemRequest | null> {
  return (await db.collection(COLLECTION).findOne({
    chatId,
    requesterUserId,
    status: "draft",
  })) as ItemRequest | null;
}

// The ticket a tapped button belongs to.
//
// Resolved by the message the button is attached to rather than by the chat: a
// group can easily have three open tickets, and a chat-wide lookup would return
// an arbitrary one of them — so an approver could act on a ticket they were
// never shown. This is the same trap the entry bot's approval callbacks hit.
export async function findByAnchor(db: Db, chatId: string, messageId: number): Promise<ItemRequest | null> {
  // Sorted newest-first rather than left to natural order. A message id is
  // unique within a chat, so this should only ever match one document — but
  // "should only ever match one" plus an unsorted `findOne` is how a tie gets
  // resolved arbitrarily, and here that would mean acting on the wrong ticket.
  const [found] = (await db
    .collection(COLLECTION)
    .find({ chatId, anchorMessageId: messageId })
    .sort({ updatedAt: -1 })
    .limit(1)
    .toArray()) as ItemRequest[];
  return found ?? null;
}

export async function findByTicket(db: Db, ticketNumber: string): Promise<ItemRequest | null> {
  return (await db.collection(COLLECTION).findOne({ ticketNumber })) as ItemRequest | null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function newDraft(
  chatId: string,
  requesterUserId: string,
  requesterDbId: string,
  requesterName: string,
  requesterHandle: string
): ItemRequest {
  const now = new Date().toISOString();
  return {
    kind: "inventory",
    status: "draft",
    chatId,
    requesterUserId,
    requesterDbId,
    requesterName,
    requesterHandle,
    lines: [],
    decisions: [],
    ui: { query: "", page: 0, focusProductId: null, focusLocationId: null, qtyDraft: "" },
    history: [],
    processedUpdateIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function saveRequest(db: Db, request: ItemRequest): Promise<void> {
  request.updatedAt = new Date().toISOString();
  if (request._id) {
    await db.collection(COLLECTION).replaceOne({ _id: request._id as ObjectId }, request as never);
  } else {
    const res = await db.collection(COLLECTION).insertOne(request as never);
    request._id = res.insertedId;
  }
}

export function note(request: ItemRequest, by: string, what: string): void {
  request.history.push({ at: new Date().toISOString(), by, what } satisfies RequestEvent);
  // A ticket that changed hands twenty times is a ticket with a problem, not a
  // ticket that needs twenty lines of history in a Telegram message.
  if (request.history.length > 20) request.history = request.history.slice(-20);
}

// ---------------------------------------------------------------------------
// Who gets tagged
// ---------------------------------------------------------------------------

export type Approver = { name: string; handle: string; tgId: string };

// Everyone who can act on a ticket at this stage: the active users holding the
// deciding role. Cached like the other role-derived reads — it changes when an
// admin moves someone in or out of a role, not between taps.
export async function approversFor(db: Db, role: string): Promise<Approver[]> {
  return cached(`roles:members:${role}`, async () => {
    const users = await db
      .collection("users")
      .find({ role, status: "Active" }, { projection: { username: 1, handle: 1, tgId: 1 } })
      .sort({ username: 1 })
      .toArray();
    return users.map((u) => ({
      name: String(u.username ?? ""),
      handle: String(u.handle ?? ""),
      tgId: String(u.tgId ?? ""),
    }));
  });
}

export function roleForKind(kind: RequestKind): string {
  return kind === "purchase" ? PURCHASE_ROLE : MANAGER_ROLE;
}

// The @-mentions that put a ticket in front of the people who must act on it.
//
// Only users with a real Telegram @username can be mentioned this way; anyone
// without one is named in plain text instead, so a manager who never set a
// username still appears on the ticket rather than silently going missing.
export function mentionList(approvers: Approver[]): string {
  if (!approvers.length) return "";
  return approvers.map((a) => (a.handle ? a.handle : `<b>${a.name}</b>`)).join(" ");
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type TransitionResult =
  | { ok: true; request: ItemRequest }
  | { ok: false; reason: string };

// Claim a status change. Returns the updated document only to the caller that
// actually made the change; everyone else gets null and must not proceed.
async function claim(
  db: Db,
  request: ItemRequest,
  from: RequestStatus | RequestStatus[],
  to: RequestStatus,
  extra: Document = {}
): Promise<ItemRequest | null> {
  const expected = Array.isArray(from) ? from : [from];
  const updated = await db.collection(COLLECTION).findOneAndUpdate(
    { _id: request._id as ObjectId, status: { $in: expected } },
    { $set: { status: to, updatedAt: new Date().toISOString(), ...extra } },
    { returnDocument: "after" }
  );
  return (updated as ItemRequest | null) ?? null;
}

// Submit a cart as an inventory request. The draft becomes a numbered ticket and
// starts waiting on an Inventory Manager.
export async function submitInventoryRequest(db: Db, request: ItemRequest): Promise<TransitionResult> {
  if (request.status !== "draft") return { ok: false, reason: "This request has already been submitted." };
  if (!request.lines.length) return { ok: false, reason: "Add at least one item first." };

  const now = new Date();
  const ticketNumber = await nextTicketNumber(db, now, TicketSeries.REQUEST);
  const claimed = await claim(db, request, "draft", "pending_manager", {
    ticketNumber,
    submittedAt: now.toISOString(),
  });
  // Lost to a double tap on Submit — the ticket the winner created is the one
  // that counts, so hand it back rather than raising a second one.
  if (!claimed) return { ok: false, reason: "This request has already been submitted." };
  return { ok: true, request: claimed };
}

// Submit a purchase request. Same shape, different series and different role.
export async function submitPurchaseRequest(db: Db, request: ItemRequest): Promise<TransitionResult> {
  if (request.status !== "draft") return { ok: false, reason: "This request has already been submitted." };
  if (!request.purchase?.name) return { ok: false, reason: "Describe the item you need first." };

  const now = new Date();
  const ticketNumber = await nextTicketNumber(db, now, TicketSeries.PURCHASE);
  const claimed = await claim(db, request, "draft", "pending_approval", {
    ticketNumber,
    submittedAt: now.toISOString(),
  });
  if (!claimed) return { ok: false, reason: "This request has already been submitted." };
  return { ok: true, request: claimed };
}

// An Inventory Manager accepts. This is the moment stock leaves and the ticket
// closes — search → submit → Accept is the whole live inventory path. (Legacy
// tickets that were accepted into `awaiting_collection` before this change still
// close via `confirmCollected` / cancel-with-return.)
export async function acceptInventoryRequest(
  db: Db,
  request: ItemRequest,
  by: string,
  byUserId: string
): Promise<TransitionResult> {
  if (request.status !== "pending_manager") {
    return { ok: false, reason: statusComplaint(request.status, "accepted") };
  }

  // Claim BEFORE touching the ledger. Two managers tapping Accept a second apart
  // must not both deduct; the loser stops here having changed nothing.
  const at = new Date().toISOString();
  const claimed = await claim(db, request, "pending_manager", "completed", { closedAt: at });
  if (!claimed) return { ok: false, reason: "Someone has already actioned this request." };

  // Re-check every line against the live ledger. The cart was built from a
  // cached balance minutes or days ago, and another request may have emptied the
  // shelf since. A line that can no longer be filled is marked unavailable and
  // moves no stock, so the manager issues what exists and the ticket says so.
  const movements: StockMovement[] = [];
  const lines: RequestLine[] = [];
  for (const line of claimed.lines) {
    const available = await onHandLive(db, line.productId, line.locationId);
    if (available < line.qty) {
      lines.push({ ...line, outcome: "unavailable" });
      continue;
    }
    lines.push({ ...line, outcome: "issued" });
    movements.push({
      movementKey: issueKey(String(claimed.ticketNumber), line.lineId),
      productId: line.productId,
      productName: line.productName,
      productNumber: line.productNumber,
      locationId: line.locationId,
      locationPath: line.locationPath,
      // Negative: this is stock leaving.
      qty: -line.qty,
      unit: line.unit,
      reason: "issue",
      refType: "request",
      refId: String(claimed.ticketNumber),
      requestId: String(claimed._id),
      by,
      createdAt: at,
    });
  }

  await recordMovements(db, movements);

  const issued = lines.filter((l) => l.outcome === "issued").length;
  claimed.lines = lines;
  claimed.decisions = [
    ...(claimed.decisions ?? []),
    { role: MANAGER_ROLE, by, byUserId, decision: "approved", at },
  ];
  note(
    claimed,
    by,
    issued === lines.length
      ? "Accepted — stock issued and request closed."
      : `Accepted ${issued} of ${lines.length} lines — stock issued and request closed.`
  );

  await db.collection(COLLECTION).updateOne(
    { _id: claimed._id as ObjectId },
    {
      $set: {
        lines: claimed.lines,
        decisions: claimed.decisions,
        history: claimed.history,
        updatedAt: at,
        closedAt: at,
      },
    }
  );

  return { ok: true, request: claimed };
}

// Reject a request outright. No stock moves, so this is a pure status change.
export async function rejectRequest(
  db: Db,
  request: ItemRequest,
  by: string,
  byUserId: string,
  role: string
): Promise<TransitionResult> {
  const from: RequestStatus[] = ["pending_manager", "pending_approval"];
  if (!from.includes(request.status)) {
    return { ok: false, reason: statusComplaint(request.status, "rejected") };
  }
  const at = new Date().toISOString();
  const claimed = await claim(db, request, from, "rejected", { closedAt: at });
  if (!claimed) return { ok: false, reason: "Someone has already actioned this request." };

  claimed.decisions = [...(claimed.decisions ?? []), { role, by, byUserId, decision: "rejected", at }];
  note(claimed, by, "Rejected the request.");
  await db
    .collection(COLLECTION)
    .updateOne({ _id: claimed._id as ObjectId }, { $set: { decisions: claimed.decisions, history: claimed.history } });
  return { ok: true, request: claimed };
}

// A Purchase Officer approves. Procurement starts; nothing hits the ledger yet
// because nothing has been bought.
export async function approvePurchase(
  db: Db,
  request: ItemRequest,
  by: string,
  byUserId: string
): Promise<TransitionResult> {
  if (request.status !== "pending_approval") {
    return { ok: false, reason: statusComplaint(request.status, "approved") };
  }
  const at = new Date().toISOString();
  const claimed = await claim(db, request, "pending_approval", "procuring");
  if (!claimed) return { ok: false, reason: "Someone has already actioned this request." };

  claimed.decisions = [
    ...(claimed.decisions ?? []),
    { role: PURCHASE_ROLE, by, byUserId, decision: "approved", at },
  ];
  note(claimed, by, "Approved for purchase.");
  await db
    .collection(COLLECTION)
    .updateOne({ _id: claimed._id as ObjectId }, { $set: { decisions: claimed.decisions, history: claimed.history } });
  return { ok: true, request: claimed };
}

// Receive a purchased item into stock, then hand the requester their share.
//
// This is what closes the loop between the two groups. A purchase exists
// precisely because no product record matched, so one is created here: the item
// enters the Product Master, an inventory entry records its arrival, and the
// ledger gets a receipt for everything that turned up followed by an issue for
// what this requester asked for. Whatever was bought over and above the request
// — the other 48 cables in the box — simply stays in stock and is findable by
// the next person who searches for it.
export async function receivePurchaseIntoStock(
  db: Db,
  request: ItemRequest,
  locationId: string,
  locationPath: string,
  receivedQty: number,
  by: string
): Promise<TransitionResult> {
  if (request.status !== "procuring") {
    return { ok: false, reason: statusComplaint(request.status, "received") };
  }
  const purchase = request.purchase;
  if (!purchase?.name) return { ok: false, reason: "This purchase has no item on it." };

  const claimed = await claim(db, request, "procuring", "awaiting_collection");
  if (!claimed) return { ok: false, reason: "Someone has already actioned this request." };

  const at = new Date().toISOString();
  const ticketNumber = String(claimed.ticketNumber);
  const product = await ensureProductForPurchase(db, purchase.name, purchase.unit, ticketNumber);

  // The arrival is a normal inventory entry, so it shows up in the console's
  // entry list beside everything the entry bot captured rather than being a
  // second, invisible way for stock to appear.
  const entryTicket = await nextTicketNumber(db, new Date(), TicketSeries.INVENTORY);
  await db
    .collection("inventoryEntries")
    .insertOne({
      ticketNumber: entryTicket,
      sessionId: `purchase:${ticketNumber}`,
      workflowId: "",
      version: 0,
      chatId: claimed.chatId,
      submittedByUserId: claimed.requesterUserId,
      submittedByName: by,
      fields: {
        itemName: purchase.name,
        productId: product.id,
        productName: product.name,
        productNumber: product.productNumber,
        attributes: [],
        category: "",
        subcategory: "",
        locationId,
        locationPath,
        quantity: receivedQty,
        unit: purchase.unit || "",
        custom: { "Purchase ticket": ticketNumber },
      },
      status: "Completed",
      createdAt: at,
    } as never)
    // The unique index on sessionId makes a retry a no-op rather than a second
    // arrival. Everything below is keyed idempotently too, so carrying on is
    // safe and the ledger still ends up right.
    .catch((err) => {
      if (!isDuplicateKeyError(err)) throw err;
    });

  const issuedQty = Math.min(purchase.qty, receivedQty);
  await recordMovements(db, [
    {
      movementKey: `purchase-receipt:${ticketNumber}`,
      productId: product.id,
      productName: product.name,
      productNumber: product.productNumber,
      locationId,
      locationPath,
      qty: receivedQty,
      unit: purchase.unit || "",
      reason: "purchase-receipt",
      refType: "request",
      refId: ticketNumber,
      requestId: String(claimed._id),
      by,
      createdAt: at,
    },
    {
      movementKey: issueKey(ticketNumber, "purchase"),
      productId: product.id,
      productName: product.name,
      productNumber: product.productNumber,
      locationId,
      locationPath,
      qty: -issuedQty,
      unit: purchase.unit || "",
      reason: "issue",
      refType: "request",
      refId: ticketNumber,
      requestId: String(claimed._id),
      by,
      createdAt: at,
    },
  ]);

  const surplus = receivedQty - issuedQty;
  note(
    claimed,
    by,
    surplus > 0
      ? `Received ${receivedQty} into ${locationPath} — ${surplus} left in stock.`
      : `Received ${receivedQty} into ${locationPath}.`
  );
  await db
    .collection(COLLECTION)
    .updateOne({ _id: claimed._id as ObjectId }, { $set: { history: claimed.history } });
  return { ok: true, request: claimed };
}

// Find or create the Product Master record a purchased item becomes.
//
// Matched on name so that buying the same thing twice does not litter the
// catalogue with duplicates. The generated product number is visibly synthetic
// so an admin can find these and give them a real one.
async function ensureProductForPurchase(
  db: Db,
  name: string,
  unit: string,
  ticketNumber: string
): Promise<{ id: string; name: string; productNumber: string }> {
  const existing = await db
    .collection("products")
    .findOne({ name }, { projection: { name: 1, productNumber: 1 } });
  if (existing) {
    return {
      id: existing._id.toString(),
      name: String(existing.name ?? ""),
      productNumber: String(existing.productNumber ?? ""),
    };
  }

  const productNumber = `AUTO-${ticketNumber}`;
  const now = new Date().toISOString();
  const doc = {
    name,
    productNumber,
    productNumberKey: productNumberKey(productNumber),
    category: "",
    subcategory: "",
    unit: unit || "",
    desc: `Created automatically from purchase ${ticketNumber}.`,
    attributes: [],
    status: "Active",
    createdAt: now,
    updatedAt: now,
  };
  try {
    const res = await db.collection("products").insertOne(doc as never);
    // The bot renders the catalogue from a cached read; without this the new
    // product is invisible to search until the TTL lapses.
    invalidateCollection("products");
    return { id: res.insertedId.toString(), name, productNumber };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Two receipts of the same purchase raced. Whichever row landed is the one
    // to use.
    const raced = await db.collection("products").findOne({ productNumberKey: productNumberKey(productNumber) });
    return {
      id: String(raced?._id ?? ""),
      name: String(raced?.name ?? name),
      productNumber: String(raced?.productNumber ?? productNumber),
    };
  }
}

// A purchased item has arrived and is ready for the requester to collect.
export async function markProcured(db: Db, request: ItemRequest, by: string): Promise<TransitionResult> {
  if (request.status !== "procuring") {
    return { ok: false, reason: statusComplaint(request.status, "marked as delivered") };
  }
  const claimed = await claim(db, request, "procuring", "awaiting_collection");
  if (!claimed) return { ok: false, reason: "Someone has already actioned this request." };
  note(claimed, by, "Item procured — ready to collect.");
  await db
    .collection(COLLECTION)
    .updateOne({ _id: claimed._id as ObjectId }, { $set: { history: claimed.history } });
  return { ok: true, request: claimed };
}

// Legacy: closes a ticket that was accepted into `awaiting_collection` before
// Accept started completing tickets directly. New inventory Accepts never land here.
export async function confirmCollected(db: Db, request: ItemRequest, by: string): Promise<TransitionResult> {
  if (request.status !== "awaiting_collection") {
    return { ok: false, reason: statusComplaint(request.status, "confirmed as received") };
  }
  const at = new Date().toISOString();
  const claimed = await claim(db, request, "awaiting_collection", "completed", { closedAt: at });
  if (!claimed) return { ok: false, reason: "This request is already closed." };
  note(claimed, by, "Confirmed receipt.");
  await db
    .collection(COLLECTION)
    .updateOne({ _id: claimed._id as ObjectId }, { $set: { history: claimed.history } });
  return { ok: true, request: claimed };
}

// Cancel a ticket. A draft / pending ticket simply closes; a legacy accepted
// ticket still in `awaiting_collection` must return issued stock to the ledger.
// New Accepts go straight to `completed`, so they are terminal and cannot cancel.
export async function cancelRequest(db: Db, request: ItemRequest, by: string): Promise<TransitionResult> {
  if (isTerminal(request.status)) return { ok: false, reason: "This request is already closed." };

  // Only legacy tickets: Accept used to leave inventory requests here with stock already issued.
  const wasIssued = request.status === "awaiting_collection" && request.kind === "inventory";
  const at = new Date().toISOString();
  const claimed = await claim(db, request, request.status, "cancelled", { closedAt: at });
  if (!claimed) return { ok: false, reason: "This request has already been actioned." };

  if (wasIssued) {
    // Mirror movements, keyed independently of the issues so both rows coexist
    // and the ledger reads as what actually happened: out on Tuesday, back on
    // Thursday.
    const movements: StockMovement[] = claimed.lines
      .filter((l) => l.outcome === "issued")
      .map((line) => ({
        movementKey: returnKey(String(claimed.ticketNumber), line.lineId),
        productId: line.productId,
        productName: line.productName,
        productNumber: line.productNumber,
        locationId: line.locationId,
        locationPath: line.locationPath,
        qty: line.qty,
        unit: line.unit,
        reason: "return" as const,
        refType: "request" as const,
        refId: String(claimed.ticketNumber),
        requestId: String(claimed._id),
        by,
        createdAt: at,
      }));
    await recordMovements(db, movements);
    note(claimed, by, "Cancelled — issued items returned to stock.");
  } else {
    note(claimed, by, "Cancelled the request.");
  }

  await db
    .collection(COLLECTION)
    .updateOne({ _id: claimed._id as ObjectId }, { $set: { history: claimed.history } });
  return { ok: true, request: claimed };
}

// Why a button could not be honoured, phrased for the person who tapped it.
// A stale keyboard is the normal cause, so the message says what the ticket is
// now rather than just refusing.
function statusComplaint(status: RequestStatus, attempted: string): string {
  const where: Record<RequestStatus, string> = {
    draft: "still a draft",
    pending_manager: "waiting on the Inventory Manager",
    pending_approval: "waiting on purchase approval",
    procuring: "being purchased",
    awaiting_collection: "waiting to be collected",
    completed: "already completed",
    rejected: "already rejected",
    cancelled: "already cancelled",
  };
  return `This request can't be ${attempted} — it is ${where[status]}.`;
}
