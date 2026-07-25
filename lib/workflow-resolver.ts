import { ObjectId, type Db, type Document } from "mongodb";
import type { StepInstance } from "./workflow-types";

export type ResolvedWorkflow = {
  workflowId: string;
  version: number;
  steps: StepInstance[];
};

// Resolve which workflow applies for an entry starting in a given Telegram
// group. Precedence (Active assignments/workflows only):
//   1. group assignment matching this chatId  (ties: priority desc, createdAt asc)
//   2. the default workflow (isDefault: true)
//   3. none -> null (bot replies "no workflow configured")
//
// Category-scoped assignments are intentionally not resolved here: the category
// is only known mid-conversation, but the step set is pinned at entry start.
// They act as an entry-point selector for category-first flows (future work),
// not a mid-run switch. The pinned snapshot is always the workflow's CURRENT
// active version, captured into the session so later edits don't disturb it.
export async function resolveWorkflow(db: Db, chatId: string): Promise<ResolvedWorkflow | null> {
  const groupAssignments = await db
    .collection("workflowAssignments")
    .find({ scope: "group", chatId, status: "Active" })
    .sort({ priority: -1, createdAt: 1 })
    .toArray();

  for (const a of groupAssignments) {
    const oid = toObjectId(a.workflowId);
    if (!(oid instanceof ObjectId)) continue;
    const wf = await db.collection("workflows").findOne({ _id: oid, status: "Active" });
    if (wf) return pin(db, wf);
  }

  const fallback = await db.collection("workflows").findOne({ isDefault: true, status: "Active" });
  if (fallback) return pin(db, fallback);

  return null;
}

function toObjectId(id: string): ObjectId | string {
  try {
    return new ObjectId(id);
  } catch {
    return id;
  }
}

// Pin the workflow's current active version snapshot into a resolved result.
// Falls back to the live head steps if no snapshot exists (shouldn't happen for
// an Active workflow, but keeps the bot resilient).
async function pin(db: Db, wf: Document): Promise<ResolvedWorkflow> {
  const workflowId = wf._id.toString();
  const version = wf.version || 0;
  const snapshot = await db.collection("workflowVersions").findOne({ workflowId, version });
  const steps = (snapshot?.steps ?? wf.steps ?? []) as StepInstance[];
  return { workflowId, version, steps: [...steps].sort((a, b) => a.order - b.order) };
}
