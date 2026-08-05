import type { ProductAttribute } from "./products";
import { MANAGER_ROLE } from "./request-types";

// Shapes for the material issue/return flow.
//
// It runs as an OVERLAY on top of whatever a group already does — `/issue` works
// in every approved chat — so a site can keep one Telegram group for everything
// rather than one per flow. See `lib/issue-webhook.ts` for how an update is
// claimed without ever taking a message the entry workflow wanted.
//
// This flow is store-PUSH, which is what makes it a third flow rather than a
// mode of the request bot. A request starts with the person who wants something
// and ends when the store agrees; an issue starts with the store recording that
// materials have already left the shelf with a named person, and does not end
// until that person says what happened to them. The store is the author, the
// recipient is the one who owes an answer, and the ticket outlives the
// conversation that raised it — none of which the requester-pull state machine
// in `request-types.ts` can express without growing a second personality.
//
// Two documents, one collection, told apart by `kind`:
//
//   ISS-202608-0042  the issue      — 5 wire, 7 screws → Vijay
//   RET-202608-0007  the return     — 2 wire back, 3 consumed; settles ISS-…0042
//
// They share a collection because they share all of their machinery (anchor
// message, replay guard, cart UI, line shape) and differ only in lifecycle. They
// are separate DOCUMENTS because they are authored by different people on
// different days and each needs a number of its own to quote.

export type TicketKind = "issue" | "return";

// The issue ticket's life. Stock leaves at submit, not at acknowledgement: the
// store writes the ticket because the materials are already in Vijay's hands, so
// a ledger that still showed them on the shelf would be describing a world that
// no longer exists. Acknowledgement is therefore a confirmation, not a gate.
export type IssueStatus =
  // The store's live cart: lines picked, recipient chosen. No number yet —
  // nothing has been asked of anyone.
  | "draft"
  // Submitted. Stock has been deducted and the recipient owes an acknowledgement.
  | "awaiting_ack"
  // The recipient confirmed receipt. This is the state a return is raised from.
  | "acknowledged"
  // The recipient says they never got these. Tags the store to sort it out; from
  // here it can still be acknowledged, or cancelled back onto the shelf.
  | "disputed"
  // A return ticket has accounted for every outstanding line. Terminal.
  | "settled"
  // Withdrawn. If stock had already been deducted it goes back.
  | "cancelled";

// The return ticket's life. Nothing hits the ledger until the store confirms it
// physically has the goods back — a credit for materials nobody at the store has
// laid eyes on is exactly the drift the ledger exists to prevent.
export type ReturnStatus =
  | "draft"
  | "pending_store" // submitted, waiting on the store to confirm receipt
  | "accepted" // stock credited back, parent issue settled
  | "rejected" // store refused it; the parent issue stays open for another go
  | "cancelled";

export type AnyStatus = IssueStatus | ReturnStatus;

// Statuses that accept no further action. Checked before every transition, so a
// keyboard sitting in the group from last Tuesday cannot reopen a closed ticket.
export const TERMINAL_STATUSES: ReadonlySet<AnyStatus> = new Set([
  "settled",
  "cancelled",
  "accepted",
  "rejected",
]);

export function isTerminal(status: AnyStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// One material line.
//
// On an ISSUE ticket `qty` is how much left the store. On a RETURN ticket `qty`
// is how much is coming back, and `issuedQty` carries what the parent issue line
// said so the store can see 2-of-5 without opening the other ticket.
export type MaterialLine = {
  // Stable within its ticket, never recycled or reordered: it goes into callback
  // data and into the ledger's idempotency keys.
  lineId: string;
  productId: string;
  productName: string;
  productNumber: string;
  category: string;
  subcategory: string;
  // Snapshotted at pick time. A later edit to the Product Master must not
  // rewrite what was handed over.
  attributes: ProductAttribute[];
  locationId: string;
  locationPath: string;
  qty: number;
  unit: string;

  // ---- issue lines only ----
  // Set at submit. A line whose shelf turned out to be empty is marked
  // `unavailable` and moves no stock, so the store issues what exists and the
  // ticket says plainly what it could not.
  outcome?: "issued" | "unavailable";
  // Filled in when a return settles this line. Consumed is not an input: it is
  // whatever did not come back, which is precisely what "used on the job" means.
  returnedQty?: number;
  consumedQty?: number;

  // ---- return lines only ----
  // The parent issue line this one answers, so settlement is a lookup rather
  // than a match-by-product guess (the same product can be issued from two
  // locations on one ticket).
  issueLineId?: string;
  issuedQty?: number;
};

// Who the materials went to. Snapshotted rather than referenced for the same
// reason the product is: the ticket must still read correctly after the person
// changes their display name or leaves.
export type Recipient = {
  userId: string; // Telegram id — the credential for acknowledging
  dbId: string;
  name: string;
  handle: string; // @username, when they have one
};

// An append-only trail, rendered back into the chat so the ticket carries its
// own history without anyone leaving the message.
export type TicketEvent = {
  at: string;
  by: string;
  what: string;
};

// Per-ticket scratch for the cart UI. Reset whenever a new search starts, the
// same way the request bot's is.
export type TicketUi = {
  // What typed text currently means. The store head types a product name while
  // building the cart and a person's name while the recipient picker is open;
  // without this the two searches would be indistinguishable.
  stage?: "search" | "who" | null;
  query: string;
  page: number;
  focusProductId?: string | null;
  focusLocationId?: string | null;
  qtyDraft?: string;
  // Recipient picker.
  whoQuery?: string;
  whoPage?: number;
  // Return flow: which issue line the recipient has open on the keypad.
  focusReturnLineId?: string | null;
};

export type MaterialTicket = {
  _id?: unknown;
  // Absent while a draft. Assigned at submit.
  ticketNumber?: string;
  kind: TicketKind;
  status: AnyStatus;
  chatId: string;

  // Whoever authored this ticket: the store for an issue, the recipient for a
  // return. Named generically because both are real authors of their own
  // document, and calling the field `storeUserId` would lie on half the rows.
  createdByUserId: string; // Telegram id
  createdByDbId: string;
  createdByName: string;
  createdByHandle: string;

  // Who the materials are with. On a return this is copied from the parent issue
  // so both documents answer "whose materials are these" without a join.
  recipient?: Recipient;

  lines: MaterialLine[];

  // ---- return tickets only ----
  issueTicketId?: string; // parent's _id as a string
  issueTicketNumber?: string;

  // The ticket's single message. Every later transition edits it in place rather
  // than adding to the group.
  anchorMessageId?: number;
  ui: TicketUi;
  history: TicketEvent[];
  // Replay guard for redelivered Telegram updates.
  processedUpdateIds: number[];

  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  acknowledgedAt?: string;
  closedAt?: string;
};

// The store side of this flow is the same authority that issues stock against a
// request, so it reuses that permission rather than inventing a second one an
// admin would have to discover and grant. The recipient side needs nothing:
// being named on the ticket is the credential for acknowledging it and for
// returning against it.
export { PERM_ISSUE } from "./request-types";

// Who gets tagged when a ticket needs the store. Defaults to the role that
// already exists so a deployment can adopt this flow without seeding anything;
// set STORE_HEAD_ROLE to split it out.
export const STORE_ROLE = process.env.STORE_HEAD_ROLE || MANAGER_ROLE;

// A ticket big enough to stop being readable in one screen is not a ticket
// anybody will check line by line before signing for it.
export const MAX_LINES = 15;

// How many people the recipient picker offers per page. Two columns of five.
export const USER_PAGE_SIZE = 10;
