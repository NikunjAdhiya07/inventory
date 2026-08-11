// Force New Purchase onto every Entries-mode Telegram group's flowchart.
//
//   node scripts/ensure-entry-new-purchase.mjs
import { MongoClient } from "mongodb";
import { config } from "dotenv";
config({ path: ".env.local" });
config();

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";

function nid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function chain(defs) {
  const nodes = defs.map((d) => ({
    id: nid(d.kind),
    kind: d.kind,
    label: d.label,
    message: d.message ?? d.label,
    children: [],
  }));
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].children = [nodes[i + 1].id];
  return nodes;
}

function attachNewPurchase(nodes, hub) {
  const move = {
    id: nid("movement"),
    kind: "movement",
    label: "New Purchase",
    message: "{{product}} — {{type}}",
    movementCode: "new-purchase",
    direction: "in",
    children: [],
  };
  const steps = chain([
    {
      kind: "qty",
      label: "Quantity",
      message: "{{product}} — {{type}}\n\nHow many?\n\nQty: {{qty}} {{unit}}",
    },
    {
      kind: "pick_vendor",
      label: "Select vendor",
      message:
        "{{product}} — {{type}}\n\nWho are you purchasing this from?\n\n<i>Type a name to search Vendor Master, or pick below.</i>",
    },
    {
      kind: "location",
      label: "Where will this stock be stored?",
      message: "{{product}} — {{type}}\n\nWhere will this stock be stored?",
    },
    {
      kind: "stock_in",
      label: "Increase stock (+)",
      message: "{{product}} Confirm: increase stock",
    },
    { kind: "review", label: "📋 Review", message: "Review, then add to cart." },
    { kind: "add_to_cart", label: "🛒 Add to Cart", message: "Add this line to your cart?" },
  ]);
  for (const s of steps) nodes[s.id] = s;
  if (steps[0]) move.children = [steps[0].id];
  nodes[move.id] = move;
  hub.children = [...(hub.children || []), move.id];
  const codes = new Set([...(hub.movementCodes || []), "new-purchase"]);
  for (const id of hub.children) {
    const code = nodes[id]?.movementCode;
    if (code) codes.add(code);
  }
  hub.movementCodes = [...codes];
  return move.id;
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const entryGroups = await db
    .collection("telegramGroups")
    .find({ $or: [{ mode: "entry" }, { mode: { $exists: false } }, { mode: null }, { mode: "" }] })
    .project({ chatId: 1, title: 1, mode: 1 })
    .toArray();

  // Exclude explicit request-mode groups.
  const groups = entryGroups.filter((g) => g.mode !== "request");
  console.log(`Entries-mode groups: ${groups.length}`);

  let patched = 0;
  let created = 0;
  let skipped = 0;

  for (const g of groups) {
    const chatId = String(g.chatId ?? "");
    if (!chatId) continue;
    const key = `search-move:${chatId}`;
    const doc = await db.collection("searchMoveWorkflows").findOne({ key });
    const title = g.title || chatId;

    if (!doc?.nodes) {
      console.log(`  · ${title}: no flowchart yet — will be built on next Workflows/Telegram load`);
      skipped++;
      continue;
    }

    const nodes = { ...doc.nodes };
    const hasNp = Object.values(nodes).some((n) => n?.kind === "movement" && n.movementCode === "new-purchase");
    if (hasNp) {
      console.log(`  · ${title}: New Purchase already present`);
      skipped++;
      continue;
    }

    const hubId = Object.keys(nodes).find((id) => nodes[id]?.kind === "select_movement");
    if (!hubId) {
      console.log(`  · ${title}: no select_movement hub — skip (open Workflows → Load Entries template)`);
      skipped++;
      continue;
    }

    const hub = { ...nodes[hubId] };
    attachNewPurchase(nodes, hub);
    nodes[hubId] = hub;

    await db.collection("searchMoveWorkflows").updateOne(
      { key },
      {
        $set: {
          nodes,
          name: doc.name || "Data Entry — Add to Stock + New Purchase",
          updatedAt: new Date().toISOString(),
          chatId,
        },
      }
    );
    console.log(`  ✓ ${title}: added New Purchase`);
    patched++;
  }

  // Also ensure movement type exists.
  const mt = await db.collection("movementTypes").findOne({ code: "new-purchase" });
  if (!mt) {
    await db.collection("movementTypes").insertOne({
      code: "new-purchase",
      name: "New Purchase",
      direction: "in",
      description:
        "Purchase from a Vendor Master vendor into a storage location. Simple flow: qty → vendor → location → cart.",
      requireReference: false,
      requireRemarks: false,
      order: 11,
      status: "Active",
      isSystem: false,
      questions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    created++;
    console.log("Created movementTypes.new-purchase");
  }

  console.log(`Done. patched=${patched} skipped=${skipped} movementTypeCreated=${created}`);
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
