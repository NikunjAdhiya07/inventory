// Seed a deep Pipe category tree under Plumbing.
// Replaces any existing Pipe subtree under Plumbing, then inserts the full tree.
//
//   npm run seed:pipe-categories
//   node scripts/seed-pipe-categories.mjs

import { MongoClient, ObjectId } from "mongodb";
import { config } from "dotenv";
import { promises as dns } from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

config({ path: ".env.local", quiet: true });

const dbName = process.env.MONGODB_DB || "inventory";
const srvUri = process.env.MONGODB_URI;

if (!srvUri) {
  console.error("MONGODB_URI is not set.");
  process.exit(1);
}

// Hosts discovered from a working system DNS lookup — used when Node's
// querySrv is blocked (common on some Windows resolvers).
const ATLAS_FALLBACK_HOSTS = [
  "ac-twswwxb-shard-00-00.ydtuwzz.mongodb.net:27017",
  "ac-twswwxb-shard-00-01.ydtuwzz.mongodb.net:27017",
  "ac-twswwxb-shard-00-02.ydtuwzz.mongodb.net:27017",
];

async function resolveHostsViaPowershell(host) {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Resolve-DnsName _mongodb._tcp.${host} -Type SRV -ErrorAction Stop | ForEach-Object { \"$($_.NameTarget):$($_.Port)\" }) -join ','`,
      ],
      { windowsHide: true, timeout: 15000 }
    );
    const hosts = String(stdout)
      .trim()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return hosts.length ? hosts : null;
  } catch {
    return null;
  }
}

async function connectUri() {
  try {
    const client = new MongoClient(srvUri, { serverSelectionTimeoutMS: 6000 });
    await client.connect();
    return { client, via: "srv" };
  } catch (err) {
    console.warn(`SRV connect failed (${err.code || err.message}). Trying direct hosts…`);
  }

  const m = String(srvUri).match(/^mongodb\+srv:\/\/([^@]+)@([^/?]+)/i);
  if (!m) throw new Error("Cannot parse MONGODB_URI for direct fallback.");
  const auth = m[1];
  const host = m[2];

  let hosts = null;
  try {
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
    const records = await dns.resolveSrv(`_mongodb._tcp.${host}`);
    hosts = records.map((r) => `${r.name}:${r.port}`);
  } catch {
    hosts = await resolveHostsViaPowershell(host);
  }
  if (!hosts?.length) hosts = ATLAS_FALLBACK_HOSTS;

  const direct = `mongodb://${auth}@${hosts.join(",")}?tls=true&authSource=admin&retryWrites=true&w=majority`;
  console.log(`Direct hosts: ${hosts.join(", ")}`);
  const client = new MongoClient(direct, { serverSelectionTimeoutMS: 25000 });
  await client.connect();
  return { client, via: "direct" };
}

