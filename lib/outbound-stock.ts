import type { Db } from "mongodb";
import { onHandLive } from "./stock";
import { recordStockUnavailable, type StockUnavailableEvent } from "./stock-unavailable";
import type { ItemRequest } from "./request-types";

export function isInboundMovement(opts: {
  stockEffect?: "stock_in" | "stock_out";
  movementDirection?: "in" | "out" | "transfer" | "adjust" | string | null;
  movementCode?: string | null;
}): boolean {
  if (opts.stockEffect === "stock_in") return true;
  if (opts.stockEffect === "stock_out") return false;
  return (
    opts.movementDirection === "in" ||
    opts.movementCode === "department-return" ||
    opts.movementCode === "new-purchase"
  );
}

export type OutboundShortage = {
  available: number;
  productId: string;
  productName: string;
  productNumber: string;
  locationId: string;
  locationPath: string;
  unit: string;
  qtyRequested: number;
};

/** Live ledger check for outbound qty. Returns shortage details when not enough on hand. */
export async function findOutboundShortage(
  db: Db,
  input: {
    productId: string;
    productName: string;
    productNumber: string;
    locationId: string;
    locationPath: string;
    unit: string;
    qty: number;
    inbound: boolean;
  }
): Promise<OutboundShortage | null> {
  if (input.inbound) return null;
  const available = await onHandLive(db, input.productId, input.locationId);
  if (available >= input.qty) return null;
  return {
    available,
    productId: input.productId,
    productName: input.productName,
    productNumber: input.productNumber,
    locationId: input.locationId,
    locationPath: input.locationPath,
    unit: input.unit,
    qtyRequested: input.qty,
  };
}

export async function persistOutboundShortage(
  db: Db,
  request: ItemRequest,
  shortage: OutboundShortage,
  source: StockUnavailableEvent["source"],
  movement?: { code?: string; name?: string }
): Promise<void> {
  await recordStockUnavailable(db, {
    productId: shortage.productId,
    productName: shortage.productName,
    productNumber: shortage.productNumber,
    locationId: shortage.locationId,
    locationPath: shortage.locationPath,
    qtyRequested: shortage.qtyRequested,
    qtyAvailable: shortage.available,
    unit: shortage.unit,
    movementCode: movement?.code,
    movementName: movement?.name,
    chatId: request.chatId,
    requesterUserId: request.requesterUserId,
    requesterName: request.requesterName,
    requestId: request._id ? String(request._id) : undefined,
    ticketNumber: request.ticketNumber ?? null,
    source,
  });
}
