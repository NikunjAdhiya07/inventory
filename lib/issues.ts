import { ObjectId } from "mongodb";
import type { Db, Document } from "mongodb";
import { cached } from "./cache";
import { issueKey, onHandLive, recordMovements, returnKey, type StockMovement } from "./stock";
import { nextTicketNumber, TicketSeries } from "./ticket";
import {
  isTerminal,
  STORE_ROLE,
  type AnyStatus,
  type MaterialLine,
  type MaterialTicket,
  type TicketEvent,
} from "./issue-types";

// Persistence and state transitions for material issue / return tickets.
//
// Every status change is a CONDITIONAL update on the status it expects to find.
// These tickets sit in a group chat for days with live buttons on them, so "two
// store workers tap Accept a second apart" and "somebody taps a button on a
// ticket that closed on Tuesday" are routine rather than exotic. A conditional
// update makes the loser of that race a no-op instead of a second stock
// movement.

const COLLECTION = "issueTickets";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// This person's live cart in this chat, of this kind. A store head building an
// issue and the same person part-way through a return are two separate drafts,
// so the kind is part of the lookup.
export async function findDraft(
  db: Db,
  chatId: string,
  createdByUserId: string,
  kind: "issue" | "return"
): Promise<MaterialTicket | null> {
  return (await db.collection(COLLECTION).findOne({
    chatId,
    createdByUserId,
    kind,
    status: "draft",
  })) as MaterialTicket | null;
}

// The ticket a tapped button belongs to.
//
// Resolved by the message the button is attached to rather than by the chat: a
// store group will routinely have half a dozen open tickets, and a chat-wide
// lookup would return an arbitrary one of them — so a store head could
// acknowledge a handover they were never shown.
export async function findByAnchor(db: Db, chatId: string, messageId: number): Promise<MaterialTicket | null> {
  // Sorted rather than left to natural order. A message id is unique within a
  // chat so this should only ever match one document, but "should only ever
  // match one" plus an unsorted findOne is how a tie gets broken arbitrarily,
  // and here that means acting on the wrong ticket.
  const [found] = (await db
    .collection(COLLECTION)
    .find({ chatId, anchorMessageId: messageId })
    .sort({ updatedAt: -1 })
    .limit(1)
    .toArray()) as MaterialTicket[];
  return found ?? null;
}

export async function findByTicket(db: Db, ticketNumber: string): Promise<MaterialTicket | null> {
  return (await db.collection(COLLECTION).findOne({ ticketNumber })) as MaterialTicket | null;
}

export async function findById(db: Db, id: string): Promise<MaterialTicket | null> {
  if (!ObjectId.isValid(id)) return null;
  return (await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) })) as MaterialTicket | null;
}

