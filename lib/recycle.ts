import { getDb } from "./mongodb";
import { CURRENT_USER } from "./audit";
import type { Document } from "mongodb";

// Rows in another collection that only mean anything alongside this document —
// the options under a nested category tree, for instance. They are carried into
// the bin WITH their original `_id`s so references between them survive; only
// their pointer back to the parent has to be rewritten on restore, since the
// parent comes back under a new id.
export type SoftDeleteChildren = { collection: string; parentField: string; docs: Document[] };

// Soft-delete: move a document out of its origin collection and into the
// recycle bin instead of a hard delete, per the "Soft delete only" policy.
export async function softDelete(
  originalCollection: string,
  type: string,
  doc: Document,
  name: string,
  detail: string,
  children?: SoftDeleteChildren
) {
  const db = await getDb();
  const { _id, ...rest } = doc;
  await db.collection("recycleBin").insertOne({
    originalCollection,
    originalDoc: rest,
    name,
    detail,
    type,
    ...(children?.docs.length ? { children } : {}),
    by: CURRENT_USER,
    deletedAt: new Date().toISOString(),
  });
  await db.collection(originalCollection).deleteOne({ _id });
  if (children?.docs.length) {
    await db.collection(children.collection).deleteMany({ [children.parentField]: String(_id) });
  }
}
