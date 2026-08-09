// Fold legacy subcategories into the category tree and seed demo nesting for
// every department. Preserves the existing Plumbing › Pipe subtree.
//
//   npm run seed:category-trees
//   node scripts/seed-all-category-trees.mjs

import { MongoClient, ObjectId } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "inventory";
if (!uri) {
  console.error("MONGODB_URI is not set.");
  process.exit(1);
}

const PALETTE = ["#3392ff", "#0d9488", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#10b981", "#6366f1", "#f97316", "#14b8a6", "#e11d48", "#0ea5e9"];

// Demo trees keyed by the plain department name (emoji stripped when matching).
// Existing named children are kept; missing branches are added. Plumbing keeps
// its Pipe tree — we only add siblings alongside it.
const DEMO_TREES = {
  Electrical: [
    {
      name: "Wiring",
      level: "Subcategory",
      children: [
        { name: "Copper", level: "Type", children: leaf(["1.5 sqmm", "2.5 sqmm", "4 sqmm", "6 sqmm", "10 sqmm"]) },
        { name: "Aluminium", level: "Type", children: leaf(["10 sqmm", "16 sqmm", "25 sqmm", "35 sqmm"]) },
        { name: "Flexible", level: "Type", children: leaf(["0.75 sqmm", "1 sqmm", "1.5 sqmm", "2.5 sqmm"]) },
      ],
    },
    {
      name: "Fan",
      level: "Subcategory",
      children: [
        { name: "Ceiling", level: "Type", children: leaf(["48 inch", "56 inch"]) },
        { name: "Exhaust", level: "Type", children: leaf(["6 inch", "9 inch", "12 inch"]) },
        { name: "Pedestal", level: "Type", children: leaf(["16 inch", "18 inch"]) },
      ],
    },
    {
      name: "Switch",
      level: "Subcategory",
      children: [
        { name: "Modular", level: "Type", children: leaf(["1 way", "2 way", "Dimmer", "Socket 6A", "Socket 16A"]) },
        { name: "Industrial", level: "Type", children: leaf(["DP Switch", "TPN Switch"]) },
      ],
    },
    {
      name: "MCB",
      level: "Subcategory",
      children: [
        { name: "Single Pole", level: "Type", children: leaf(["6A", "10A", "16A", "20A", "32A"]) },
        { name: "Double Pole", level: "Type", children: leaf(["16A", "32A", "40A", "63A"]) },
        { name: "RCCB", level: "Type", children: leaf(["25A 30mA", "40A 30mA", "63A 100mA"]) },
      ],
    },
    {
      name: "Light",
      level: "Subcategory",
      children: [
        { name: "LED Panel", level: "Type", children: leaf(["6W", "12W", "18W", "24W"]) },
        { name: "Tube Light", level: "Type", children: leaf(["18W", "20W", "36W"]) },
        { name: "Flood Light", level: "Type", children: leaf(["50W", "100W", "150W"]) },
      ],
    },
    { name: "Exhaust", level: "Subcategory", children: leaf(["Wall Mount", "Inline"]) },
    { name: "DG/Generator", level: "Subcategory", children: leaf(["Diesel", "Petrol", "Gas"]) },
    { name: "Stabilizer", level: "Subcategory", children: leaf(["1 kVA", "2 kVA", "5 kVA", "10 kVA"]) },
  ],
  Machine: [
    {
      name: "Filling",
      level: "Subcategory",
      children: [
        { name: "Liquid Filler", level: "Type", children: leaf(["Semi-auto", "Automatic"]) },
        { name: "Powder Filler", level: "Type", children: leaf(["Auger", "Volumetric"]) },
      ],
    },
    {
      name: "Labeling",
      level: "Subcategory",
      children: [
        { name: "Sticker Labeler", level: "Type", children: leaf(["Round Bottle", "Flat Bottle"]) },
        { name: "Sleeve Labeler", level: "Type", children: leaf(["Steam", "Electric"]) },
      ],
    },
    { name: "Balance/Load Cell", level: "Subcategory", children: leaf(["Platform", "Bench", "Checkweigher"]) },
    { name: "Cartoner", level: "Subcategory", children: leaf(["Horizontal", "Vertical"]) },
    { name: "Chiller", level: "Subcategory", children: leaf(["Air Cooled", "Water Cooled", "3 TR", "5 TR", "10 TR"]) },
    { name: "Lift", level: "Subcategory", children: leaf(["Goods Lift", "Passenger", "Hydraulic"]) },
  ],
  Furniture: [
    {
      name: "Door",
      level: "Subcategory",
      children: [
        { name: "Wooden", level: "Type", children: leaf(["Flush", "Panel", "Fire Rated"]) },
        { name: "Aluminium", level: "Type", children: leaf(["Single", "Double", "Sliding"]) },
        { name: "Glass", level: "Type", children: leaf(["Tempered", "Laminated"]) },
      ],
    },
    {
      name: "Window",
      level: "Subcategory",
      children: [
        { name: "Sliding", level: "Type", children: leaf(["2 Track", "3 Track"]) },
        { name: "Casement", level: "Type", children: leaf(["Single", "Double"]) },
      ],
    },
    { name: "Glass", level: "Subcategory", children: leaf(["Clear", "Tinted", "Frosted", "Toughened"]) },
    { name: "Chair", level: "Subcategory", children: leaf(["Office", "Visitor", "Lab Stool"]) },
    { name: "Table", level: "Subcategory", children: leaf(["Office Desk", "Conference", "Work Bench"]) },
    { name: "Signage", level: "Subcategory", children: leaf(["Acrylic", "ACP Board", "Neon"]) },
    { name: "ACP", level: "Subcategory", children: leaf(["3mm", "4mm", "Interior", "Exterior"]) },
  ],
  "Water & Air": [
    {
      name: "Pump",
      level: "Subcategory",
      children: [
        { name: "Centrifugal", level: "Type", children: leaf(["0.5 HP", "1 HP", "2 HP", "5 HP"]) },
        { name: "Submersible", level: "Type", children: leaf(["1 HP", "2 HP", "3 HP"]) },
        { name: "Booster", level: "Type", children: leaf(["Domestic", "Industrial"]) },
      ],
    },
    {
      name: "Compressor",
      level: "Subcategory",
      children: [
        { name: "Reciprocating", level: "Type", children: leaf(["1 HP", "2 HP", "5 HP"]) },
        { name: "Screw", level: "Type", children: leaf(["7.5 HP", "10 HP", "15 HP"]) },
      ],
    },
    { name: "RO", level: "Subcategory", children: leaf(["250 LPH", "500 LPH", "1000 LPH", "Membrane", "Cartridge"]) },
    { name: "EDI", level: "Subcategory", children: leaf(["Module", "Controller", "Power Supply"]) },
    { name: "Heater", level: "Subcategory", children: leaf(["Instant", "Storage", "Immersion"]) },
    { name: "Tank", level: "Subcategory", children: leaf(["SS 304", "SS 316", "Plastic", "500 L", "1000 L", "2000 L"]) },
  ],
  "Telephone & Camera": [
    {
      name: "Telephone",
      level: "Subcategory",
      children: [
        { name: "Analog", level: "Type", children: leaf(["Single Line", "EPABX Extension"]) },
        { name: "IP Phone", level: "Type", children: leaf(["Entry", "Executive", "Conference"]) },
      ],
    },
    {
      name: "Camera",
      level: "Subcategory",
      children: [
        { name: "Dome", level: "Type", children: leaf(["2MP", "4MP", "5MP"]) },
        { name: "Bullet", level: "Type", children: leaf(["2MP", "4MP", "8MP"]) },
        { name: "PTZ", level: "Type", children: leaf(["Indoor", "Outdoor"]) },
      ],
    },
    { name: "NVR", level: "Subcategory", children: leaf(["4 Channel", "8 Channel", "16 Channel", "32 Channel"]) },
    { name: "LAN", level: "Subcategory", children: leaf(["Cat6 Cable", "Switch 8 Port", "Switch 24 Port", "Patch Cord"]) },
    { name: "UPS", level: "Subcategory", children: leaf(["600 VA", "1 kVA", "2 kVA", "5 kVA", "Online", "Offline"]) },
  ],
  "Door Inter Locks/Pressure Gauge": [
    {
      name: "Door Interlock",
      level: "Subcategory",
      children: [
        { name: "Electromagnetic", level: "Type", children: leaf(["Single Door", "Double Door"]) },
        { name: "Electromechanical", level: "Type", children: leaf(["Fail Safe", "Fail Secure"]) },
      ],
    },
    {
      name: "Pressure Gauge",
      level: "Subcategory",
      children: [
        { name: "Analog", level: "Type", children: leaf(["0–1 bar", "0–6 bar", "0–10 bar", "0–16 bar"]) },
        { name: "Digital", level: "Type", children: leaf(["Absolute", "Differential"]) },
      ],
    },
    { name: "Access Control", level: "Subcategory", children: leaf(["Card Reader", "Biometric", "Controller"]) },
  ],
  QC: [
    { name: "Water Bath", level: "Subcategory", children: leaf(["5 L", "10 L", "20 L", "Digital", "Analog"]) },
    { name: "Sonicator", level: "Subcategory", children: leaf(["Bath", "Probe", "50W", "100W", "250W"]) },
    { name: "Oven", level: "Subcategory", children: leaf(["Hot Air", "Vacuum", "50 L", "100 L", "200 L"]) },
    { name: "Balance", level: "Subcategory", children: leaf(["Analytical", "Precision", "0.1 mg", "1 mg"]) },
    { name: "pH Meter", level: "Subcategory", children: leaf(["Benchtop", "Portable", "Probe"]) },
  ],
  "Civil Work": [
    {
      name: "Tile",
      level: "Subcategory",
      children: [
        { name: "Floor", level: "Type", children: leaf(["Vitrified", "Ceramic", "Kota", "600×600", "800×800"]) },
        { name: "Wall", level: "Type", children: leaf(["Ceramic", "Porcelain", "300×600"]) },
      ],
    },
    { name: "Plaster", level: "Subcategory", children: leaf(["Internal", "External", "Gypsum", "Cement"]) },
    { name: "Demolition", level: "Subcategory", children: leaf(["Wall", "Floor", "Ceiling"]) },
    { name: "Kota Work", level: "Subcategory", children: leaf(["Flooring", "Skirting", "Step"]) },
    { name: "Brick Work", level: "Subcategory", children: leaf(["Partition", "Load Bearing", "4.5 inch", "9 inch"]) },
  ],
  Others: [
    { name: "Pest", level: "Subcategory", children: leaf(["Spray", "Gel", "Fumigation", "Trap"]) },
    { name: "Fire", level: "Subcategory", children: leaf(["Extinguisher CO2", "Extinguisher ABC", "Hose Reel", "Alarm"]) },
    { name: "Bird Net", level: "Subcategory", children: leaf(["Nylon", "HDPE", "Installation"]) },
    { name: "Washroom", level: "Subcategory", children: leaf(["Tap", "Flush", "Urinal", "Mirror", "Dispenser"]) },
    { name: "Riser", level: "Subcategory", children: leaf(["Electrical", "Plumbing", "HVAC"]) },
  ],
  Paint: [
    {
      name: "Epoxy",
      level: "Subcategory",
      children: [
        { name: "Floor Coating", level: "Type", children: leaf(["Self Leveling", "Antistatic", "1 mm", "2 mm"]) },
        { name: "Primer", level: "Type", children: leaf(["Clear", "Grey"]) },
      ],
    },
    {
      name: "Wall Paint",
      level: "Subcategory",
      children: [
        { name: "Emulsion", level: "Type", children: leaf(["Interior", "Exterior", "1 L", "4 L", "10 L", "20 L"]) },
        { name: "Enamel", level: "Type", children: leaf(["Gloss", "Matt", "1 L", "4 L"]) },
      ],
    },
    { name: "Silicon & Putty", level: "Subcategory", children: leaf(["White Putty", "Acrylic Putty", "Silicone Sealant"]) },
    { name: "Grout", level: "Subcategory", children: leaf(["Cementitious", "Epoxy", "White", "Grey"]) },
    { name: "Coving", level: "Subcategory", children: leaf(["PVC", "Epoxy", "SS"]) },
    { name: "Color", level: "Subcategory", children: leaf(["White", "Off White", "Grey", "Blue", "Custom"]) },
  ],
  HVAC: [
    {
      name: "AC",
      level: "Subcategory",
      children: [
        { name: "Split", level: "Type", children: leaf(["1 Ton", "1.5 Ton", "2 Ton"]) },
        { name: "Cassette", level: "Type", children: leaf(["1.5 Ton", "2 Ton", "3 Ton"]) },
        { name: "Window", level: "Type", children: leaf(["1 Ton", "1.5 Ton"]) },
      ],
    },
    { name: "Outdoor", level: "Subcategory", children: leaf(["Condenser", "Fan Motor", "Gas Charging"]) },
    {
      name: "AHU",
      level: "Subcategory",
      children: [
        { name: "Filter", level: "Type", children: leaf(["Pre Filter", "Fine Filter", "HEPA"]) },
        { name: "Coil", level: "Type", children: leaf(["Cooling", "Heating"]) },
        { name: "Blower", level: "Type", children: leaf(["Forward Curve", "Backward Curve"]) },
      ],
    },
    { name: "Ducting", level: "Subcategory", children: leaf(["GI Duct", "Flexible Duct", "Damper", "Grill"]) },
  ],
  Cleaning: [
    { name: "Rusting", level: "Subcategory", children: leaf(["Rust Remover", "Converter", "Primer"]) },
    { name: "Floor Care", level: "Subcategory", children: leaf(["Cleaner", "Wax", "Scrubber Pad"]) },
    { name: "Disinfectant", level: "Subcategory", children: leaf(["Surface", "Fogging", "Hand Rub"]) },
  ],
  Plumbing: [
    // Pipe tree is seeded separately — leave it alone. Add fittings/valves alongside.
    {
      name: "Fittings",
      level: "Subcategory",
      children: [
        { name: "Elbow", level: "Type", children: leaf(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm", "50 mm"]) },
        { name: "Tee", level: "Type", children: leaf(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm"]) },
        { name: "Coupling", level: "Type", children: leaf(["15 mm", "20 mm", "25 mm", "40 mm", "50 mm"]) },
        { name: "Reducer", level: "Type", children: leaf(["25×20", "32×25", "40×32", "50×40"]) },
      ],
    },
    {
      name: "Valves",
      level: "Subcategory",
      children: [
        { name: "Ball Valve", level: "Type", children: leaf(["15 mm", "20 mm", "25 mm", "40 mm", "50 mm"]) },
        { name: "Gate Valve", level: "Type", children: leaf(["25 mm", "40 mm", "50 mm", "80 mm"]) },
        { name: "Check Valve", level: "Type", children: leaf(["25 mm", "40 mm", "50 mm"]) },
      ],
    },
    { name: "FRAME DHAKAN", level: "Subcategory", children: leaf(["Cast Iron", "SS", "Plastic"]) },
  ],
  "Label Due": [
    { name: "Product Label", level: "Subcategory", children: leaf(["Paper", "Synthetic", "Thermal"]) },
    { name: "Safety Label", level: "Subcategory", children: leaf(["Warning", "Mandatory", "Prohibition"]) },
  ],
  Gardening: [
    { name: "Plants", level: "Subcategory", children: leaf(["Indoor", "Outdoor", "Seasonal"]) },
    { name: "Tools", level: "Subcategory", children: leaf(["Pruner", "Hose", "Sprinkler", "Pot"]) },
    { name: "Soil & Fertilizer", level: "Subcategory", children: leaf(["Potting Mix", "Compost", "NPK"]) },
  ],
  Transfer: [
    { name: "Internal", level: "Subcategory", children: leaf(["Plant to Warehouse", "Warehouse to Plant"]) },
    { name: "External", level: "Subcategory", children: leaf(["Vendor Pickup", "Site Transfer"]) },
  ],
  Information: [
    { name: "Documentation", level: "Subcategory", children: leaf(["SOP", "Manual", "Drawing"]) },
    { name: "Signage Info", level: "Subcategory", children: leaf(["Safety Board", "Instruction"]) },
  ],
};

function leaf(names) {
  return names.map((name) => ({ name, level: "Size", children: [] }));
}

function plainName(name) {
  return String(name || "")
    .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, "")
    .trim();
}

function findChild(existing, parentId, name) {
  return existing.find((c) => String(c.parent) === String(parentId) && String(c.name) === name);
}

async function ensureNode(col, existing, parentId, node, color, defaultUnit, order, stats) {
  let doc = findChild(existing, parentId, node.name);
  let id;
  if (doc) {
    id = doc._id.toString();
    stats.skipped += 1;
    // Keep level labels useful if they were blank.
    if (!doc.level && node.level) {
      await col.updateOne({ _id: doc._id }, { $set: { level: node.level } });
    }
  } else {
    const result = await col.insertOne({
      parent: parentId,
      name: node.name,
      code: node.code || "",
      desc: node.desc || "",
      level: node.level || "Subcategory",
      defaultUnit,
      color,
      order,
      status: "Active",
      refCount: 0,
    });
    id = result.insertedId.toString();
    doc = { _id: result.insertedId, parent: parentId, name: node.name };
    existing.push(doc);
    stats.inserted += 1;
  }

  const kids = node.children || [];
  for (let i = 0; i < kids.length; i++) {
    await ensureNode(col, existing, id, kids[i], color, defaultUnit, i + 1, stats);
  }
  return id;
}

async function main() {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(dbName);
  const col = db.collection("categories");
  const legacy = db.collection("subcategories");

  console.log(`DB: ${dbName}`);

  // 1) Normalize roots
  const rootFix = await col.updateMany(
    { $or: [{ parent: { $exists: false } }, { parent: "" }] },
    { $set: { parent: null, level: "Category" } }
  );
  console.log(`Normalized roots: ${rootFix.modifiedCount}`);

  let existing = await col.find({}).toArray();
  const roots = existing.filter((c) => c.parent == null || c.parent === "");
  console.log(`Roots: ${roots.length}`);

  const stats = { inserted: 0, skipped: 0, migrated: 0 };

  // 2) Migrate leftover legacy subcategories (name-linked) into the tree
  const legacySubs = await legacy.find({}).toArray();
  console.log(`Legacy subcategories to fold: ${legacySubs.length}`);
  for (const s of legacySubs) {
    const parentName = String(s.parent || "");
    const root =
      roots.find((r) => String(r.name) === parentName) ||
      roots.find((r) => plainName(r.name) === plainName(parentName)) ||
      roots.find((r) => plainName(r.name) === plainName(parentName) || String(r.name).includes(plainName(parentName)));
    if (!root) {
      console.warn(`  orphan legacy: ${s.name} (parent "${parentName}")`);
      continue;
    }
    const parentId = root._id.toString();
    if (findChild(existing, parentId, s.name)) {
      stats.skipped += 1;
    } else {
      const siblings = existing.filter((c) => String(c.parent) === parentId).length;
      const result = await col.insertOne({
        parent: parentId,
        name: s.name,
        code: "",
        desc: s.desc || "",
        level: "Subcategory",
        defaultUnit: root.defaultUnit || "Pieces",
        color: root.color || PALETTE[0],
        order: typeof s.order === "number" ? s.order : siblings + 1,
        status: s.status === "Inactive" ? "Inactive" : "Active",
        refCount: 0,
        migratedFromSubcategoryId: s._id.toString(),
      });
      existing.push({ _id: result.insertedId, parent: parentId, name: s.name });
      stats.migrated += 1;
    }
  }
  if (legacySubs.length) {
    const arch = db.collection("subcategories_archived");
    for (const s of legacySubs) {
      await arch.updateOne({ _id: s._id }, { $set: { ...s, archivedAt: new Date(), archiveReason: "seed-all-category-trees" } }, { upsert: true });
    }
    await legacy.deleteMany({ _id: { $in: legacySubs.map((s) => s._id) } });
    console.log(`Archived ${legacySubs.length} legacy subcategory rows`);
  }

  // Refresh after migration
  existing = await col.find({}).toArray();

  // 3) Ensure demo trees under every department
  for (const root of roots) {
    const key = plainName(root.name);
    const tree = DEMO_TREES[key];
    if (!tree) {
      console.log(`  (no demo tree for "${root.name}")`);
      continue;
    }
    const color = root.color || PALETTE[0];
    const unit = root.defaultUnit || "Pieces";
    const parentId = root._id.toString();
    console.log(`Seeding under ${root.name}…`);
    for (let i = 0; i < tree.length; i++) {
      await ensureNode(col, existing, parentId, tree[i], color, unit, i + 1, stats);
    }
  }

  existing = await col.find({}).toArray();
  const childCount = existing.filter((c) => c.parent != null && c.parent !== "").length;
  console.log(`\nDone. inserted=${stats.inserted} migrated=${stats.migrated} skipped=${stats.skipped}`);
  console.log(`Category nodes total=${existing.length} (roots=${roots.length}, nested=${childCount})`);

  // Print first-level summary
  for (const root of roots.sort((a, b) => (a.order || 0) - (b.order || 0))) {
    const kids = existing.filter((c) => String(c.parent) === root._id.toString());
    console.log(`  ${root.name}: ${kids.length} direct children`);
  }

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