// Issues still owed an answer by this person. What "/mine" reports and what
// stops a second issue being raised before the first is settled.
export async function openIssuesFor(db: Db, chatId: string, recipientUserId: string): Promise<MaterialTicket[]> {
  return (await db
    .collection(COLLECTION)
    .find({
      chatId,
      kind: "issue",
      "recipient.userId": recipientUserId,
      status: { $in: ["awaiting_ack", "acknowledged", "disputed"] },
    })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray()) as MaterialTicket[];
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export type Person = { dbId: string; name: string; handle: string; tgId: string; role: string };

// Everyone who could be handed materials: active users with a Telegram id.
//
// Cached like the other role-derived reads — the roster changes when an admin
// adds someone, not between taps. Anyone without a `tgId` is excluded: they
// could never acknowledge the ticket, so offering them would only produce
// handovers that can never be signed for.
export async function issuablePeople(db: Db): Promise<Person[]> {
  return cached("users:issuable", async () => {
    const users = await db
      .collection("users")
      .find(
        { status: "Active", tgId: { $exists: true, $nin: ["", null] } },
        { projection: { username: 1, handle: 1, tgId: 1, role: 1 } }
      )
      .sort({ username: 1 })
      .toArray();
    return users.map((u) => ({
      dbId: u._id.toString(),
      name: String(u.username ?? ""),
      handle: String(u.handle ?? ""),
      tgId: String(u.tgId ?? ""),
      role: String(u.role ?? ""),
    }));
  });
}

export { approversFor, mentionList, type Approver } from "./requests";

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function newIssueDraft(
  chatId: string,
  createdByUserId: string,
  createdByDbId: string,
  createdByName: string,
  createdByHandle: string
): MaterialTicket {
  const now = new Date().toISOString();
  return {
    kind: "issue",
    status: "draft",
    chatId,
    createdByUserId,
    createdByDbId,
    createdByName,
    createdByHandle,
    lines: [],
    ui: { stage: "search", query: "", page: 0, focusProductId: null, focusLocationId: null, qtyDraft: "" },
    history: [],
    processedUpdateIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

// A return draft is seeded from its parent's outstanding lines rather than built
// by search. The recipient is answering for specific materials they were handed,
// so offering them the whole catalogue would be offering them the wrong question
// — and would let them return something they were never issued.
export function newReturnDraft(
  issue: MaterialTicket,
  createdByUserId: string,
  createdByDbId: string,
  createdByName: string,
  createdByHandle: string
): MaterialTicket {
  const now = new Date().toISOString();
  return {
    kind: "return",
    status: "draft",
    chatId: issue.chatId,
    createdByUserId,
    createdByDbId,
    createdByName,
    createdByHandle,
    recipient: issue.recipient,
    issueTicketId: String(issue._id),
    issueTicketNumber: issue.ticketNumber,
    // Every issued line starts at zero coming back. The recipient raises the
    // ones that did, and whatever they leave at zero is what the job consumed.
    lines: outstandingLines(issue).map((l) => ({
      ...l,
      issueLineId: l.lineId,
      issuedQty: l.qty,
      qty: 0,
    })),
    ui: { stage: null, query: "", page: 0, focusReturnLineId: null, qtyDraft: "" },
    history: [],
    processedUpdateIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

// The lines of an issue that actually left the store and have not yet been
// accounted for. A line the shelf could not fill never left, so it is not
// something anyone can return.
export function outstandingLines(issue: MaterialTicket): MaterialLine[] {
  return issue.lines.filter((l) => l.outcome === "issued" && l.returnedQty === undefined);
}

export async function saveTicket(db: Db, ticket: MaterialTicket): Promise<void> {
  ticket.updatedAt = new Date().toISOString();
  if (ticket._id) {
    await db.collection(COLLECTION).replaceOne({ _id: ticket._id as ObjectId }, ticket as never);
  } else {
    const res = await db.collection(COLLECTION).insertOne(ticket as never);
    ticket._id = res.insertedId;
  }
}

export function note(ticket: MaterialTicket, by: string, what: string): void {
  ticket.history.push({ at: new Date().toISOString(), by, what } satisfies TicketEvent);
  // A ticket that changed hands twenty times is a ticket with a problem, not one
  // that needs twenty lines of history in a Telegram message.
  if (ticket.history.length > 20) ticket.history = ticket.history.slice(-20);
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type TransitionResult = { ok: true; ticket: MaterialTicket } | { ok: false; reason: string };

// Claim a status change. Only the caller that actually made the change gets the
// updated document back; everyone else gets null and must not proceed.
async function claim(
  db: Db,
  ticket: MaterialTicket,
  from: AnyStatus | AnyStatus[],
  to: AnyStatus,
  extra: Document = {}
): Promise<MaterialTicket | null> {
  const expected = Array.isArray(from) ? from : [from];
  const updated = await db.collection(COLLECTION).findOneAndUpdate(
    { _id: ticket._id as ObjectId, status: { $in: expected } },
    { $set: { status: to, updatedAt: new Date().toISOString(), ...extra } },
    { returnDocument: "after" }
  );
  return (updated as MaterialTicket | null) ?? null;
}

// Persist the fields a transition changed outside of `claim`'s $set.
async function writeBack(db: Db, ticket: MaterialTicket, extra: Document = {}): Promise<void> {
  await db.collection(COLLECTION).updateOne(
    { _id: ticket._id as ObjectId },
    { $set: { lines: ticket.lines, history: ticket.history, updatedAt: new Date().toISOString(), ...extra } }
  );
}

// Issue the materials.
//
// This is the moment stock leaves, because by the time the store writes the
// ticket the materials are already on their way out of the door. Each line is
// re-checked against the LIVE ledger first: the cart was built from a cached
// balance, and between the search and the Issue tap another ticket may have
// emptied that shelf. A line that can no longer be filled is marked unavailable
// and moves nothing, so the store issues what exists and the ticket says so
// rather than silently driving a balance negative.
export async function submitIssue(db: Db, ticket: MaterialTicket): Promise<TransitionResult> {
  if (ticket.kind !== "issue") return { ok: false, reason: "That is not an issue ticket." };
  if (ticket.status !== "draft") return { ok: false, reason: "This issue has already been submitted." };
  if (!ticket.lines.length) return { ok: false, reason: "Add at least one material first." };
  if (!ticket.recipient?.userId) return { ok: false, reason: "Choose who these materials are going to first." };

  const now = new Date();
  const at = now.toISOString();
  const ticketNumber = await nextTicketNumber(db, now, TicketSeries.ISSUE);

  // Claim BEFORE touching the ledger. Two taps on Issue a second apart must not
  // both deduct; the loser stops here having changed nothing.
  const claimed = await claim(db, ticket, "draft", "awaiting_ack", { ticketNumber, submittedAt: at });
  if (!claimed) return { ok: false, reason: "This issue has already been submitted." };

  const movements: StockMovement[] = [];
  const lines: MaterialLine[] = [];
  for (const line of claimed.lines) {
    const available = await onHandLive(db, line.productId, line.locationId);
    if (available < line.qty) {
      lines.push({ ...line, outcome: "unavailable" });
      continue;
    }
    lines.push({ ...line, outcome: "issued" });
    movements.push({
      movementKey: issueKey(ticketNumber, line.lineId),
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
      refId: ticketNumber,
      requestId: String(claimed._id),
      by: claimed.createdByName,
      createdAt: at,
    });
  }

  await recordMovements(db, movements);

  const issued = lines.filter((l) => l.outcome === "issued").length;
  claimed.lines = lines;
  note(
    claimed,
    claimed.createdByName,
    issued === lines.length
      ? `Issued ${issued} line(s) to ${claimed.recipient?.name ?? "—"}.`
      : `Issued ${issued} of ${lines.length} lines to ${claimed.recipient?.name ?? "—"} — the rest were out of stock.`
  );
  await writeBack(db, claimed);
  return { ok: true, ticket: claimed };
}

// The recipient signs for the materials. Nothing moves — the stock left at
// submit — so this is a pure status change that opens the return path.
export async function acknowledgeIssue(db: Db, ticket: MaterialTicket, by: string): Promise<TransitionResult> {
  if (ticket.status !== "awaiting_ack" && ticket.status !== "disputed") {
    return { ok: false, reason: statusComplaint(ticket, "acknowledged") };
  }
  const at = new Date().toISOString();
  const claimed = await claim(db, ticket, ["awaiting_ack", "disputed"], "acknowledged", { acknowledgedAt: at });
  if (!claimed) return { ok: false, reason: "This issue has already been actioned." };
  note(claimed, by, "Acknowledged receipt of the materials.");
  await writeBack(db, claimed);
  return { ok: true, ticket: claimed };
}

// The recipient says the materials never reached them. The stock stays deducted
// on purpose: something did leave the shelf, and the ledger should not pretend
// otherwise until somebody has physically looked. Cancelling is what puts it
// back.
export async function disputeIssue(db: Db, ticket: MaterialTicket, by: string): Promise<TransitionResult> {
  if (ticket.status !== "awaiting_ack") {
    return { ok: false, reason: statusComplaint(ticket, "disputed") };
  }
  const claimed = await claim(db, ticket, "awaiting_ack", "disputed");
  if (!claimed) return { ok: false, reason: "This issue has already been actioned." };
  note(claimed, by, "Says these materials were not received.");
  await writeBack(db, claimed);
  return { ok: true, ticket: claimed };
}

// Cancel an issue. Anything already deducted goes back on the shelf.
//
// The credit is keyed independently of the original deduction so both rows
// coexist and the ledger reads as what actually happened: out on Tuesday, back
// on Tuesday — rather than as an event that was quietly edited away.
export async function cancelIssue(db: Db, ticket: MaterialTicket, by: string): Promise<TransitionResult> {
  if (isTerminal(ticket.status)) return { ok: false, reason: "This ticket is already closed." };

  const wasIssued = ticket.status === "awaiting_ack" || ticket.status === "acknowledged" || ticket.status === "disputed";
  const at = new Date().toISOString();
  const claimed = await claim(db, ticket, ticket.status, "cancelled", { closedAt: at });
  if (!claimed) return { ok: false, reason: "This ticket has already been actioned." };

  if (wasIssued) {
    const movements: StockMovement[] = outstandingLines(claimed).map((line) => ({
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
    note(claimed, by, "Cancelled — the materials went back into stock.");
  } else {
    note(claimed, by, "Cancelled the issue.");
  }

  await writeBack(db, claimed);
  return { ok: true, ticket: claimed };
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

// Submit the return for the store to confirm. Nothing hits the ledger here — see
// `acceptReturn`.
export async function submitReturn(db: Db, ticket: MaterialTicket, issue: MaterialTicket | null): Promise<TransitionResult> {
  if (ticket.kind !== "return") return { ok: false, reason: "That is not a return ticket." };
  if (ticket.status !== "draft") return { ok: false, reason: "This return has already been submitted." };
  if (!issue) return { ok: false, reason: "The issue this return belongs to is missing." };
  if (issue.status !== "acknowledged") {
    return { ok: false, reason: `${issue.ticketNumber} is ${plainStatus(issue)} — a return can only be raised against an acknowledged issue.` };
  }

  const now = new Date();
  const at = now.toISOString();
  const ticketNumber = await nextTicketNumber(db, now, TicketSeries.RETURN);
  const claimed = await claim(db, ticket, "draft", "pending_store", { ticketNumber, submittedAt: at });
  if (!claimed) return { ok: false, reason: "This return has already been submitted." };

  const returning = claimed.lines.filter((l) => l.qty > 0).length;
  note(
    claimed,
    claimed.createdByName,
    returning
      ? `Returning ${returning} line(s); the rest were consumed on the job.`
      : "Nothing left over — everything was consumed on the job."
  );
  await writeBack(db, claimed);
  return { ok: true, ticket: claimed };
}

// The store confirms it has the materials back. This is where the ledger moves
// and where the parent issue is settled.
//
// Both documents are claimed, the return first: it is the one with the live
// button, so it is the one a double tap races on. If the parent turns out to
// have been settled by another return in the meantime, the return is rolled back
// to `pending_store` and refused — safe to do precisely because no stock has
// moved yet at that point.
export async function acceptReturn(
  db: Db,
  ticket: MaterialTicket,
  by: string
): Promise<TransitionResult & { issue?: MaterialTicket }> {
  if (ticket.kind !== "return") return { ok: false, reason: "That is not a return ticket." };
  if (ticket.status !== "pending_store") return { ok: false, reason: statusComplaint(ticket, "accepted") };

  const at = new Date().toISOString();
  const claimed = await claim(db, ticket, "pending_store", "accepted", { closedAt: at });
  if (!claimed) return { ok: false, reason: "Someone has already actioned this return." };

  const issue = claimed.issueTicketId ? await findById(db, claimed.issueTicketId) : null;
  if (!issue) {
    await claim(db, claimed, "accepted", "pending_store", { closedAt: null });
    return { ok: false, reason: "The issue this return belongs to is missing." };
  }

  const settledIssue = await claim(db, issue, "acknowledged", "settled", { closedAt: at });
  if (!settledIssue) {
    await claim(db, claimed, "accepted", "pending_store", { closedAt: null });
    return { ok: false, reason: `${issue.ticketNumber} has already been settled by another return.` };
  }

  // Credit back only what is actually coming in. A line left at zero is not a
  // movement — the materials were used, and the ledger already recorded them
  // leaving at issue time.
  const movements: StockMovement[] = claimed.lines
    .filter((l) => l.qty > 0)
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

  // Settle the parent. Consumption is derived, never entered: whatever did not
  // come back is what the job used, which is exactly the arithmetic the store
  // does in its head today.
  const returnedBy = new Map(claimed.lines.map((l) => [String(l.issueLineId), l.qty]));
  settledIssue.lines = settledIssue.lines.map((l) => {
    if (l.outcome !== "issued" || l.returnedQty !== undefined) return l;
    const returned = Math.min(returnedBy.get(l.lineId) ?? 0, l.qty);
    return { ...l, returnedQty: returned, consumedQty: l.qty - returned };
  });

  const totalReturned = settledIssue.lines.reduce((s, l) => s + (l.returnedQty ?? 0), 0);
  const totalConsumed = settledIssue.lines.reduce((s, l) => s + (l.consumedQty ?? 0), 0);
  note(settledIssue, by, `Settled by ${claimed.ticketNumber} — ${money(totalReturned)} returned, ${money(totalConsumed)} consumed.`);
  await writeBack(db, settledIssue, { closedAt: at });

  note(claimed, by, "Return received into stock.");
  await writeBack(db, claimed);

  return { ok: true, ticket: claimed, issue: settledIssue };
}

// The store refuses the return — the count is wrong, or the materials are not
// actually there. The parent issue stays acknowledged so another return can be
// raised against it once the discrepancy is sorted out.
export async function rejectReturn(db: Db, ticket: MaterialTicket, by: string): Promise<TransitionResult> {
  if (ticket.kind !== "return") return { ok: false, reason: "That is not a return ticket." };
  if (ticket.status !== "pending_store") return { ok: false, reason: statusComplaint(ticket, "rejected") };

  const at = new Date().toISOString();
  const claimed = await claim(db, ticket, "pending_store", "rejected", { closedAt: at });
  if (!claimed) return { ok: false, reason: "Someone has already actioned this return." };
  note(claimed, by, "Rejected the return — nothing was credited back.");
  await writeBack(db, claimed);
  return { ok: true, ticket: claimed };
}

// Withdraw a return that has not been actioned. No stock has moved at any point
// on this path, so it is a pure status change.
export async function cancelReturn(db: Db, ticket: MaterialTicket, by: string): Promise<TransitionResult> {
  if (isTerminal(ticket.status)) return { ok: false, reason: "This return is already closed." };
  const at = new Date().toISOString();
  const claimed = await claim(db, ticket, ticket.status, "cancelled", { closedAt: at });
  if (!claimed) return { ok: false, reason: "This return has already been actioned." };
  note(claimed, by, "Withdrew the return.");
  await writeBack(db, claimed);
  return { ok: true, ticket: claimed };
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

function money(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// What the ticket is now, in words, for a message that says why a button could
// not be honoured. A stale keyboard is the normal cause, so telling someone the
// current state is more use than a flat refusal.
function plainStatus(ticket: MaterialTicket): string {
  const issue: Record<string, string> = {
    draft: "still a draft",
    awaiting_ack: "waiting to be acknowledged",
    acknowledged: "acknowledged and open for returns",
    disputed: "disputed",
    settled: "already settled",
    cancelled: "already cancelled",
  };
  const ret: Record<string, string> = {
    draft: "still a draft",
    pending_store: "waiting on the store to confirm it",
    accepted: "already accepted",
    rejected: "already rejected",
    cancelled: "already cancelled",
  };
  const table = ticket.kind === "return" ? ret : issue;
  return table[ticket.status] ?? ticket.status;
}

function statusComplaint(ticket: MaterialTicket, attempted: string): string {
  const what = ticket.kind === "return" ? "return" : "issue";
  return `This ${what} can't be ${attempted} — it is ${plainStatus(ticket)}.`;
}

export { plainStatus, STORE_ROLE };
