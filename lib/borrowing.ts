import type { Db, Document } from "mongodb";
import { cached, invalidate } from "./cache";
import { onHandLive, onHandTotalLive, recordMovement, type StockMovement } from "./stock";
import { nextTicketNumber, TicketSeries } from "./ticket";
import { BORROW_BRANCH_LABEL, BORROW_MOVEMENT_CODE, BORROW_MOVEMENT_NAME } from "./borrowing-types";

// Borrowing: material leaving the shelf with a named person, settled later.
//
// Unlike every other search-group movement, a borrow does NOT go through
// cart → submit → manager Accept. The maintenance user is standing at the shelf
// with the item in their hand, so the ledger has to agree with reality the
// moment they confirm — which is why `postBorrowing` writes the movement itself
// and hands back the remaining stock rather than returning a cart line.
//
// WHO borrowed it is two names, not one. A maintenance user owns the borrowing
// (it sits on their account, and they answer for it coming back), but the person
// who physically walked off with it may be one of their workers. Collapsing the
// two would lose exactly the fact the store needs when the item does not return,
// so both are recorded and the ticket shows them separately.

export { BORROW_BRANCH_LABEL, BORROW_MOVEMENT_CODE, BORROW_MOVEMENT_NAME };

const BORROWINGS = "borrowings";

// The four people who may hold a borrowing. Seeded rather than hardcoded at the
// call site so the console can rename, reorder or retire one without a deploy —
// the same rule Vendor / Plant / Department Master follow.
const DEFAULT_MAINTENANCE_USERS = [
  { code: "vijay", name: "Vijay", order: 10 },
  { code: "nilesh-chauhan", name: "Nilesh Chauhan", order: 20 },
  { code: "devang", name: "Devang", order: 30 },
  { code: "vishal", name: "Vishal", order: 40 },
];

// The workers a maintenance user can borrow on behalf of. "Nilesh" here is a
// different row from the maintenance user "Nilesh Chauhan" and must stay so.
const DEFAULT_WORKERS = [
  { code: "babu", name: "Babu", order: 10 },
  { code: "hardip", name: "Hardip", order: 20 },
  { code: "aakash", name: "Aakash", order: 30 },
  { code: "mahesh-chauhan", name: "Mahesh Chauhan", order: 40 },
  { code: "nilesh", name: "Nilesh", order: 50 },
  { code: "rahul", name: "Rahul", order: 60 },
  { code: "jayesh", name: "Jayesh", order: 70 },
  { code: "mahesh-madhar", name: "Mahesh Madhar", order: 80 },
];

function byOrderThenName(rows: Document[]): Document[] {
  return [...rows].sort((a, b) => {
    const ao = typeof a.order === "number" ? a.order : Infinity;
    const bo = typeof b.order === "number" ? b.order : Infinity;
    if (ao !== bo) return ao - bo;
    return String(a.name).localeCompare(String(b.name));
  });
}

// Put the defaults in the first time the collection is asked for and found
// empty. A borrow flow that silently offers nobody is not a working flow, and an
// admin has no way to know a master they were never told about is missing —
// so the names arrive with the feature and stay editable afterwards.
async function seedDefaults(db: Db, collection: string, rows: typeof DEFAULT_WORKERS): Promise<void> {
  const now = new Date().toISOString();
  for (const r of rows) {
    await db.collection(collection).updateOne(
      { code: r.code },
      {
        $setOnInsert: { code: r.code, name: r.name, order: r.order, status: "Active", createdAt: now },
        $set: { updatedAt: now },
      },
      { upsert: true }
    );
  }
}

async function activeMaster(
  db: Db,
  collection: string,
  defaults: typeof DEFAULT_WORKERS
): Promise<Document[]> {
  const rows = await db.collection(collection).find({ status: "Active" }).toArray();
  if (rows.length) return byOrderThenName(rows);
  await seedDefaults(db, collection, defaults);
  return byOrderThenName(await db.collection(collection).find({ status: "Active" }).toArray());
}

/** Active Maintenance User Master rows — the four people a borrowing sits under. */
export async function activeMaintenanceUsers(db: Db): Promise<Document[]> {
  return cached("maintenanceUsers:active", () =>
    activeMaster(db, "maintenanceUsers", DEFAULT_MAINTENANCE_USERS)
  );
}

/** Active Worker Master rows — offered when a borrowing is taken by someone else. */
export async function activeWorkers(db: Db): Promise<Document[]> {
  return cached("workers:active", () => activeMaster(db, "workers", DEFAULT_WORKERS));
}

// The Borrow row in Movement Master. Without it the flowchart branch exists but
// `loadManualTypes` filters it off the keyboard, so the button never appears.
// Upserted on the workflow load path (which already writes there) and cached so
// it costs one round trip per process rather than one per tap.
export async function ensureBorrowMovementType(db: Db): Promise<void> {
  await cached(
    "borrow:movementType",
    async () => {
      const now = new Date().toISOString();
      const res = await db.collection("movementTypes").updateOne(
        { code: BORROW_MOVEMENT_CODE },
        {
          $setOnInsert: {
            code: BORROW_MOVEMENT_CODE,
            name: BORROW_MOVEMENT_NAME,
            direction: "out",
            desc: "Material borrowed by a maintenance user (for themselves or for one of their workers). Stock is deducted the moment the borrowing is confirmed.",
            requireRemarks: false,
            requireReference: false,
            allowNegative: false,
            questions: [],
            order: 39,
            status: "Active",
            createdAt: now,
            updatedAt: now,
          },
          // Not an opinion the console gets to hold: a borrow always takes stock out.
          $set: { isSystem: false },
        },
        { upsert: true }
      );
      if (res.upsertedCount) invalidate("movementTypes");
      return true;
    },
    10 * 60_000
  );
}

