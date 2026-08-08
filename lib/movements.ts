import { ObjectId, type Db, type Document } from "mongodb";
import { randomUUID } from "node:crypto";
import { cached } from "./cache";
import { locationPathById, locationsByIdForPaths, locationPathFrom } from "./locations";
import { onHandLive, recordMovement, recordMovements, type StockMovement } from "./stock";
import { normalizeQuestions, type MoveAnswer, type MoveQuestion } from "./movement-questions";

// Stock movement types — the configurable vocabulary of WHY stock moved.
//
// The ledger (lib/stock.ts) never stored a running total, and it does not store
// a fixed list of reasons either. A movement's `reason` is the CODE of a row in
// `movementTypes`, so an organisation adds "Return from Plant" or "Scrap to
// Vendor" in the console and it is immediately recordable, reportable and
// history-visible — no deploy, no code change.
//
// A type carries the rules that make its own capture correct:
//   • `direction` decides the sign, and therefore what the form asks for. `in`
//     adds at one location, `out` removes from one, `transfer` writes a matched
//     pair that sums to zero.
//   • `requireRemarks` / `requireReference` are the per-type mandatory fields
//     the story asks for — "Damaged/Lost" is meaningless without a note, a
//     purchase is meaningless without an invoice number.
//   • `allowNegative` is the explicit permission in AC-08: without it, stock
//     cannot be taken out beyond what is on hand.
//   • `questions` is the configurable Telegram workflow: boolean / string /
//     number / select prompts built on the Workflows page.
//
// `isSystem` marks the types the SOFTWARE writes — an entry-bot receipt, a
// request issue, a storage-map count correction. They are real types (history
// names them, reports group by them) but they are not offered on the manual
// form, because recording one by hand would claim a ticket happened that didn't.

export type MovementDirection = "in" | "out" | "transfer" | "adjust";

export type MovementType = {
  code: string;
  name: string;
  direction: MovementDirection;
  desc: string;
  requireRemarks: boolean;
  requireReference: boolean;
  // Out only: permit taking more than is on hand (a negative balance), for the
  // organisations that reconcile later rather than blocking the storekeeper.
  allowNegative: boolean;
  questions: MoveQuestion[];
  isSystem: boolean;
  order: number;
  status: string;
};

export type RecordMovementInput = {
  typeCode: string;
  productId: string;
  qty: number; // always positive — the direction decides the sign
  locationId?: string; // in / out
  fromLocationId?: string; // transfer
  toLocationId?: string; // transfer
  remarks?: string;
  reference?: string;
  answers?: MoveAnswer[];
  by: string;
};

export type RecordMovementResult =
  | {
      ok: true;
      movementKeys: string[];
      type: MovementType;
      productName: string;
      qty: number;
      // Balances after the write, so the caller can confirm with a number the
      // user can check against the shelf rather than a bare "saved".
      balances: { locationId: string; locationPath: string; qty: number }[];
    }
  | { ok: false; status: number; error: string };

const TYPE_CACHE_KEY = "movementTypes:active";

export async function activeMovementTypes(db: Db): Promise<Document[]> {
  return cached(TYPE_CACHE_KEY, () =>
    db.collection("movementTypes").find({ status: "Active" }).sort({ order: 1, name: 1 }).toArray()
  );
}

export function toMovementType(doc: Document): MovementType {
  const direction = String(doc.direction ?? "in");
  return {
    code: String(doc.code ?? ""),
    name: String(doc.name ?? ""),
    direction: (["in", "out", "transfer", "adjust"].includes(direction) ? direction : "in") as MovementDirection,
    desc: String(doc.desc ?? ""),
    requireRemarks: Boolean(doc.requireRemarks),
    requireReference: Boolean(doc.requireReference),
    allowNegative: Boolean(doc.allowNegative),
    questions: normalizeQuestions(doc.questions),
    isSystem: Boolean(doc.isSystem),
    order: Number(doc.order) || 0,
    status: String(doc.status ?? "Active"),
  };
}

