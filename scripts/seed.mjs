// One-shot seed script: populates each collection only if it's currently
// empty, so it's safe to re-run (e.g. after `npm install`) without duplicating
// or clobbering real data. Run with: node scripts/seed.mjs
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";

const seeds = {
  units: [
    { name: "Pieces", symbol: "pcs", type: "Count", decimals: false, precision: "2", factor: "", baseUnit: "", status: "Active", refCount: 210 },
    { name: "Box", symbol: "box", type: "Count", decimals: false, precision: "2", factor: "12", baseUnit: "Pieces", status: "Active", refCount: 44 },
    { name: "Kilogram", symbol: "kg", type: "Weight", decimals: true, precision: "3", factor: "", baseUnit: "", status: "Active", refCount: 88 },
    { name: "Gram", symbol: "g", type: "Weight", decimals: true, precision: "2", factor: "0.001", baseUnit: "Kilogram", status: "Active", refCount: 0 },
    { name: "Liter", symbol: "L", type: "Volume", decimals: true, precision: "2", factor: "", baseUnit: "", status: "Active", refCount: 31 },
    { name: "Meter", symbol: "m", type: "Length", decimals: true, precision: "2", factor: "", baseUnit: "", status: "Active", refCount: 63 },
    { name: "Roll", symbol: "roll", type: "Count", decimals: false, precision: "2", factor: "", baseUnit: "", status: "Inactive", refCount: 0 },
  ],
  categories: [
    { name: "Plumbing", code: "PLM", desc: "Pipes, fittings and valves", defaultUnit: "Pieces", order: 1, color: "#3392ff", status: "Active", subCount: 6, refCount: 34 },
    { name: "Electrical", code: "ELE", desc: "Wiring, switches and boards", defaultUnit: "Meter", order: 2, color: "#f59e0b", status: "Active", subCount: 9, refCount: 58 },
    { name: "Paints & Finishes", code: "PNT", desc: "Emulsions, primers, enamels", defaultUnit: "Liter", order: 3, color: "#8b5cf6", status: "Active", subCount: 4, refCount: 0 },
    { name: "Hardware", code: "HDW", desc: "Screws, hinges, brackets", defaultUnit: "Box", order: 4, color: "#0d9488", status: "Active", subCount: 12, refCount: 120 },
    { name: "Sanitaryware", code: "SAN", desc: "Basins, taps, cisterns", defaultUnit: "Pieces", order: 5, color: "#ec4899", status: "Active", subCount: 5, refCount: 0 },
    { name: "Tools & Machinery", code: "TLS", desc: "Power and hand tools", defaultUnit: "Pieces", order: 6, color: "#6366f1", status: "Inactive", subCount: 3, refCount: 0 },
  ],
  subcategories: [
    { name: "Pipe Fittings", parent: "Plumbing", desc: "Elbows, tees, couplings", order: 1, status: "Active" },
    { name: "Valves", parent: "Plumbing", desc: "Gate, ball and check valves", order: 2, status: "Active" },
    { name: "Switches & Sockets", parent: "Electrical", desc: "Modular switches and plates", order: 1, status: "Active" },
    { name: "Circuit Breakers", parent: "Electrical", desc: "MCB, RCCB and distribution", order: 2, status: "Active" },
    { name: "Cables & Wires", parent: "Electrical", desc: "Copper and aluminium conductors", order: 3, status: "Active" },
    { name: "Emulsion Paints", parent: "Paints & Finishes", desc: "Interior and exterior emulsions", order: 1, status: "Active" },
    { name: "Fasteners", parent: "Hardware", desc: "Screws, bolts and anchors", order: 1, status: "Active" },
    { name: "Hinges & Brackets", parent: "Hardware", desc: "Door and cabinet hardware", order: 2, status: "Inactive" },
  ],
  roles: [
    { name: "Admin", desc: "Full control over all master data", color: "#1560f0", users: 2, status: "Active", perms: ["Add Inventory", "Manage Masters", "Manage Workflows", "Approve Entries", "View Reports"] },
    { name: "Inventory Manager", desc: "Runs day-to-day stock operations", color: "#0d9488", users: 5, status: "Active", perms: ["Add Inventory", "Approve Entries", "View Reports"] },
    { name: "Workflow Designer", desc: "Builds and edits custom workflows", color: "#8b5cf6", users: 3, status: "Active", perms: ["Manage Workflows", "View Reports"] },
    { name: "Viewer", desc: "Read-only access to reports", color: "#f59e0b", users: 11, status: "Active", perms: ["View Reports"] },
  ],
  users: [
    { username: "Asha Sharma", handle: "@asha", tgId: "584920113", role: "Admin", status: "Active" },
    { username: "Vedant Rao", handle: "@vedant", tgId: "729103845", role: "Inventory Manager", status: "Active" },
    { username: "Priya Nair", handle: "@priyan", tgId: "661204939", role: "Inventory Manager", status: "Active" },
    { username: "Karan Mehta", handle: "@karanm", tgId: "803451220", role: "Workflow Designer", status: "Active" },
    { username: "Sana Iqbal", handle: "@sana_i", tgId: "914662017", role: "Viewer", status: "Active" },
    { username: "Rohit Das", handle: "@rohitd", tgId: "452098311", role: "Viewer", status: "Inactive" },
    { username: "Meera Joshi", handle: "@meeraj", tgId: "778120654", role: "Workflow Designer", status: "Active" },
  ],
  statuses: [
    { name: "Draft", color: "#94a3b8", behavior: "Hidden from bot", applies: ["Categories", "Subcategories"], records: 4, isDefault: false, order: 1 },
    { name: "Pending", color: "#f59e0b", behavior: "Locked, awaiting approval", applies: ["Categories", "Locations", "Units"], records: 7, isDefault: false, order: 2 },
    { name: "Active", color: "#0f9d63", behavior: "Editable, visible to bot", applies: ["Categories", "Subcategories", "Locations", "Units", "Roles"], records: 186, isDefault: true, order: 3 },
    { name: "Archived", color: "#6366f1", behavior: "Read-only archive", applies: ["Categories", "Locations"], records: 12, isDefault: false, order: 4 },
    { name: "Inactive", color: "#8a97b0", behavior: "Hidden from bot", applies: ["Categories", "Subcategories", "Locations", "Units", "Roles"], records: 23, isDefault: false, order: 5 },
  ],
  colors: [
    { name: "Brand Primary", hex: "#1560f0", group: "Corporate Colors" },
    { name: "Brand Navy", hex: "#0b1b45", group: "Corporate Colors" },
    { name: "Brand Teal", hex: "#0d9488", group: "Corporate Colors" },
    { name: "Plumbing Blue", hex: "#3392ff", group: "Inventory Colors" },
    { name: "Electrical Amber", hex: "#f59e0b", group: "Inventory Colors" },
    { name: "Paints Violet", hex: "#8b5cf6", group: "Inventory Colors" },
    { name: "Hardware Green", hex: "#0d9488", group: "Inventory Colors" },
    { name: "Priority", hex: "#ef4444", group: "Tag Colors" },
    { name: "Seasonal", hex: "#ec4899", group: "Tag Colors" },
    { name: "Bulk", hex: "#6366f1", group: "Tag Colors" },
    { name: "Active Green", hex: "#0f9d63", group: "Status Colors" },
    { name: "Pending Amber", hex: "#f59e0b", group: "Status Colors" },
    { name: "Inactive Gray", hex: "#8a97b0", group: "Status Colors" },
  ],
  apiKeys: [
    { name: "Telegram Bot", masked: "mb_live_••••7f3a", scope: "Read", lastUsed: "2 min ago" },
    { name: "Workflow Engine (Story 2)", masked: "mb_live_••••b19c", scope: "Read", lastUsed: "18 min ago" },
    { name: "Analytics Sync", masked: "mb_test_••••4dd0", scope: "Read", lastUsed: "Yesterday" },
  ],
  importJobs: [
    { type: "Import", master: "Units", by: "Asha Sharma", rows: 14, when: "2026-07-19T10:22:00.000Z", result: "Success" },
    { type: "Export", master: "All masters", by: "Vedant Rao", rows: 284, when: "2026-07-18T09:00:00.000Z", result: "Success" },
    { type: "Import", master: "Categories", by: "Asha Sharma", rows: 128, when: "2026-07-17T09:00:00.000Z", result: "6 skipped" },
    { type: "Import", master: "Storage Locations", by: "Priya Nair", rows: 52, when: "2026-07-15T09:00:00.000Z", result: "Success" },
  ],
};

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  for (const [collection, docs] of Object.entries(seeds)) {
    const count = await db.collection(collection).countDocuments();
    if (count > 0) {
      console.log(`skip ${collection} (already has ${count} docs)`);
      continue;
    }
    await db.collection(collection).insertMany(docs);
    console.log(`seeded ${collection}: ${docs.length} docs`);
  }

  // Storage Locations needs parent references by _id, so seed it separately
  // after computing ids in order.
  const locCount = await db.collection("locations").countDocuments();
  if (locCount === 0) {
    const locs = db.collection("locations");
    const cw = await locs.insertOne({ parent: null, name: "Central Warehouse", level: "Warehouse", code: "CW", capacity: "", status: "Active", refCount: 0 });
    const gf = await locs.insertOne({ parent: cw.insertedId.toString(), name: "Ground Floor", level: "Floor", code: "GF", capacity: "", status: "Active", refCount: 0 });
    const aa = await locs.insertOne({ parent: gf.insertedId.toString(), name: "Aisle A", level: "Aisle", code: "AA", capacity: "", status: "Active", refCount: 0 });
    await locs.insertOne({ parent: aa.insertedId.toString(), name: "Rack A1", level: "Rack", code: "RA1", capacity: 120, status: "Active", refCount: 18 });
    await locs.insertOne({ parent: aa.insertedId.toString(), name: "Rack A2", level: "Rack", code: "RA2", capacity: 120, status: "Active", refCount: 0 });
    await locs.insertOne({ parent: gf.insertedId.toString(), name: "Aisle B", level: "Aisle", code: "AB", capacity: "", status: "Active", refCount: 0 });
    await locs.insertOne({ parent: cw.insertedId.toString(), name: "Mezzanine", level: "Floor", code: "MZ", capacity: "", status: "Inactive", refCount: 0 });
    const nb = await locs.insertOne({ parent: null, name: "North Branch", level: "Warehouse", code: "NB", capacity: "", status: "Active", refCount: 0 });
    await locs.insertOne({ parent: nb.insertedId.toString(), name: "Cold Zone", level: "Zone", code: "CZ", capacity: 400, status: "Active", refCount: 52 });
    console.log("seeded locations: 9 docs");
  } else {
    console.log(`skip locations (already has ${locCount} docs)`);
  }

  await client.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
