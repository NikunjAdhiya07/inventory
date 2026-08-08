import type { Db, ObjectId } from "mongodb";
import { invalidateCollection } from "./cache";

export const STOCK_UNAVAILABLE_COLLECTION = "stockUnavailable";

export type StockUnavailableEvent = {
  _id?: ObjectId;
  productId: string;
  productName: string;
  productNumber: string;
  locationId: string;
  locationPath: string;
  qtyRequested: number;
  qtyAvailable: number;
  unit: string;
  movementCode?: string;
  movementName?: string;
  chatId?: string;
  requesterUserId?: string;
  requesterName?: string;
  requestId?: string;
  ticketNumber?: string | number | null;
  source: "cart" | "qty" | "submit" | "accept";
  status: "open" | "acknowledged";
  createdAt: string;
};

export async function recordStockUnavailable(
  db: Db,
  event: Omit<StockUnavailableEvent, "_id" | "status" | "createdAt"> & {
    status?: StockUnavailableEvent["status"];
    createdAt?: string;
  }
): Promise<void> {
  const doc: StockUnavailableEvent = {
    ...event,
    status: event.status ?? "open",
    createdAt: event.createdAt ?? new Date().toISOString(),
  };
  await db.collection(STOCK_UNAVAILABLE_COLLECTION).insertOne(doc);
  invalidateCollection(STOCK_UNAVAILABLE_COLLECTION);
}

export async function listStockUnavailable(
  db: Db,
  limit = 200
): Promise<StockUnavailableEvent[]> {
  return (await db
    .collection(STOCK_UNAVAILABLE_COLLECTION)
    .find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray()) as StockUnavailableEvent[];
}