// A stable code from a name: what an admin types is a label, what the ledger
// stores is a slug, and the two must not drift apart per install.
export function movementCode(input: string): string {
  return String(input ?? "")
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/-(?=\s|$)/g, " minus ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// The stored shape of a type from whatever the console posted. Shared by create
// and update so a type written by either is the same document.
export function normalizeMovementTypeInput(body: Record<string, unknown>) {
  const name = String(body.name ?? "").trim();
  const direction = String(body.direction ?? "in");
  return {
    name,
    code: String(body.code ?? "").trim() || movementCode(name),
    direction: (["in", "out", "transfer", "adjust"].includes(direction) ? direction : "in") as MovementDirection,
    desc: String(body.desc ?? "").trim(),
    requireRemarks: Boolean(body.requireRemarks),
    requireReference: Boolean(body.requireReference),
    // Only an outward movement can be permitted to go below zero; carrying the
    // flag on an inward type would read as a rule that does nothing.
    allowNegative: direction === "out" && Boolean(body.allowNegative),
    questions: normalizeQuestions(body.questions),
    order: Number(body.order) || 0,
    status: body.status === "Inactive" ? "Inactive" : "Active",
  };
}

// Names a movement row for display, whatever wrote it. The type is looked up
// live so a renamed type renames everywhere; the snapshot on the row covers a
// type that was deleted, and the raw code is the last resort.
export function movementLabel(row: Document, types: Map<string, Document>): string {
  const code = String(row.reason ?? "");
  return String(types.get(code)?.name ?? row.movementName ?? code);
}

async function loadType(db: Db, code: string): Promise<MovementType | null> {
  const all = await activeMovementTypes(db);
  const found = all.find((t) => String(t.code) === code);
  return found ? toMovementType(found) : null;
}

// Record one stock movement from the console.
//
// This is the single write path for a manually captured movement — every
// validation the story asks for lives here rather than in the route, so the
// same rules hold whoever calls it.
export async function recordStockMovement(db: Db, input: RecordMovementInput): Promise<RecordMovementResult> {
  const type = await loadType(db, String(input.typeCode ?? "").trim());
  if (!type) return { ok: false, status: 400, error: "Pick a movement type." };
  if (type.isSystem) {
    return { ok: false, status: 400, error: `“${type.name}” is written by the system — it can't be recorded by hand.` };
  }

  const qty = Number(input.qty);
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, status: 400, error: "Quantity must be more than zero." };

  if (!ObjectId.isValid(input.productId)) return { ok: false, status: 400, error: "Pick an item first." };
  const product = await db.collection("products").findOne({ _id: new ObjectId(input.productId) });
  if (!product) return { ok: false, status: 404, error: "That item no longer exists." };

  const remarks = String(input.remarks ?? "").trim().slice(0, 400);
  const reference = String(input.reference ?? "").trim().slice(0, 120);
  if (type.requireRemarks && !remarks) return { ok: false, status: 400, error: `“${type.name}” needs remarks.` };
  if (type.requireReference && !reference) {
    return { ok: false, status: 400, error: `“${type.name}” needs a reference (document / ticket number).` };
  }

  // Configurable workflow answers — every required question must be present.
  const answers = Array.isArray(input.answers) ? input.answers : [];
  for (const q of type.questions) {
    if (!q.required) continue;
    const a = answers.find((x) => x.id === q.id);
    if (!a || a.display === "" || a.value === undefined || a.value === null) {
      return { ok: false, status: 400, error: `“${q.label}” is required.` };
    }
  }

  const transfer = type.direction === "transfer";
  const fromId = transfer ? String(input.fromLocationId ?? "") : type.direction === "out" ? String(input.locationId ?? "") : "";
  const toId = transfer ? String(input.toLocationId ?? "") : type.direction === "in" ? String(input.locationId ?? "") : "";

  if (transfer) {
    if (!ObjectId.isValid(fromId)) return { ok: false, status: 400, error: "Pick where the stock is moving from." };
    if (!ObjectId.isValid(toId)) return { ok: false, status: 400, error: "Pick where the stock is moving to." };
    if (fromId === toId) return { ok: false, status: 400, error: "Source and destination are the same place." };
  } else if (!ObjectId.isValid(fromId || toId)) {
    return { ok: false, status: 400, error: "Pick a location." };
  }

  const locationIds = [fromId, toId].filter(Boolean);
  const found = await db
    .collection("locations")
    .find({ _id: { $in: locationIds.map((id) => new ObjectId(id)) } })
    .toArray();
  if (found.length !== locationIds.length) return { ok: false, status: 404, error: "That location no longer exists." };

  // Live, not the cached aggregation: this is the check that decides whether
  // stock may leave, and a five-second-old balance can approve moving stock
  // that has already gone (AC-08).
  const moving = Math.round(qty * 1000) / 1000;
  if (fromId) {
    const available = await onHandLive(db, input.productId, fromId);
    if (moving > available && !type.allowNegative) {
      const path = await locationPathById(db, fromId);
      return {
        ok: false,
        status: 409,
        error: `Only ${available} on hand at ${path || "that location"} — can't take out ${moving}.`,
      };
    }
  }

  const paths = new Map<string, string>();
  for (const id of locationIds) paths.set(id, (await locationPathById(db, id)) || "(unknown location)");

  const shared = {
    productId: input.productId,
    productName: String(product.name ?? ""),
    productNumber: String(product.productNumber ?? ""),
    unit: String(product.unit ?? ""),
    reason: type.code,
    // Snapshotted so a movement recorded under "Damaged/Lost" still says so if
    // the type is renamed to something else years later.
    movementName: type.name,
    refType: "movement" as const,
    by: input.by,
    createdAt: new Date().toISOString(),
    ...(remarks ? { remarks } : {}),
    ...(reference ? { reference } : {}),
    ...(answers.length ? { answers } : {}),
  };

  // One id ties the legs of a transfer together, and gives an in/out movement a
  // reference of its own to quote back to the user.
  const movementId = randomUUID();
  const movements: StockMovement[] = transfer
    ? [
        {
          ...shared,
          movementKey: `mv:${movementId}:out`,
          refId: movementId,
          locationId: fromId,
          locationPath: paths.get(fromId) as string,
          counterpartLocationPath: paths.get(toId) as string,
          qty: -moving,
        },
        {
          ...shared,
          movementKey: `mv:${movementId}:in`,
          refId: movementId,
          locationId: toId,
          locationPath: paths.get(toId) as string,
          counterpartLocationPath: paths.get(fromId) as string,
          qty: moving,
        },
      ]
    : [
        {
          ...shared,
          movementKey: `mv:${movementId}`,
          refId: movementId,
          locationId: (fromId || toId) as string,
          locationPath: paths.get(fromId || toId) as string,
          qty: type.direction === "out" ? -moving : moving,
        },
      ];

  if (movements.length > 1) await recordMovements(db, movements);
  else await recordMovement(db, movements[0]);

  const balances: { locationId: string; locationPath: string; qty: number }[] = [];
  for (const id of locationIds) {
    balances.push({ locationId: id, locationPath: paths.get(id) as string, qty: await onHandLive(db, input.productId, id) });
  }

  return {
    ok: true,
    movementKeys: movements.map((m) => m.movementKey),
    type,
    productName: shared.productName,
    qty: moving,
    balances,
  };
}

