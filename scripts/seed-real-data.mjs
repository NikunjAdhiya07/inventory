// Loads the real v1 master data (category tree, locations) into
// Mongo as a one-shot replace of those collections.
// MongoDB, REPLACING whatever is currently in those three collections.
// Run with: node scripts/seed-real-data.mjs
import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB || "inventory";

const PALETTE = ["#3392ff", "#0d9488", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#10b981", "#6366f1", "#f97316", "#14b8a6", "#e11d48", "#0ea5e9"];

// [name, icon, code, priority, subCount, namedSubcategories[]]
const CATEGORY_DATA = [
  ["Electrical", "⚡", "ELE", 5, 15, ["Wiring", "Fan", "Switch", "MCB", "Light", "Exhaust", "DG/Generator", "Stabilizer"]],
  ["Machine", "⚙️", "MCH", 10, 31, ["Filling", "Labeling", "Balance/Load Cell", "Cartoner", "Chiller", "Lift"]],
  ["Furniture", "🪑", "FUR", 9, 29, ["Door", "Window", "Glass", "Chair", "Table", "Signage", "ACP"]],
  ["Water & Air", "💧", "WAT", 5, 15, ["Pump", "Compressor", "RO", "EDI", "Heater", "Tank"]],
  ["Telephone & Camera", "☎️", "TEL", 4, 11, ["Telephone", "Camera", "NVR", "LAN", "UPS"]],
  ["Door Inter Locks/Pressure Gauge", "🔐", "DIL", 6, 10, []],
  ["QC", "🔬", "QC", 3, 8, ["Water Bath", "Sonicator", "Oven"]],
  ["Civil Work", "⛑️", "CIV", 3, 7, ["Tile", "Plaster", "Demolition", "Kota Work", "Brick Work"]],
  ["Others", "📦", "OTH", 3, 7, ["Pest", "Fire", "Bird Net", "Washroom", "Riser", "Riser", "Furniture"]],
  ["Paint", "🎨", "PNT", 1, 6, ["Epoxy", "Wall Paint", "Silicon & Putty", "Grout", "Coving", "Color"]],
  ["HVAC", "❄️", "HVC", 4, 3, ["AC", "Outdoor", "AHU"]],
  ["Cleaning", "🧹", "CLN", 2, 1, ["Rusting"]],
  ["Plumbing", "🚰", "PLM", 1, 1, ["FRAME DHAKAN"]],
  ["Transfer", "🚚", "TRF", 0, 0, []],
  ["Label Due", "🏷️", "LBD", 0, 0, []],
  ["Information", "ℹ️", "INF", 0, 0, []],
  ["Gardening", "🌱", "GDN", 0, 0, []],
];

const LOCATION_TREE = [
  {
    name: "132",
    level: "Site",
    children: [
      { name: "Office", level: "Area", children: [{ name: "1F", level: "Floor" }, { name: "2F", level: "Floor" }, { name: "GF", level: "Floor" }, { name: "Terrace", level: "Floor" }] },
      { name: "Outside Area", level: "Area" },
      { name: "Plant", level: "Area", children: [{ name: "1F", level: "Floor" }, { name: "1F Service", level: "Floor" }] },
      { name: "Warehouse", level: "Area", children: [{ name: "1F", level: "Floor" }, { name: "2F", level: "Floor" }, { name: "Ground", level: "Floor" }, { name: "Ground Floor Ceiling", level: "Floor" }, { name: "Service", level: "Floor" }] },
    ],
  },
  {
    name: "133",
    level: "Site",
    children: [
      { name: "G-Floor", level: "Floor" },
      { name: "Outside Area", level: "Area" },
    ],
  },
  {
    name: "135",
    level: "Site",
    children: [
      { name: "1F", level: "Floor" },
      { name: "1F (Service)", level: "Floor" },
      { name: "1F (Sterile)", level: "Floor" },
      { name: "2F", level: "Floor" },
      { name: "GF", level: "Floor" },
      { name: "GF (Service)", level: "Floor" },
      { name: "Ground Floor Ceiling", level: "Floor" },
      { name: "Outside Area", level: "Area" },
      { name: "Warehouse", level: "Area" },
    ],
  },
  {
    name: "136 (Building)",
    level: "Site",
    children: [
      { name: "Beta", level: "Area", children: [{ name: "1F", level: "Floor" }, { name: "2F", level: "Floor" }, { name: "GF", level: "Floor" }, { name: "GF Sterile", level: "Floor" }] },
      { name: "Ophthalmic", level: "Area", children: [{ name: "2F", level: "Floor" }, { name: "First Floor", level: "Floor" }, { name: "GF", level: "Floor" }, { name: "GF Sterile", level: "Floor" }] },
      { name: "Outside Area", level: "Area" },
      { name: "QC", level: "Area", children: [{ name: "1F", level: "Floor" }, { name: "2F", level: "Floor" }] },
      { name: "Scrap Yard", level: "Area" },
      { name: "Waterfloor", level: "Area" },
    ],
  },
  {
    name: "1508",
    level: "Site",
    children: [
      { name: "1F", level: "Floor" },
      { name: "2F", level: "Floor" },
      { name: "GF", level: "Floor" },
      { name: "Outside Area", level: "Area" },
    ],
  },
  {
    name: "Canteen",
    level: "Site",
    children: [
      { name: "1F", level: "Floor" },
      { name: "2F", level: "Floor" },
      { name: "GF", level: "Floor" },
      { name: "Outside Area", level: "Area" },
    ],
  },
  { name: "Dangasia", level: "Site", children: [{ name: "Outside Area", level: "Area" }] },
  { name: "Marco", level: "Site", children: [{ name: "Outside Area", level: "Area" }] },
  {
    name: "Nutra",
    level: "Site",
    children: [
      { name: "1F (Service)", level: "Floor" },
      { name: "GF", level: "Floor" },
      { name: "Outside Area", level: "Area" },
    ],
  },
  {
    name: "Sci Prec",
    level: "Site",
    children: [
      { name: "12", level: "Floor" },
      { name: "5 & 6", level: "Floor" },
      { name: "7", level: "Floor" },
      { name: "Outside Area", level: "Area" },
    ],
  },
];

async function insertTree(locs, nodes, parentId) {
  let count = 0;
  for (const node of nodes) {
    const { insertedId } = await locs.insertOne({
      parent: parentId,
      name: node.name,
      level: node.level,
      code: "",
      capacity: "",
      status: "Active",
      refCount: 0,
    });
    count += 1;
    if (node.children) {
      count += await insertTree(locs, node.children, insertedId.toString());
    }
  }
  return count;
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  // Replace entirely: clear the three collections this real data covers.
  await db.collection("categories").deleteMany({});
  await db.collection("subcategories").deleteMany({});
  await db.collection("locations").deleteMany({});
  console.log("cleared categories, subcategories, locations");

  const categories = db.collection("categories");
  const locations = db.collection("locations");

  let order = 1;
  let subOrder = 0;
  let catInserted = 0;
  let subInserted = 0;
  for (const [name, icon, code, priority, subCount, named] of CATEGORY_DATA) {
    const fullName = `${icon} ${name}`;
    const result = await categories.insertOne({
      name: fullName,
      code,
      desc: "",
      defaultUnit: "Pieces",
      parent: null,
      level: "Category",
      order: order++,
      priority,
      color: PALETTE[(order - 1) % PALETTE.length],
      status: "Active",
      refCount: 0,
    });
    catInserted += 1;
    const parentId = result.insertedId.toString();

    subOrder = 0;
    for (const subName of named) {
      await categories.insertOne({
        name: subName,
        parent: parentId,
        code: "",
        desc: "",
        level: "Subcategory",
        defaultUnit: "Pieces",
        color: PALETTE[(order - 1) % PALETTE.length],
        order: ++subOrder,
        status: "Active",
        refCount: 0,
      });
      subInserted += 1;
    }
  }
  console.log(`seeded category tree: ${catInserted} roots + ${subInserted} nested (${CATEGORY_DATA.reduce((a, c) => a + c[4], 0)} real subcategory total)`);

  const locCount = await insertTree(locations, LOCATION_TREE, null);
  console.log(`seeded locations: ${locCount} docs`);

  await client.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
