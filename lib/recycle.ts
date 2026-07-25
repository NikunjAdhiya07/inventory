import { getDb } from "./mongodb";
import { CURRENT_USER } from "./audit";
import type { Document } from "mongodb";

// Soft-delete: move a document out of its origin collection and into the
// recycle bin instead of a hard delete, per the "Soft delete only" policy.
export async function softDelete(originalCollection: string, type: string, doc: Document, name: string, detail: string) {
  const db = await getDb();
  const { _id, ...rest } = doc;
  await db.collection("recycleBin").insertOne({
    originalCollection,
    originalDoc: rest,
    name,
    detail,
    type,
    by: CURRENT_USER,
    deletedAt: new Date().toISOString(),
  });
  await db.collection(originalCollection).deleteOne({ _id });
}
