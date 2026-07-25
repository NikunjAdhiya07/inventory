import type { Db, Document } from "mongodb";

// Append an immutable snapshot of a workflow's steps at a given version.
// In-progress bot sessions run against a pinned snapshot (never the live head),
// so edits/reactivations don't disturb conversations already underway.
export async function writeSnapshot(
  db: Db,
  workflowId: string,
  version: number,
  name: string,
  steps: Document[],
  createdBy = "console"
) {
  await db.collection("workflowVersions").insertOne({
    workflowId,
    version,
    name,
    steps,
    createdAt: new Date().toISOString(),
    createdBy,
  });
}
