import type { ProductAttribute } from "./products";

// Shapes for the item-request bot (the second Telegram group).
//
// A request is NOT a workflow session. The entry bot's `BotSession` is one
// person, in one sitting, answering one value per step and finishing in a single
// anchor message. A request is the opposite on every axis: it holds many lines
// at once, it is acted on by three different people, and it stays open for days
// between their turns. Trying to express that as a linear step cursor is what
// would force the workflow engine to grow a second personality, so requests get
// their own collection and their own state machine.

// Which of the two end-to-end flows a ticket is on. Decided at submit time and
// never changed afterwards. The live path is inventory only
// (`draft → pending_manager → completed|rejected|cancelled`). `purchase` and
// the mid statuses below remain for tickets that were opened before the
// search group was simplified.
export type RequestKind = "inventory" | "purchase";

export type RequestStatus =
  // The requester's live cart. A draft has no ticket number yet — nothing has
  // been asked of anyone, so there is nothing to quote.
  | "draft"
  // Inventory flow (live): manager Accept issues stock and completes the ticket.
  | "pending_manager" // waiting on an Inventory Manager to accept or reject
  // Legacy mid-states — kept so older open tickets can still finish.
  | "awaiting_collection" // was: accepted, stock deducted, waiting for collection
  | "pending_approval" // was: waiting on a Purchase Officer
  | "procuring" // was: approved, being bought
  // Terminal.
  | "completed"
  | "rejected"
  | "cancelled";

// Statuses that no longer accept any action. Checked before every transition so
// a stale keyboard from three days ago cannot reopen a closed ticket.
export const TERMINAL_STATUSES: ReadonlySet<RequestStatus> = new Set([
  "completed",
  "rejected",
  "cancelled",
]);

export function isTerminal(status: RequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// One requested item. For an inventory request this is a specific product at a
// specific location — "2 Type-C cables from Store A › Rack 3" — because that is
// the granularity stock actually moves at, and the whole point of the multi-
// select is that one ticket can pull from several locations at once.
export type RequestLine = {
  // Stable within the request. Used in callback data and as part of the ledger's
  // idempotency key, so it must never be recycled or reordered.
  lineId: string;
  productId: string;
  productName: string;
  productNumber: string;
  category: string;
  subcategory: string;
  // Snapshotted at selection time, like the entry bot's product snapshot: a
  // later edit to the Product Master must not rewrite what was requested.
  attributes: ProductAttribute[];
  locationId: string;
  locationPath: string;
  qty: number;
  unit: string;
  // Set when the manager accepts. A line can be refused on its own — the store
  // has one of the three things asked for — so the outcome lives per line rather
  // than only on the ticket.
  outcome?: "issued" | "unavailable";
};

// What a purchase ticket is asking to buy. Free text by necessity: the whole
// reason it is a purchase is that no product record exists to point at.
export type PurchaseItem = {
  name: string;
  qty: number;
  unit: string;
  note: string;
};

export type RequestDecision = {
  role: string; // the role that was asked to decide
  by: string; // display name of whoever actually decided
  byUserId: string; // their Telegram id
  decision: "approved" | "rejected";
  note?: string;
  at: string;
};

// An append-only trail of what happened to this ticket, rendered back into the
// chat so anyone reading the message can see its history without leaving it.
export type RequestEvent = {
  at: string;
  by: string;
  what: string;
};

// Per-step scratch for the requester's cart-building UI. Reset whenever a new
// search starts, exactly like the entry bot's `productQuery`/`productPage`.
export type RequestUi = {
  query: string;
  page: number;
  // Which product the requester has opened to pick a location and quantity.
  // Null when they are looking at the results list.
  focusProductId?: string | null;
  focusLocationId?: string | null;
  qtyDraft?: string;
  // Free-text capture for the purchase flow, one field at a time.
  purchaseField?: "name" | "qty" | "unit" | "note" | null;
  // Cursor for the location tree shown when a purchased item is received into
  // stock. Kept separate from `focusLocationId` — that one means "the shelf this
  // cart line is taken from", and overloading it would make Back out of the
  // delivery picker land in the middle of a half-built cart line.
  locCursor?: string | null;
  locStack?: string[];
  // Where the "purchase delivered" sub-flow has got to. Absent until somebody
  // taps Mark delivered.
  deliveryStage?: "choice" | "location" | "qty" | null;
  // How many actually turned up, which is not always how many were asked for —
  // a request for 2 cables is often filled by buying a box of 50.
  recvQtyDraft?: string;
  recvLocationId?: string | null;
  recvLocationPath?: string;
};

export type ItemRequest = {
  _id?: unknown;
  // Absent while the request is still a draft; assigned at submit.
  ticketNumber?: string;
  kind: RequestKind;
  status: RequestStatus;
  chatId: string;
  requesterUserId: string; // Telegram id
  requesterDbId: string;
  requesterName: string;
  requesterHandle: string;
  lines: RequestLine[];
  purchase?: PurchaseItem;
  decisions: RequestDecision[];
  // Where the ticket's single message lives, so every later transition edits it
  // in place instead of adding to the group.
  anchorMessageId?: number;
  ui: RequestUi;
  history: RequestEvent[];
  // Replay guard, same idea as `BotSession.processedUpdateIds`.
  processedUpdateIds: number[];
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  closedAt?: string;
};

// Permissions this flow introduces. Named as verbs a role either can or cannot
// do, matching the existing "Add Inventory" / "Approve Entries" convention.
export const PERM_REQUEST = "Request Items";
export const PERM_ISSUE = "Issue Inventory";
export const PERM_APPROVE_PURCHASE = "Approve Purchase";

// The roles asked to decide on each flow. Configurable so a deployment can rename
// them without a code change, defaulted to what `scripts/seed.mjs` creates.
export const MANAGER_ROLE = process.env.INVENTORY_MANAGER_ROLE || "Inventory Manager";
export const PURCHASE_ROLE = process.env.PURCHASE_OFFICER_ROLE || "Purchase Officer";

// A cart big enough to stop being a cart. Telegram has a hard message-length
// limit and a ticket nobody can read in one screen is not reviewable.
export const MAX_LINES = 15;