export type MovementHistoryRow = {
  id: string;
  createdAt: string;
  productId: string;
  productName: string;
  productNumber: string;
  typeCode: string;
  typeName: string;
  direction: MovementDirection;
  locationId: string;
  locationPath: string;
  counterpartLocationPath: string;
  qty: number;
  unit: string;
  remarks: string;
  reference: string;
  refType: string;
  refId: string;
  by: string;
};

// The transaction history (AC-07). Reads the ledger itself rather than any
// summary of it, so what is listed is exactly what the balances were computed
// from — a movement can never appear in one and not the other.
export async function listMovements(
  db: Db,
  filter: { productId?: string; locationId?: string; typeCode?: string; direction?: string; from?: string; to?: string },
  limit = 200
): Promise<MovementHistoryRow[]> {
  const query: Document = {};
  if (filter.productId) query.productId = filter.productId;
  if (filter.locationId) query.locationId = filter.locationId;
  if (filter.typeCode) query.reason = filter.typeCode;
  if (filter.from || filter.to) {
    query.createdAt = {
      ...(filter.from ? { $gte: filter.from } : {}),
      // A date filter means the whole day, so the upper bound runs to the end of
      // it rather than to midnight, which would drop everything typed that day.
      ...(filter.to ? { $lte: `${filter.to}T23:59:59.999Z` } : {}),
    };
  }

  const [rows, typeDocs, locationsById] = await Promise.all([
    db.collection("stockMovements").find(query).sort({ createdAt: -1 }).limit(Math.min(limit, 500)).toArray(),
    db.collection("movementTypes").find({}).toArray(),
    locationsByIdForPaths(db),
  ]);
  const types = new Map(typeDocs.map((t) => [String(t.code), t]));

  const mapped = rows.map((r) => {
    const code = String(r.reason ?? "");
    const type = types.get(code);
    return {
      id: r._id.toString(),
      createdAt: String(r.createdAt ?? ""),
      productId: String(r.productId ?? ""),
      productName: String(r.productName ?? ""),
      productNumber: String(r.productNumber ?? ""),
      typeCode: code,
      typeName: movementLabel(r, types),
      direction: (type ? toMovementType(type).direction : Number(r.qty) < 0 ? "out" : "in") as MovementDirection,
      locationId: String(r.locationId ?? ""),
      // The live tree covers renames; the snapshot on the row covers a location
      // that has since been deactivated or deleted.
      locationPath: locationPathFrom(locationsById, String(r.locationId ?? "")) || String(r.locationPath ?? ""),
      counterpartLocationPath: String(r.counterpartLocationPath ?? ""),
      qty: Number(r.qty) || 0,
      unit: String(r.unit ?? ""),
      remarks: String(r.remarks ?? ""),
      reference: String(r.reference ?? ""),
      refType: String(r.refType ?? ""),
      refId: String(r.refId ?? ""),
      by: String(r.by ?? ""),
    };
  });

  // A direction filter is a filter over the TYPE, which only exists after the
  // rows have been resolved against the type master.
  return filter.direction ? mapped.filter((m) => m.direction === filter.direction) : mapped;
}