export type BorrowPosting = {
  chatId: string;
  productId: string;
  productName: string;
  productNumber: string;
  unit: string;
  locationId: string;
  locationPath: string;
  qty: number;
  maintenanceUserId: string;
  maintenanceUserName: string;
  /** Who physically took it — the maintenance user themselves, or one of their workers. */
  borrowedByName: string;
  borrowedBySelf: boolean;
  workerId?: string;
  recordedByUserId: string;
  recordedByName: string;
  requestId?: string;
};

export type BorrowResult =
  | {
      ok: true;
      ticketNumber: string;
      qty: number;
      /** On hand at the shelf it came off, read back from the ledger after the write. */
      remainingAtLocation: number;
      /** On hand across every location holding this product. */
      remainingTotal: number;
    }
  | { ok: false; reason: string; available?: number };

/**
 * Record a borrowing: one negative ledger movement plus the borrowing record
 * that says who is holding the item, both written before anything is shown back.
 *
 * The on-hand check reads live rather than cached for the same reason
 * `recordStockMovement` does — this is the check that decides whether stock may
 * actually leave, and a five-second-old balance can approve emptying a shelf
 * that another borrower just cleared.
 */
export async function postBorrowing(db: Db, input: BorrowPosting): Promise<BorrowResult> {
  const qty = Math.round(Number(input.qty) * 1000) / 1000;
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: "Enter how many you are borrowing." };
  }
  if (!input.locationId) return { ok: false, reason: "Pick the storage location first." };
  if (!input.maintenanceUserName) return { ok: false, reason: "Pick the maintenance user first." };
  if (!input.borrowedByName) return { ok: false, reason: "Say who is borrowing it." };

  const available = await onHandLive(db, input.productId, input.locationId);
  if (qty > available) {
    return {
      ok: false,
      reason: `Only ${available} ${input.unit} on hand at ${input.locationPath} — can't borrow ${qty}.`,
      available,
    };
  }

  const at = new Date();
  const ticketNumber = await nextTicketNumber(db, at, TicketSeries.BORROW);
  const createdAt = at.toISOString();
  const borrowedFor = input.borrowedBySelf
    ? input.maintenanceUserName
    : `${input.borrowedByName} (under ${input.maintenanceUserName})`;

  const movement: StockMovement = {
    movementKey: `borrow:${ticketNumber}`,
    productId: input.productId,
    productName: input.productName,
    productNumber: input.productNumber,
    locationId: input.locationId,
    locationPath: input.locationPath,
    qty: -qty,
    unit: input.unit,
    reason: BORROW_MOVEMENT_CODE,
    movementName: BORROW_MOVEMENT_NAME,
    refType: "movement",
    refId: ticketNumber,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    remarks: `Borrowed by ${borrowedFor}`,
    // Both names travel on the movement so the console's transaction history
    // answers "who has it" without joining to the borrowings collection.
    answers: [
      {
        id: "maintenanceUser",
        label: "Maintenance User",
        type: "string",
        value: input.maintenanceUserName,
        display: input.maintenanceUserName,
      },
      {
        id: "borrowedBy",
        label: "Borrowed by",
        type: "string",
        value: input.borrowedByName,
        display: input.borrowedByName,
      },
    ],
    by: input.recordedByName,
    createdAt,
  };

  const written = await recordMovement(db, movement);
  if (!written) {
    // The movement key is derived from a freshly minted ticket number, so a
    // duplicate here means this exact borrowing already landed — a retried
    // update, not a second physical event.
    return { ok: false, reason: "That borrowing has already been recorded." };
  }

  await db.collection(BORROWINGS).insertOne({
    ticketNumber,
    chatId: input.chatId,
    productId: input.productId,
    productName: input.productName,
    productNumber: input.productNumber,
    locationId: input.locationId,
    locationPath: input.locationPath,
    qty,
    unit: input.unit,
    maintenanceUserId: input.maintenanceUserId,
    maintenanceUserName: input.maintenanceUserName,
    borrowedByName: input.borrowedByName,
    borrowedBySelf: input.borrowedBySelf,
    ...(input.workerId ? { workerId: input.workerId } : {}),
    recordedByUserId: input.recordedByUserId,
    recordedByName: input.recordedByName,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    movementKey: movement.movementKey,
    // Open until somebody records the material coming back. Nothing settles a
    // borrowing yet; the field is here so a return flow has a row to close.
    status: "borrowed",
    createdAt,
    updatedAt: createdAt,
  } as never);

  const [remainingAtLocation, remainingTotal] = await Promise.all([
    onHandLive(db, input.productId, input.locationId),
    onHandTotalLive(db, input.productId),
  ]);

  return { ok: true, ticketNumber, qty, remainingAtLocation, remainingTotal };
}