// Complete plumbing-pipe taxonomy. Depth goes material → form/type → grade/class → size.
const PIPE_TREE = {
  name: "Pipe",
  code: "PIPE",
  level: "Category",
  desc: "All pipe types under Plumbing",
  children: [
    {
      name: "MS",
      code: "MS",
      level: "Material",
      desc: "Mild Steel pipe",
      children: [
        {
          name: "Round",
          level: "Form",
          children: [
            {
              name: "Light",
              level: "Class",
              children: sizes(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm", "50 mm"]),
            },
            {
              name: "Medium",
              level: "Class",
              children: sizes(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "65 mm", "80 mm", "100 mm"]),
            },
            {
              name: "Heavy",
              level: "Class",
              children: sizes(["25 mm", "32 mm", "40 mm", "50 mm", "65 mm", "80 mm", "100 mm", "150 mm"]),
            },
          ],
        },
        {
          name: "Square",
          level: "Form",
          children: [
            {
              name: "Hollow Section",
              level: "Type",
              children: sizes(["20×20 mm", "25×25 mm", "40×40 mm", "50×50 mm", "75×75 mm", "100×100 mm"]),
            },
          ],
        },
        {
          name: "Rectangular",
          level: "Form",
          children: [
            {
              name: "Hollow Section",
              level: "Type",
              children: sizes(["40×20 mm", "50×25 mm", "75×40 mm", "100×50 mm"]),
            },
          ],
        },
        {
          name: "ERW",
          level: "Type",
          children: [
            {
              name: "Black",
              level: "Finish",
              children: sizes(["15 mm", "20 mm", "25 mm", "40 mm", "50 mm", "80 mm", "100 mm"]),
            },
            {
              name: "Galvanised",
              level: "Finish",
              children: sizes(["15 mm", "20 mm", "25 mm", "40 mm", "50 mm", "80 mm"]),
            },
          ],
        },
      ],
    },
    {
      name: "GI",
      code: "GI",
      level: "Material",
      desc: "Galvanised Iron pipe",
      children: [
        {
          name: "Round",
          level: "Form",
          children: [
            {
              name: "Light (A-Class)",
              level: "Class",
              children: sizes(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm", "50 mm"]),
            },
            {
              name: "Medium (B-Class)",
              level: "Class",
              children: sizes(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "65 mm", "80 mm", "100 mm"]),
            },
            {
              name: "Heavy (C-Class)",
              level: "Class",
              children: sizes(["20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "65 mm", "80 mm", "100 mm", "150 mm"]),
            },
          ],
        },
      ],
    },
    {
      name: "PVC",
      code: "PVC",
      level: "Material",
      desc: "Polyvinyl chloride pipe",
      children: [
        {
          name: "Plumbing",
          level: "Type",
          children: [
            {
              name: "Schedule 40",
              level: "Class",
              children: sizes(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "65 mm", "80 mm", "100 mm", "150 mm"]),
            },
            {
              name: "Schedule 80",
              level: "Class",
              children: sizes(["20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "80 mm", "100 mm"]),
            },
          ],
        },
        {
          name: "SWR",
          level: "Type",
          desc: "Soil, Waste & Rain water",
          children: [
            {
              name: "Type A",
              level: "Class",
              children: sizes(["75 mm", "90 mm", "110 mm", "160 mm"]),
            },
            {
              name: "Type B",
              level: "Class",
              children: sizes(["75 mm", "90 mm", "110 mm", "160 mm", "200 mm"]),
            },
          ],
        },
        {
          name: "Conduit",
          level: "Type",
          children: [
            {
              name: "Rigid",
              level: "Class",
              children: sizes(["20 mm", "25 mm", "32 mm", "40 mm", "50 mm"]),
            },
            {
              name: "Flexible",
              level: "Class",
              children: sizes(["20 mm", "25 mm", "32 mm"]),
            },
          ],
        },
        {
          name: "Agricultural",
          level: "Type",
          children: [
            {
              name: "Casing",
              level: "Class",
              children: sizes(["100 mm", "150 mm", "200 mm", "250 mm"]),
            },
            {
              name: "Column",
              level: "Class",
              children: sizes(["80 mm", "100 mm", "125 mm", "150 mm"]),
            },
          ],
        },
      ],
    },
    {
      name: "CPVC",
      code: "CPVC",
      level: "Material",
      desc: "Chlorinated PVC — hot & cold water",
      children: [
        {
          name: "SDR 11",
          level: "Class",
          children: sizes(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm", "50 mm"]),
        },
        {
          name: "SDR 13.5",
          level: "Class",
          children: sizes(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "65 mm", "80 mm"]),
        },
        {
          name: "Sch 40",
          level: "Class",
          children: sizes(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm", "50 mm"]),
        },
      ],
    },
    {
      name: "UPVC",
      code: "UPVC",
      level: "Material",
      desc: "Unplasticised PVC pressure pipe",
      children: [
        {
          name: "PN 6",
          level: "Pressure",
          children: sizes(["20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "63 mm", "75 mm", "90 mm", "110 mm"]),
        },
        {
          name: "PN 10",
          level: "Pressure",
          children: sizes(["20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "63 mm", "75 mm", "90 mm", "110 mm"]),
        },
        {
          name: "PN 16",
          level: "Pressure",
          children: sizes(["20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "63 mm", "75 mm", "90 mm"]),
        },
      ],
    },
    {
      name: "PPR",
      code: "PPR",
      level: "Material",
      desc: "Polypropylene Random copolymer",
      children: [
        {
          name: "PN 10",
          level: "Pressure",
          children: sizes(["20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "63 mm"]),
        },
        {
          name: "PN 16",
          level: "Pressure",
          children: sizes(["20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "63 mm", "75 mm"]),
        },
        {
          name: "PN 20",
          level: "Pressure",
          children: sizes(["20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "63 mm"]),
        },
      ],
    },
    {
      name: "HDPE",
      code: "HDPE",
      level: "Material",
      desc: "High-density polyethylene",
      children: [
        {
          name: "PE 63",
          level: "Grade",
          children: [
            { name: "PN 6", level: "Pressure", children: sizes(["20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "63 mm", "75 mm", "90 mm", "110 mm"]) },
          ],
        },
        {
          name: "PE 80",
          level: "Grade",
          children: [
            { name: "PN 6", level: "Pressure", children: sizes(["20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "63 mm", "90 mm", "110 mm", "160 mm"]) },
            { name: "PN 10", level: "Pressure", children: sizes(["20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "63 mm", "90 mm", "110 mm"]) },
          ],
        },
        {
          name: "PE 100",
          level: "Grade",
          children: [
            { name: "PN 6", level: "Pressure", children: sizes(["32 mm", "40 mm", "50 mm", "63 mm", "75 mm", "90 mm", "110 mm", "160 mm", "200 mm"]) },
            { name: "PN 10", level: "Pressure", children: sizes(["32 mm", "40 mm", "50 mm", "63 mm", "75 mm", "90 mm", "110 mm", "160 mm"]) },
            { name: "PN 12.5", level: "Pressure", children: sizes(["32 mm", "40 mm", "50 mm", "63 mm", "75 mm", "90 mm", "110 mm"]) },
            { name: "PN 16", level: "Pressure", children: sizes(["32 mm", "40 mm", "50 mm", "63 mm", "75 mm", "90 mm", "110 mm"]) },
          ],
        },
      ],
    },
    {
      name: "Stainless Steel",
      code: "SS",
      level: "Material",
      children: [
        {
          name: "SS 304",
          level: "Grade",
          children: [
            { name: "Round Seamless", level: "Type", children: sizes(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "65 mm", "80 mm"]) },
            { name: "Round Welded", level: "Type", children: sizes(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "80 mm"]) },
          ],
        },
        {
          name: "SS 316",
          level: "Grade",
          children: [
            { name: "Round Seamless", level: "Type", children: sizes(["15 mm", "20 mm", "25 mm", "32 mm", "40 mm", "50 mm", "80 mm"]) },
            { name: "Round Welded", level: "Type", children: sizes(["15 mm", "20 mm", "25 mm", "40 mm", "50 mm"]) },
          ],
        },
      ],
    },
    {
      name: "Copper",
      code: "CU",
      level: "Material",
      children: [
        {
          name: "Type L",
          level: "Class",
          children: sizes(["15 mm", "22 mm", "28 mm", "35 mm", "42 mm", "54 mm"]),
        },
        {
          name: "Type M",
          level: "Class",
          children: sizes(["15 mm", "22 mm", "28 mm", "35 mm", "42 mm"]),
        },
        {
          name: "Type K",
          level: "Class",
          children: sizes(["15 mm", "22 mm", "28 mm", "35 mm"]),
        },
      ],
    },
    {
      name: "Cast Iron",
      code: "CI",
      level: "Material",
      children: [
        {
          name: "Soil Pipe",
          level: "Type",
          children: sizes(["50 mm", "75 mm", "100 mm", "150 mm"]),
        },
        {
          name: "Spun Pipe",
          level: "Type",
          children: sizes(["80 mm", "100 mm", "150 mm", "200 mm", "250 mm", "300 mm"]),
        },
      ],
    },
    {
      name: "Concrete",
      code: "RCC",
      level: "Material",
      children: [
        {
          name: "NP2",
          level: "Class",
          children: sizes(["150 mm", "200 mm", "300 mm", "450 mm", "600 mm"]),
        },
        {
          name: "NP3",
          level: "Class",
          children: sizes(["300 mm", "450 mm", "600 mm", "900 mm"]),
        },
        {
          name: "NP4",
          level: "Class",
          children: sizes(["300 mm", "450 mm", "600 mm", "900 mm", "1200 mm"]),
        },
      ],
    },
  ],
};

function sizes(list) {
  return list.map((name) => ({ name, level: "Size", children: [] }));
}

function flattenTree(node, parentId, color, defaultUnit, order, out) {
  const id = new ObjectId();
  out.push({
    _id: id,
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
  (node.children || []).forEach((child, i) => {
    flattenTree(child, id.toString(), color, defaultUnit, i + 1, out);
  });
  return out;
}

async function subtreeIds(col, rootId) {
  const all = await col.find({}, { projection: { parent: 1 } }).toArray();
  const childrenOf = new Map();
  for (const c of all) {
    const p = c.parent == null || c.parent === "" ? null : String(c.parent);
    if (!p) continue;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(c._id.toString());
  }
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    for (const child of childrenOf.get(queue.pop()) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

async function findPlumbing(col) {
  // Prefer exact / emoji-prefixed roots from real seed data.
  const roots = await col
    .find({ $or: [{ parent: null }, { parent: { $exists: false } }, { parent: "" }] })
    .toArray();
  const exact = roots.find((r) => String(r.name) === "Plumbing");
  if (exact) return exact;
  const soft = roots.find((r) => /plumbing/i.test(String(r.name)));
  if (soft) return soft;

  const result = await col.insertOne({
    parent: null,
    name: "Plumbing",
    code: "PLM",
    desc: "Pipes, fittings and valves",
    level: "Category",
    defaultUnit: "Meter",
    color: "#3392ff",
    order: (await col.countDocuments({ parent: null })) + 1,
    status: "Active",
    refCount: 0,
  });
  console.log("Created missing Plumbing root");
  return await col.findOne({ _id: result.insertedId });
}

async function main() {
  const { client, via } = await connectUri();
  console.log(`Connected via ${via} → db ${dbName}`);
  const db = client.db(dbName);
  const col = db.collection("categories");

  const plumbing = await findPlumbing(col);
  const plumbingId = plumbing._id.toString();
  console.log(`Plumbing root: "${plumbing.name}" (${plumbingId})`);

  // Replace any partial Pipe subtree from a previous interrupted run.
  const existingPipe = await col.findOne({ parent: plumbingId, name: "Pipe" });
  if (existingPipe) {
    const ids = await subtreeIds(col, existingPipe._id.toString());
    const oidList = [...ids].map((id) => new ObjectId(id));
    const del = await col.deleteMany({ _id: { $in: oidList } });
    console.log(`Cleared previous Pipe subtree: ${del.deletedCount} nodes`);
  }

  const siblings = await col.countDocuments({ parent: plumbingId });
  const docs = [];
  flattenTree(
    PIPE_TREE,
    plumbingId,
    plumbing.color || "#3392ff",
    plumbing.defaultUnit || "Meter",
    siblings + 1,
    docs
  );

  // insertMany in chunks to keep payload modest.
  const CHUNK = 200;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const slice = docs.slice(i, i + CHUNK);
    await col.insertMany(slice, { ordered: true });
    console.log(`Inserted ${Math.min(i + CHUNK, docs.length)} / ${docs.length}`);
  }

  let maxDepth = 0;
  const walkDepth = (node, depth) => {
    if (depth > maxDepth) maxDepth = depth;
    for (const c of node.children || []) walkDepth(c, depth + 1);
  };
  walkDepth(PIPE_TREE, 1);

  console.log(`Done. Pipe subtree: ${docs.length} nodes, max depth ${maxDepth}`);
  console.log(`Path example: Plumbing › Pipe › PVC › Plumbing › Schedule 40 › 25 mm`);
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
