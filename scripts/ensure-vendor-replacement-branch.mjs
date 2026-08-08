// Ensures the search-move workflow includes the Vendor Replacement branch.
// Prefer relying on getSearchMoveWorkflow (app load); this is a one-shot helper.
//
//   node scripts/ensure-vendor-replacement-branch.mjs
import { MongoClient } from "mongodb";
import { config } from "dotenv";
config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";

// Minimal inline ensure — avoids importing TS from Node.
function nid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeStep(kind, label, message) {
  const defaults = {
    location: "{{product}}\n\nPick a storage location:",
    pick_vendor: "{{product}} — {{type}}\n\nPick the vendor:",
    qty: "{{product}} — {{type}}\n{{where}}\n\nQty: {{qty}} {{unit}}",
    question: "{{type}}\n\n{{question}}",
    reference: "Type the original PO, GRN, invoice, or receipt reference.",
    review: "Review, then add to cart.",
    add_to_cart: "{{product}} × {{qty}} {{unit}}\n{{where}}\n{{type}}\n\nAdd this line to your cart?",
  };
  return {
    id: nid(kind),
    kind,
    label,
    message: message ?? defaults[kind] ?? label,
    children: [],
  };
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const doc = await db.collection("searchMoveWorkflows").findOne({ key: "search-move" });
  if (!doc?.nodes) {
    console.log("No search-move workflow yet — it will be created with Vendor Replacement on first load.");
    await client.close();
    return;
  }
  const nodes = doc.nodes;
  const hasVr = Object.values(nodes).some((n) => n?.kind === "movement" && n.movementCode === "vendor-replacement");
  if (hasVr) {
    console.log("Vendor Replacement branch already present.");
    await client.close();
    return;
  }
  const hubId = Object.keys(nodes).find((id) => nodes[id]?.kind === "select_movement");
  if (!hubId) {
    console.log("No select_movement hub — skip.");
    await client.close();
    return;
  }

  const move = {
    id: nid("movement"),
    kind: "movement",
    label: "Vendor Replacement",
    message: "{{product}} — {{type}}",
    movementCode: "vendor-replacement",
    direction: "out",
    children: [],
  };
  const qReason = {
    id: `q_${Math.random().toString(36).slice(2, 10)}`,
    type: "select",
    label: "Reason for Replacement",
    required: true,
    order: 0,
    options: ["Damaged", "Defective", "Wrong Item", "Wrong Quantity", "Quality Rejection", "Expired", "Other"],
  };
  const qDetail = {
    id: `q_${Math.random().toString(36).slice(2, 10)}`,
    type: "string",
    label: "Additional reason / comment",
    required: false,
    order: 1,
    placeholder: "Required if you selected Other",
  };
  const steps = [
    makeStep("location", "From location"),
    makeStep("pick_vendor", "Select vendor"),
    makeStep("qty", "Quantity"),
    { ...makeStep("question", qReason.label), question: qReason },
    { ...makeStep("question", qDetail.label), question: qDetail },
    makeStep("reference", "Original Reference"),
    makeStep("review", "Review"),
    makeStep("add_to_cart", "Add to cart"),
  ];
  for (let i = 0; i < steps.length - 1; i++) steps[i].children = [steps[i + 1].id];
  move.children = [steps[0].id];

  const nextNodes = { ...nodes, [move.id]: move };
  for (const s of steps) nextNodes[s.id] = s;
  nextNodes[hubId] = { ...nodes[hubId], children: [...(nodes[hubId].children || []), move.id] };

  await db.collection("searchMoveWorkflows").updateOne(
    { key: "search-move" },
    { $set: { nodes: nextNodes, updatedAt: new Date().toISOString() } }
  );
  await db.collection("movementTypes").updateOne(
    { code: "vendor-replacement" },
    { $set: { questions: [qReason, qDetail], updatedAt: new Date().toISOString() } }
  );
  console.log("Added Vendor Replacement branch to search-move workflow.");
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
