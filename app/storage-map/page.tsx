"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import {
  PageIntro,
  Modal,
  ModalHeader,
  ModalFooter,
  labelStyle,
  inputStyle,
  secondaryBtnStyle,
  primaryBtnStyle,
  addBtnStyle,
  EmptyState,
  ErrorBanner,
  SearchInput,
} from "@/components/dc-ui";

// The warehouse as it physically stands, rather than as an indented list.
//
// Same nodes as /locations — a section, its racks, their shelves and the boxes
// on those shelves are all rows in `locations`. What changes is the read: a rack
// is drawn as its shelves, each shelf carrying box tiles that show what the
// stock ledger says is inside them, so "which box is the 2-core wire in" is
// answered by looking rather than by searching.
//
// Everything here is meant to be rearranged. A room gets re-shelved, boxes get
// relabelled, and goods get carried from one rack to another — so renaming a
// node, nudging it up or down, moving it under a different parent, and moving
// the STOCK to a different box are all one or two clicks from the tile itself.
// Note the last one is a different operation from the three before it: moving a
// box carries its contents with it, moving stock leaves the boxes alone.

type BoxItem = { productId: string; name: string; productNumber: string; qty: number; unit: string };

type MapNode = {
  id: string;
  name: string;
  code: string;
  level: string;
  capacity: number | null;
  items: BoxItem[];
  qty: number;
  totalQty: number;
  children: MapNode[];
};

type MapResponse = {
  roots: { id: string; name: string }[];
  rootId: string | null;
  root?: { id: string; name: string };
  sections: MapNode[];
};

type Product = { id: string; name: string; productNumber: string; unit: string };

type BulkTarget = { parentId: string; parentName: string; level: string };

type OpenBox = { node: MapNode; path: string; parentId: string };

type EditTarget = { node: MapNode; parentId: string };

type BulkForm = {
  level: string;
  mode: "number" | "letter";
  prefix: string;
  from: string;
  to: string;
  pad: string;
  codePrefix: string;
  capacity: string;
  names: string;
};

type EditForm = { name: string; level: string; code: string; capacity: string; parent: string };

// A node that holds boxes rather than being one. Racks are lettered, shelves and
// boxes are numbered — that is how shelving is labelled almost everywhere, so
// the form opens already correct for whichever level the button was on.
function bulkDefaults(level: string): BulkForm {
  const lettered = level.toLowerCase() === "rack";
  const box = level.toLowerCase() === "box";
  return {
    level,
    mode: lettered ? "letter" : "number",
    prefix: `${level} `,
    from: lettered ? "A" : "1",
    to: lettered ? "F" : box ? "12" : "6",
    pad: box ? "2" : "0",
    codePrefix: "",
    capacity: "",
    names: "",
  };
}

function mapUrl(root?: string | null): string {
  return `/api/storage-map${root ? `?root=${encodeURIComponent(root)}` : ""}`;
}

// Locate a node anywhere in the tree. Used to re-point an open modal at the
// freshly loaded map after an edit, so it shows the new state without being
// closed and reopened.
function findNode(nodes: MapNode[], id: string): MapNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

// The ids from the top of the site down to `id`, so the entry form's Rack /
// Shelf / Box selects can open already pointed at whatever was clicked.
function chainTo(nodes: MapNode[], id: string, trail: string[] = []): string[] | null {
  for (const n of nodes) {
    const next = [...trail, n.id];
    if (n.id === id) return next;
    const hit = chainTo(n.children, id, next);
    if (hit) return hit;
  }
  return null;
}

type FlatNode = { id: string; path: string; level: string; depth: number };

// Every node in the site with its full path — the option list for both "move
// this box to…" and "move this stock to…".
function flatten(sections: MapNode[], rootName: string): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (n: MapNode, trail: string, depth: number) => {
    const path = trail ? `${trail} › ${n.name}` : n.name;
    out.push({ id: n.id, path, level: n.level, depth });
    n.children.forEach((c) => walk(c, path, depth + 1));
  };
  sections.forEach((s) => walk(s, rootName, 0));
  return out;
}

function subtreeIds(node: MapNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: MapNode) => {
    ids.add(n.id);
    n.children.forEach(walk);
  };
  walk(node);
  return ids;
}

export default function StorageMapPage() {
  const [data, setData] = useState<MapResponse | null>(null);
  const [rootId, setRootId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  const [openBox, setOpenBox] = useState<OpenBox | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [pickQuery, setPickQuery] = useState("");
  const [pickId, setPickId] = useState("");
  const [pickQty, setPickQty] = useState("");
  const [settingQty, setSettingQty] = useState(false);
  const [contentError, setContentError] = useState("");
  // Where the count being typed will land — section, rack, shelf, box — as ids
  // from the top down. Seeded from the node that was opened, so the common case
  // is "the box in front of me" with nothing to pick.
  const [destChain, setDestChain] = useState<string[]>([]);

  const [moveItem, setMoveItem] = useState<BoxItem | null>(null);
  const [moveDest, setMoveDest] = useState("");
  const [moveQty, setMoveQty] = useState("");
  const [movingStock, setMovingStock] = useState(false);

  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ name: "", level: "", code: "", capacity: "", parent: "" });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

  const [bulk, setBulk] = useState<BulkTarget | null>(null);
  const [form, setForm] = useState<BulkForm>(bulkDefaults("Box"));
  const [saving, setSaving] = useState(false);
  const [bulkError, setBulkError] = useState("");

  // Refetch after an edit or a site change. The mount fetch below is written out
  // separately rather than calling this, so nothing sets state synchronously
  // inside the effect.
  const reload = useCallback(async (root?: string | null): Promise<MapResponse | null> => {
    setLoading(true);
    try {
      const res = await api.get<MapResponse>(mapUrl(root));
      setData(res);
      setRootId(res.rootId);
      setError("");
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<MapResponse>(mapUrl())
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setRootId(res.rootId);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sections = useMemo(() => data?.sections || [], [data]);
  const rootName = data?.root?.name || "";
  const flat = useMemo(() => flatten(sections, rootName), [sections, rootName]);

  // Filtering hides boxes whose contents don't match, then the shelves, racks
  // and sections left with nothing — so a search for "wire" leaves exactly the
  // shelves worth walking to, not every rack with one empty result inside it.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    const matches = (n: MapNode): boolean =>
      n.name.toLowerCase().includes(q) ||
      n.code.toLowerCase().includes(q) ||
      n.items.some((i) => i.name.toLowerCase().includes(q) || i.productNumber.toLowerCase().includes(q));
    const prune = (n: MapNode): MapNode | null => {
      const kids = n.children.map(prune).filter((c): c is MapNode => c !== null);
      if (!kids.length && !matches(n)) return null;
      return { ...n, children: kids };
    };
    return sections.map(prune).filter((s): s is MapNode => s !== null);
  }, [sections, query]);

  // One select per level of the tree, each listing the children of the one
  // before it. Labels come from the data (`level`), so a site that calls its
  // sections "Area" says Area rather than a hardcoded word. A chain entry that
  // no longer resolves — the shelf was deleted in another tab — simply stops the
  // walk there, leaving the selects below it empty rather than pointing at a
  // node that is gone.
  const destSteps = useMemo(() => {
    const steps: { label: string; value: string; options: MapNode[] }[] = [];
    let options = sections;
    let depth = 0;
    while (options.length && depth < 8) {
      const wanted = destChain[depth] || "";
      const value = options.some((o) => o.id === wanted) ? wanted : "";
      steps.push({ label: levelLabel(options, depth), value, options });
      if (!value) break;
      options = options.find((o) => o.id === value)!.children;
      depth++;
    }
    return steps;
  }, [sections, destChain]);

  // The deepest level actually picked — a rack with no shelf chosen means the
  // rack itself, which is a real place to hold stock.
  const destId = useMemo(() => {
    const picked = destSteps.filter((s) => s.value);
    return picked.length ? picked[picked.length - 1].value : "";
  }, [destSteps]);

  const destPath = useMemo(() => {
    const names = destSteps.filter((s) => s.value).map((s) => s.options.find((o) => o.id === s.value)!.name);
    return [rootName, ...names].filter(Boolean).join(" › ");
  }, [destSteps, rootName]);

  const destNode = useMemo(() => (destId ? findNode(sections, destId) : null), [sections, destId]);

  // Picking a level clears everything below it — a shelf number means nothing
  // once the rack above it changed. The count goes too: "12 on the shelf" was
  // true of the old destination, not the new one.
  function chooseDest(step: number, id: string) {
    setDestChain((prev) => (id ? [...prev.slice(0, step), id] : prev.slice(0, step)));
    setPickQty("");
  }

  // Siblings straight from the loaded tree, so a nudge reorders against what is
  // actually stored rather than against the filtered view on screen.
  const siblingsOf = useCallback(
    (parentId: string): MapNode[] => (parentId === rootId ? sections : findNode(sections, parentId)?.children || []),
    [sections, rootId]
  );

  // Move a node one place along inside its parent. Sends the whole sibling order
  // rather than a single index, because the server stores position per node and
  // a partial update would leave two nodes claiming the same slot.
  async function nudge(parentId: string, id: string, delta: number) {
    const ids = siblingsOf(parentId).map((s) => s.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try {
      await api.post("/api/locations/reorder", { parent: parentId, ids });
      await reload(rootId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function openBulk(parentId: string, parentName: string, level: string) {
    setBulk({ parentId, parentName, level });
    setForm(bulkDefaults(level));
    setBulkError("");
  }

  function openEdit(node: MapNode, parentId: string) {
    setEdit({ node, parentId });
    setEditForm({
      name: node.name,
      level: node.level,
      code: node.code,
      capacity: node.capacity == null ? "" : String(node.capacity),
      parent: parentId,
    });
    setEditError("");
  }

  async function saveEdit() {
    if (!edit) return;
    if (!editForm.name.trim()) {
      setEditError("Name can't be empty.");
      return;
    }
    setEditSaving(true);
    setEditError("");
    try {
      await api.patch(`/api/locations/${edit.node.id}`, {
        name: editForm.name.trim(),
        level: editForm.level.trim(),
        code: editForm.code.trim(),
        capacity: editForm.capacity === "" ? "" : Number(editForm.capacity),
      });
      // A changed parent goes through the reorder route, which is the only path
      // that checks the destination isn't inside the node being moved. Appended
      // last so it lands at the bottom of its new shelf rather than displacing
      // whatever is already there.
      if (editForm.parent !== edit.parentId) {
        const ids = siblingsOf(editForm.parent).map((s) => s.id).filter((id) => id !== edit.node.id);
        await api.post("/api/locations/reorder", { parent: editForm.parent, ids: [...ids, edit.node.id] });
      }
      setEdit(null);
      const res = await reload(rootId);
      // If this node is also the box on screen behind the editor, refresh it.
      if (openBox && res && openBox.node.id === edit.node.id) {
        const fresh = findNode(res.sections, edit.node.id);
        if (fresh) setOpenBox({ ...openBox, node: fresh, parentId: editForm.parent });
      }
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditSaving(false);
    }
  }

  async function saveBulk() {
    if (!bulk) return;
    setSaving(true);
    setBulkError("");
    try {
      await api.post("/api/locations/bulk", {
        parent: bulk.parentId,
        level: form.level.trim(),
        mode: form.mode,
        prefix: form.prefix,
        from: form.from,
        to: form.to,
        pad: Number(form.pad) || 0,
        codePrefix: form.codePrefix.trim(),
        capacity: form.capacity === "" ? "" : Number(form.capacity),
        names: form.names.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
      });
      setBulk(null);
      await reload(rootId);
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  // Product Master is only needed once a box is actually opened, so it is
  // fetched then rather than on every page load.
  function openBoxDetail(node: MapNode, path: string, parentId: string) {
    setOpenBox({ node, path, parentId });
    setPickQuery("");
    setPickId("");
    setPickQty("");
    setContentError("");
    setMoveItem(null);
    setDestChain(chainTo(sections, node.id) || []);
    if (!products) {
      api
        .get<Product[]>("/api/products")
        .then((rows) => setProducts(rows.map((r) => ({ id: r.id, name: r.name, productNumber: r.productNumber, unit: r.unit }))))
        .catch((err: unknown) => setContentError(err instanceof Error ? err.message : String(err)));
    }
  }

  // Re-point the open box at the reloaded tree so its contents update in place.
  async function refreshOpenBox() {
    if (!openBox) return;
    const res = await reload(rootId);
    const fresh = res ? findNode(res.sections, openBox.node.id) : null;
    if (fresh) setOpenBox({ ...openBox, node: fresh });
  }

  async function setContents() {
    if (!openBox || !destId) return;
    setSettingQty(true);
    setContentError("");
    try {
      await api.post("/api/stock/adjust", { locationId: destId, productId: pickId, qty: Number(pickQty) });
      await refreshOpenBox();
      setPickId("");
      setPickQty("");
      setPickQuery("");
    } catch (err) {
      setContentError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingQty(false);
    }
  }

  async function moveStock() {
    if (!openBox || !moveItem) return;
    setMovingStock(true);
    setContentError("");
    try {
      await api.post("/api/stock/transfer", {
        productId: moveItem.productId,
        fromLocationId: openBox.node.id,
        toLocationId: moveDest,
        qty: Number(moveQty),
      });
      setMoveItem(null);
      await refreshOpenBox();
    } catch (err) {
      setContentError(err instanceof Error ? err.message : String(err));
    } finally {
      setMovingStock(false);
    }
  }

  // Short enough to render as a list of buttons rather than a scroll box — the
  // count is kept so a too-broad search says so instead of silently truncating.
  const pickMatches = useMemo(() => {
    if (!products) return { rows: [] as Product[], total: 0 };
    const q = pickQuery.trim().toLowerCase();
    const rows = q
      ? products.filter((p) => p.name.toLowerCase().includes(q) || p.productNumber.toLowerCase().includes(q))
      : products;
    return { rows: rows.slice(0, 8), total: rows.length };
  }, [products, pickQuery]);

  // The item being logged. A product deactivated after its stock landed here is
  // still in the box, so fall back to what the ledger reported for the tile.
  const picked = useMemo(() => {
    if (!pickId) return null;
    const p = products?.find((x) => x.id === pickId);
    const held = openBox?.node.items.find((i) => i.productId === pickId);
    return {
      name: p?.name || held?.name || pickQuery,
      productNumber: p?.productNumber || held?.productNumber || "",
      unit: p?.unit || held?.unit || "",
    };
  }, [pickId, products, openBox, pickQuery]);

  const heldAtDest = destNode?.items.find((i) => i.productId === pickId)?.qty ?? 0;

  function correctItem(item: BoxItem) {
    setPickId(item.productId);
    setPickQuery(item.name);
    setPickQty(String(item.qty));
    setMoveItem(null);
    // A correction is about THIS node, so pull the destination back to it in
    // case the form was pointed somewhere else.
    if (openBox) setDestChain(chainTo(sections, openBox.node.id) || []);
  }

  // Somewhere a node may be moved to: anywhere in the site except itself and
  // its own descendants, which would detach the branch.
  const editDestinations = useMemo(() => {
    if (!edit) return [];
    const banned = subtreeIds(edit.node);
    return flat.filter((f) => !banned.has(f.id));
  }, [edit, flat]);

  const counts = useMemo(() => {
    let racks = 0;
    let shelves = 0;
    let boxes = 0;
    for (const section of sections) {
      for (const rack of section.children) {
        racks++;
        for (const child of rack.children) {
          if (child.children.length || child.level.toLowerCase() !== "box") {
            shelves++;
            boxes += child.children.length;
          } else {
            boxes++;
          }
        }
      }
    }
    return { racks, shelves, boxes };
  }, [sections]);

  return (
    <PageShell section="Master Data" page="Storage Map" maxWidth={1480}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 20 }}>
        <PageIntro
          title="Storage Map"
          description="Sections → racks → shelves → boxes, drawn as they stand. Rename or re-position anything with ✎ ↑ ↓; open a box to set or move what is inside it."
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <SearchInput value={query} onChange={setQuery} placeholder="Find a product or box…" width={250} />
          <select
            value={rootId || ""}
            onChange={(e) => {
              setRootId(e.target.value);
              reload(e.target.value);
            }}
            style={{ ...inputStyle, width: "auto", padding: "9px 12px", background: "#fff" }}
          >
            {(data?.roots || []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button onClick={() => rootId && openBulk(rootId, rootName || "site", "Section")} style={addBtnStyle}>
            ＋ Sections
          </button>
        </div>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      <div style={{ display: "flex", gap: 22, marginBottom: 18, fontSize: 12.5, color: "#67748e" }}>
        <span>
          <strong style={{ color: "#0b1b45" }}>{sections.length}</strong> sections
        </span>
        <span>
          <strong style={{ color: "#0b1b45" }}>{counts.racks}</strong> racks
        </span>
        <span>
          <strong style={{ color: "#0b1b45" }}>{counts.shelves}</strong> shelves
        </span>
        <span>
          <strong style={{ color: "#0b1b45" }}>{counts.boxes}</strong> boxes
        </span>
      </div>

      {loading ? (
        <section style={cardStyle}>
          <EmptyState text="Loading…" />
        </section>
      ) : null}

      {!loading && !sections.length ? (
        <section style={cardStyle}>
          <EmptyState text="No sections under this site yet. Use ＋ Sections to lay the room out." />
        </section>
      ) : null}

      {!loading && sections.length > 0 && !filtered.length ? (
        <section style={cardStyle}>
          <EmptyState text={`Nothing matching “${query}” is stored here.`} />
        </section>
      ) : null}

      {filtered.map((section, si) => (
        <section key={section.id} style={{ ...cardStyle, marginBottom: 18 }}>
          <div
            style={{
              padding: "13px 18px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              borderBottom: "1px solid #f1f4f8",
              background: "#fafbfd",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 14.5, fontWeight: 800, color: "#0b1b45" }}>{section.name}</span>
              <span style={levelChip}>{section.level || "Section"}</span>
              <span style={{ fontSize: 12, color: "#8a97b0" }}>
                {section.children.length} racks · {section.totalQty} units on hand
              </span>
              <NodeActions
                onEdit={() => openEdit(section, rootId || "")}
                onUp={si > 0 ? () => nudge(rootId || "", section.id, -1) : undefined}
                onDown={si < filtered.length - 1 ? () => nudge(rootId || "", section.id, 1) : undefined}
              />
            </div>
            <button onClick={() => openBulk(section.id, section.name, "Rack")} style={smallAddStyle}>
              ＋ Racks
            </button>
          </div>

          {/* Stock logged against the section itself, before racks existed to
              hold it. Every balance in Canteen is currently here, so leaving it
              out would draw a room that looks empty while holding hundreds of
              units. */}
          {section.items.length ? (
            <button onClick={() => openBoxDetail(section, rootName, rootId || "")} style={looseStockStyle}>
              <span style={{ fontSize: 12.5, color: "#8a6417" }}>
                <strong style={{ fontWeight: 700 }}>{section.qty} units not in any box</strong> — logged straight against{" "}
                {section.name}. Open it to move a count into a box.
              </span>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#8a6417", whiteSpace: "nowrap" }}>
                {section.items.length} products →
              </span>
            </button>
          ) : null}

          {!section.children.length ? (
            <EmptyState text="No racks in this section yet." />
          ) : (
            <div style={{ display: "flex", gap: 14, padding: 18, overflowX: "auto", alignItems: "flex-start" }}>
              {section.children.map((rack, ri) => (
                <Rack
                  key={rack.id}
                  rack={rack}
                  sectionId={section.id}
                  index={ri}
                  siblingCount={section.children.length}
                  onAddChildren={(parent, level) => openBulk(parent.id, parent.name, level)}
                  onOpenBox={(node, trail, parentId) => openBoxDetail(node, `${section.name} › ${trail}`, parentId)}
                  onEdit={openEdit}
                  onNudge={nudge}
                />
              ))}
            </div>
          )}
        </section>
      ))}

      {openBox ? (
        <Modal onClose={() => setOpenBox(null)} maxWidth={620}>
          <ModalHeader
            title={openBox.node.name}
            subtitle={`${openBox.path} · ${openBox.node.level || "Box"}${openBox.node.code ? ` · ${openBox.node.code}` : ""}`}
            onClose={() => setOpenBox(null)}
          />

          <div style={{ padding: "12px 24px", borderBottom: "1px solid #f4f7fb", display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={() => openEdit(openBox.node, openBox.parentId)} style={{ ...smallAddStyle, padding: "5px 10px", fontSize: 12 }}>
              ✎ Rename or move this {(openBox.node.level || "box").toLowerCase()}
            </button>
            <span style={{ fontSize: 11.5, color: "#9aa6bd" }}>Moving it carries everything inside with it.</span>
          </div>

          <div style={{ padding: "4px 0 0" }}>
            {!openBox.node.items.length ? (
              <EmptyState text="This box is empty — nothing is logged against it yet." />
            ) : (
              openBox.node.items.map((item) => (
                <div key={item.productId} style={{ borderBottom: "1px solid #f4f7fb" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 14,
                      padding: "11px 24px",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: "#1a2b4a" }}>{item.name}</div>
                      {item.productNumber ? (
                        <div style={{ fontSize: 11.5, color: "#8a97b0", fontFamily: "var(--font-mono)" }}>{item.productNumber}</div>
                      ) : null}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0b1b45", whiteSpace: "nowrap" }}>
                        {item.qty} <span style={{ fontWeight: 500, color: "#8a97b0" }}>{item.unit}</span>
                      </div>
                      <button onClick={() => correctItem(item)} style={{ ...ghostBtnStyle }}>
                        Correct
                      </button>
                      <button
                        onClick={() => {
                          setMoveItem(moveItem?.productId === item.productId ? null : item);
                          setMoveDest("");
                          setMoveQty(String(item.qty));
                        }}
                        style={{ ...smallAddStyle, padding: "4px 9px", fontSize: 11.5 }}
                      >
                        ⇄ Move
                      </button>
                    </div>
                  </div>

                  {moveItem?.productId === item.productId ? (
                    <div style={{ padding: "0 24px 14px", display: "grid", gridTemplateColumns: "1fr 90px auto", gap: 9, alignItems: "end" }}>
                      <div>
                        <label style={labelStyle}>Move to</label>
                        <select value={moveDest} onChange={(e) => setMoveDest(e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                          <option value="">— pick a destination —</option>
                          {flat
                            .filter((f) => f.id !== openBox.node.id)
                            .map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.path}
                              </option>
                            ))}
                        </select>
                      </div>
                      <div>
                        <label style={labelStyle}>Qty</label>
                        <input value={moveQty} onChange={(e) => setMoveQty(e.target.value)} type="number" min={1} max={item.qty} style={inputStyle} />
                      </div>
                      <button
                        onClick={moveStock}
                        disabled={movingStock || !moveDest || !moveQty}
                        style={{ ...primaryBtnStyle, opacity: movingStock || !moveDest || !moveQty ? 0.5 : 1 }}
                      >
                        {movingStock ? "Moving…" : "Move"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <div style={{ padding: "16px 24px 18px", background: "#fafbfd", borderTop: "1px solid #f1f4f8" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 11 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#0b1b45" }}>Log stock</div>
              <span style={{ fontSize: 11.5, color: "#9aa6bd" }}>Counts, not differences</span>
            </div>

            {contentError ? (
              <div style={{ background: "#fff4f4", border: "1px solid #f5c2c2", borderRadius: 9, padding: "9px 12px", fontSize: 12.5, color: "#a11b1b", marginBottom: 10 }}>
                {contentError}
              </div>
            ) : null}

            <FormBlock step={1} title="Where it goes">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(118px,1fr))", gap: 8 }}>
                {destSteps.map((step, i) => (
                  <div key={`${i}-${step.label}`}>
                    <label style={fieldLabelStyle}>{step.label}</label>
                    <select value={step.value} onChange={(e) => chooseDest(i, e.target.value)} style={fieldSelectStyle}>
                      <option value="">{i === 0 ? "— pick —" : "— none —"}</option>
                      {step.options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 9, fontSize: 11.5, color: destId ? "#4a5878" : "#aab4c8" }}>
                {destId ? (
                  <>
                    <span style={{ color: "#9aa6bd" }}>Lands in </span>
                    <strong style={{ fontWeight: 700, color: "#1a2b4a" }}>{destPath}</strong>
                  </>
                ) : (
                  "Nothing picked — choose at least the top level."
                )}
              </div>
              {destId && destId !== openBox.node.id ? (
                <div style={destWarnStyle}>
                  Not the {(openBox.node.level || "box").toLowerCase()} you opened — the count below is logged against{" "}
                  <strong>{destNode?.name || destPath}</strong>.
                </div>
              ) : null}
            </FormBlock>

            <FormBlock step={2} title="Item">
              {pickId ? (
                <div style={pickedRowStyle}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1a2b4a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {picked?.name}
                    </div>
                    <div style={{ fontSize: 11, color: "#8a97b0", marginTop: 2 }}>
                      {picked?.productNumber ? (
                        <span style={{ fontFamily: "var(--font-mono)" }}>{picked.productNumber}</span>
                      ) : (
                        "no SKU"
                      )}
                      {picked?.unit ? ` · measured in ${picked.unit}` : ""}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setPickId("");
                      setPickQuery("");
                    }}
                    style={ghostBtnStyle}
                  >
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <input
                    value={pickQuery}
                    onChange={(e) => setPickQuery(e.target.value)}
                    placeholder={products ? "Search the Item Master by name or SKU…" : "Loading items…"}
                    style={{ ...inputStyle, padding: "9px 12px", fontSize: 13, background: "#fff" }}
                  />
                  {pickQuery.trim() ? (
                    <div style={resultListStyle}>
                      {pickMatches.rows.length ? (
                        pickMatches.rows.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => {
                              setPickId(p.id);
                              setPickQuery(p.name);
                            }}
                            style={resultRowStyle}
                          >
                            <span style={{ fontSize: 12.5, fontWeight: 600, color: "#1a2b4a" }}>{p.name}</span>
                            <span style={{ fontSize: 11, color: "#8a97b0", whiteSpace: "nowrap" }}>
                              {p.productNumber ? `${p.productNumber} · ` : ""}
                              {p.unit || "—"}
                            </span>
                          </button>
                        ))
                      ) : (
                        <div style={{ padding: "10px 11px", fontSize: 12, color: "#aab4c8" }}>
                          No item matches “{pickQuery.trim()}”.
                        </div>
                      )}
                      {pickMatches.total > pickMatches.rows.length ? (
                        <div style={{ padding: "7px 11px", fontSize: 11, color: "#aab4c8", borderTop: "1px solid #f4f7fb" }}>
                          +{pickMatches.total - pickMatches.rows.length} more — keep typing to narrow it down.
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div style={{ marginTop: 7, fontSize: 11.5, color: "#aab4c8" }}>
                      Start typing to search {products ? `${products.length} items` : "the Item Master"}.
                    </div>
                  )}
                </>
              )}
            </FormBlock>

            <FormBlock step={3} title="Count">
              <div style={{ display: "grid", gridTemplateColumns: "minmax(88px,1fr) minmax(88px,1fr) auto", gap: 9, alignItems: "end" }}>
                <div>
                  <label style={fieldLabelStyle}>Quantity</label>
                  <input
                    value={pickQty}
                    onChange={(e) => setPickQty(e.target.value)}
                    type="number"
                    min={0}
                    placeholder="0"
                    style={{ ...inputStyle, padding: "9px 12px", fontSize: 13, background: "#fff" }}
                  />
                </div>
                <div>
                  <label style={fieldLabelStyle}>Unit</label>
                  <div style={readonlyFieldStyle} title="Taken from the item's record in the Item Master">
                    {picked?.unit || "—"}
                  </div>
                </div>
                <button
                  onClick={setContents}
                  disabled={settingQty || !pickId || !destId || pickQty === ""}
                  style={{
                    ...primaryBtnStyle,
                    padding: "9px 18px",
                    opacity: settingQty || !pickId || !destId || pickQty === "" ? 0.5 : 1,
                  }}
                >
                  {settingQty ? "Saving…" : "Set count"}
                </button>
              </div>
              <p style={{ margin: "9px 0 0", fontSize: 11.5, color: "#8a97b0", lineHeight: 1.5 }}>
                {pickId && destId ? (
                  <>
                    <strong style={{ color: "#4a5878" }}>
                      {heldAtDest} {picked?.unit || "units"}
                    </strong>{" "}
                    of {picked?.name} are recorded there now. Enter what is <strong>physically present</strong> — the difference is
                    worked out for you.
                  </>
                ) : (
                  <>
                    Enter the count that is <strong>physically on the shelf</strong>, not the difference. Use ⇄ Move to carry stock to
                    another box — that leaves the total untouched, while this changes it.
                  </>
                )}
              </p>
            </FormBlock>
          </div>

          <ModalFooter>
            <button onClick={() => setOpenBox(null)} style={secondaryBtnStyle}>
              Close
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {edit ? (
        <Modal onClose={() => setEdit(null)} maxWidth={520}>
          <ModalHeader title={`Edit ${edit.node.level || "node"}`} subtitle={edit.node.name} onClose={() => setEdit(null)} />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            {editError ? (
              <div style={{ background: "#fff4f4", border: "1px solid #f5c2c2", borderRadius: 10, padding: "10px 13px", fontSize: 12.5, color: "#a11b1b" }}>
                {editError}
              </div>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>
                  Name <span style={{ color: "#e0524f" }}>*</span>
                </label>
                <input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Code</label>
                <input
                  value={editForm.code}
                  onChange={(e) => setEditForm((f) => ({ ...f, code: e.target.value }))}
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>Level label</label>
                <input value={editForm.level} onChange={(e) => setEditForm((f) => ({ ...f, level: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Capacity</label>
                <input
                  value={editForm.capacity}
                  onChange={(e) => setEditForm((f) => ({ ...f, capacity: e.target.value }))}
                  type="number"
                  placeholder="—"
                  style={inputStyle}
                />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Sits under</label>
              <select value={editForm.parent} onChange={(e) => setEditForm((f) => ({ ...f, parent: e.target.value }))} style={{ ...inputStyle, background: "#fff" }}>
                <option value={rootId || ""}>{rootName} — top level</option>
                {editDestinations.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.path}
                  </option>
                ))}
              </select>
              <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "#8a97b0", lineHeight: 1.5 }}>
                Changing this carries the node and everything inside it. Its own shelves and boxes can&apos;t be offered here — a node
                can&apos;t sit inside itself.
              </p>
            </div>
          </div>
          <ModalFooter>
            <button onClick={() => setEdit(null)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={saveEdit} disabled={editSaving} style={{ ...primaryBtnStyle, opacity: editSaving ? 0.6 : 1 }}>
              {editSaving ? "Saving…" : "Save"}
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {bulk ? (
        <Modal onClose={() => setBulk(null)} maxWidth={560}>
          <ModalHeader title={`Add ${bulk.level}s`} subtitle={`Created under ${bulk.parentName}`} onClose={() => setBulk(null)} />
          <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            {bulkError ? (
              <div style={{ background: "#fff4f4", border: "1px solid #f5c2c2", borderRadius: 10, padding: "10px 13px", fontSize: 12.5, color: "#a11b1b" }}>
                {bulkError}
              </div>
            ) : null}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>Level label</label>
                <input value={form.level} onChange={(e) => setForm((f) => ({ ...f, level: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Name prefix</label>
                <input value={form.prefix} onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value }))} placeholder="Box " style={inputStyle} />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr 1fr .8fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>Numbering</label>
                <select
                  value={form.mode}
                  onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value as "number" | "letter" }))}
                  style={{ ...inputStyle, background: "#fff" }}
                >
                  <option value="number">1, 2, 3…</option>
                  <option value="letter">A, B, C…</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>From</label>
                <input value={form.from} onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>To</label>
                <input value={form.to} onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Pad</label>
                <input
                  value={form.pad}
                  onChange={(e) => setForm((f) => ({ ...f, pad: e.target.value }))}
                  type="number"
                  disabled={form.mode === "letter"}
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <label style={labelStyle}>Code prefix</label>
                <input
                  value={form.codePrefix}
                  onChange={(e) => setForm((f) => ({ ...f, codePrefix: e.target.value }))}
                  placeholder="CN-R1-"
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                />
              </div>
              <div>
                <label style={labelStyle}>Capacity each</label>
                <input
                  value={form.capacity}
                  onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
                  type="number"
                  placeholder="—"
                  style={inputStyle}
                />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Or paste exact names (one per line)</label>
              <textarea
                value={form.names}
                onChange={(e) => setForm((f) => ({ ...f, names: e.target.value }))}
                placeholder={"Wire Box\nSwitch Box\nMCB Box"}
                rows={4}
                style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
              />
              <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "#8a97b0" }}>
                Used instead of the range when filled — for shelving that is already labelled its own way.
              </p>
            </div>

            <div style={{ background: "#f8fafd", border: "1px solid #eef2f7", borderRadius: 10, padding: "12px 14px", fontSize: 12.5, color: "#67748e" }}>
              Preview: <strong style={{ color: "#1a2b4a" }}>{previewNames(form).join(", ") || "—"}</strong>
            </div>
          </div>
          <ModalFooter>
            <button onClick={() => setBulk(null)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={saveBulk} disabled={saving} style={{ ...primaryBtnStyle, opacity: saving ? 0.6 : 1 }}>
              {saving ? "Creating…" : `Create ${bulk.level}s`}
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

// What to call one tier of the destination picker. `level` is free text a person
// typed, so siblings disagree — one of six shelves is currently labelled
// "CALCULATOR" in Canteen. The majority wins rather than whichever happens to be
// first, so a single mislabelled node can't rename the whole column.
function levelLabel(options: MapNode[], depth: number): string {
  const tally = new Map<string, number>();
  for (const o of options) {
    const level = o.level.trim();
    if (level) tally.set(level, (tally.get(level) || 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [level, count] of tally) {
    if (count > bestCount) {
      best = level;
      bestCount = count;
    }
  }
  return best || DEST_LEVELS[depth] || "Level";
}

// One numbered step of the entry form — where, what, how many. Splitting the
// form into three cards rather than one row of fields is the point: the old
// layout put a product search, a list box and a count side by side at three
// different heights, and nothing said which one to fill in first.
function FormBlock({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <div style={formBlockStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
        <span style={stepDotStyle}>{step}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#4a5878", letterSpacing: ".5px", textTransform: "uppercase" }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

// Rename / nudge, on every node that has a visible label. An arrow is left out
// rather than disabled at the ends of a list, so the control never invites a
// click that does nothing.
function NodeActions({ onEdit, onUp, onDown, compact }: { onEdit: () => void; onUp?: () => void; onDown?: () => void; compact?: boolean }) {
  const s = {
    border: "1px solid #e4eaf3",
    background: "#fff",
    color: "#8a97b0",
    borderRadius: 6,
    cursor: "pointer",
    padding: compact ? "1px 5px" : "2px 7px",
    fontSize: compact ? 10.5 : 11.5,
    lineHeight: 1.4,
  } as const;
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <button onClick={onEdit} style={s} title="Rename or move">
        ✎
      </button>
      {onUp ? (
        <button onClick={onUp} style={s} title="Move up">
          ↑
        </button>
      ) : null}
      {onDown ? (
        <button onClick={onDown} style={s} title="Move down">
          ↓
        </button>
      ) : null}
    </span>
  );
}

// One rack, drawn as the thing it is: a stack of shelves with boxes on them.
//
// A rack whose children are plain boxes (no shelf level) still renders as a
// single grid of tiles, so shelving that isn't split into shelves doesn't get a
// pointless row per box.
function Rack({
  rack,
  sectionId,
  index,
  siblingCount,
  onAddChildren,
  onOpenBox,
  onEdit,
  onNudge,
}: {
  rack: MapNode;
  sectionId: string;
  index: number;
  siblingCount: number;
  onAddChildren: (parent: MapNode, level: string) => void;
  onOpenBox: (n: MapNode, trail: string, parentId: string) => void;
  onEdit: (n: MapNode, parentId: string) => void;
  onNudge: (parentId: string, id: string, delta: number) => void;
}) {
  // A child is a shelf if it holds boxes of its own, or if it simply isn't
  // called a Box — which covers six empty shelves waiting to be filled.
  const shelved = rack.children.some((c) => c.children.length > 0 || c.level.toLowerCase() !== "box");

  return (
    <div
      style={{
        minWidth: shelved ? 372 : 232,
        flexShrink: 0,
        border: "1px solid #e9edf3",
        borderRadius: 12,
        background: "#fcfdff",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #eef2f7", background: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#1a2b4a" }}>{rack.name}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 11, color: "#8a97b0" }}>{rack.totalQty} u</span>
            <NodeActions
              onEdit={() => onEdit(rack, sectionId)}
              onUp={index > 0 ? () => onNudge(sectionId, rack.id, -1) : undefined}
              onDown={index < siblingCount - 1 ? () => onNudge(sectionId, rack.id, 1) : undefined}
            />
          </span>
        </div>
        <div style={{ fontSize: 11, color: "#9aa6bd", marginTop: 2 }}>
          {rack.children.length} {shelved ? "shelves" : "boxes"}
          {rack.code ? ` · ${rack.code}` : ""}
        </div>
      </div>

      {/* Same case as a section's loose stock, one level down: booked to the
          rack rather than to a box on it. */}
      {rack.items.length ? (
        <button onClick={() => onOpenBox(rack, rack.name, sectionId)} style={{ ...looseStockStyle, padding: "8px 12px" }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: "#8a6417" }}>{rack.qty} units on the rack, not in a box →</span>
        </button>
      ) : null}

      {shelved ? (
        rack.children.map((shelf, shi) => (
          <div key={shelf.id} style={{ borderBottom: "1px solid #f1f4f8", padding: "8px 10px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 7 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: "#4a5878" }}>
                  {shelf.name}
                  <span style={{ fontWeight: 500, color: "#9aa6bd" }}>
                    {" "}
                    · {shelf.children.length} boxes · {shelf.totalQty} u
                  </span>
                </span>
                <NodeActions
                  compact
                  onEdit={() => onEdit(shelf, rack.id)}
                  onUp={shi > 0 ? () => onNudge(rack.id, shelf.id, -1) : undefined}
                  onDown={shi < rack.children.length - 1 ? () => onNudge(rack.id, shelf.id, 1) : undefined}
                />
              </span>
              <button onClick={() => onAddChildren(shelf, "Box")} style={{ ...smallAddStyle, padding: "3px 8px", fontSize: 11 }}>
                ＋ Boxes
              </button>
            </div>
            {shelf.items.length ? (
              <button
                onClick={() => onOpenBox(shelf, `${rack.name} › ${shelf.name}`, rack.id)}
                style={{ ...looseStockStyle, padding: "5px 9px", borderRadius: 7, marginBottom: 6, borderBottom: "none" }}
              >
                <span style={{ fontSize: 11, fontWeight: 600, color: "#8a6417" }}>{shelf.qty} units loose on this shelf →</span>
              </button>
            ) : null}
            {!shelf.children.length ? (
              <div style={{ fontSize: 11, color: "#aab4c8", padding: "4px 2px" }}>No boxes on this shelf yet.</div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {shelf.children.map((box, bi) => (
                  <BoxTile
                    key={box.id}
                    box={box}
                    onOpen={() => onOpenBox(box, `${rack.name} › ${shelf.name}`, shelf.id)}
                    onEdit={() => onEdit(box, shelf.id)}
                    onUp={bi > 0 ? () => onNudge(shelf.id, box.id, -1) : undefined}
                    onDown={bi < shelf.children.length - 1 ? () => onNudge(shelf.id, box.id, 1) : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        ))
      ) : (
        <div style={{ padding: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {rack.children.map((box, bi) => (
            <BoxTile
              key={box.id}
              box={box}
              grow
              onOpen={() => onOpenBox(box, rack.name, rack.id)}
              onEdit={() => onEdit(box, rack.id)}
              onUp={bi > 0 ? () => onNudge(rack.id, box.id, -1) : undefined}
              onDown={bi < rack.children.length - 1 ? () => onNudge(rack.id, box.id, 1) : undefined}
            />
          ))}
        </div>
      )}

      <div style={{ padding: 10 }}>
        <button
          onClick={() => onAddChildren(rack, shelved || !rack.children.length ? "Shelf" : "Box")}
          style={{ ...smallAddStyle, width: "100%", justifyContent: "center" }}
        >
          ＋ {shelved || !rack.children.length ? "Shelves" : "Boxes"}
        </button>
      </div>
    </div>
  );
}

function BoxTile({
  box,
  onOpen,
  onEdit,
  onUp,
  onDown,
  grow,
}: {
  box: MapNode;
  onOpen: () => void;
  onEdit: () => void;
  onUp?: () => void;
  onDown?: () => void;
  grow?: boolean;
}) {
  const filled = box.items.length > 0;
  const over = box.capacity != null && box.qty > box.capacity;
  return (
    <div
      style={{
        padding: "7px 8px 6px",
        borderRadius: 9,
        border: over ? "1px solid #f0c98a" : filled ? "1px solid #cfe0ff" : "1px dashed #dfe5ee",
        background: over ? "#fff8ec" : filled ? "#f2f7ff" : "#fff",
        minWidth: grow ? undefined : 112,
        flexGrow: grow ? 1 : 0,
      }}
    >
      <button
        onClick={onOpen}
        title={box.items.map((i) => `${i.name} — ${i.qty} ${i.unit}`).join("\n") || "Empty"}
        style={{ display: "block", width: "100%", textAlign: "left", border: "none", background: "none", padding: 0, cursor: "pointer" }}
      >
        <div style={{ fontSize: 11.5, fontWeight: 700, color: filled ? "#1560f0" : "#9aa6bd" }}>{box.name}</div>
        <div style={{ fontSize: 10.5, color: "#67748e", marginTop: 2, lineHeight: 1.35 }}>
          {filled ? (
            <>
              {box.items[0].name.length > 16 ? `${box.items[0].name.slice(0, 16)}…` : box.items[0].name}
              {box.items.length > 1 ? ` +${box.items.length - 1}` : ""}
            </>
          ) : (
            "empty"
          )}
        </div>
      </button>
      <div style={{ marginTop: 5 }}>
        <NodeActions compact onEdit={onEdit} onUp={onUp} onDown={onDown} />
      </div>
    </div>
  );
}

// Client-side echo of `expandTokens` in lib/location-bulk.ts, capped short. The
// server is still the authority; this only exists so a wrong range is visible
// before it becomes forty nodes to delete.
function previewNames(form: BulkForm): string[] {
  const explicit = form.names.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (explicit.length) return explicit.slice(0, 6).concat(explicit.length > 6 ? [`… +${explicit.length - 6}`] : []);

  const tokens: string[] = [];
  if (form.mode === "letter") {
    const a = form.from.toUpperCase().charCodeAt(0);
    const b = form.to.toUpperCase().charCodeAt(0);
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) return [];
    for (let i = a; i <= b && tokens.length < 60; i++) tokens.push(String.fromCharCode(i));
  } else {
    const a = Number(form.from);
    const b = Number(form.to);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return [];
    const pad = Number(form.pad) || 0;
    for (let i = a; i <= b && tokens.length < 60; i++) tokens.push(String(i).padStart(pad, "0"));
  }
  const names = tokens.map((t) => `${form.prefix}${t}`.trim());
  return names.slice(0, 6).concat(names.length > 6 ? [`… +${names.length - 6}`] : []);
}

const cardStyle = {
  background: "#fff",
  border: "1px solid #e9edf3",
  borderRadius: 14,
  overflow: "hidden",
  boxShadow: "0 1px 2px rgba(16,30,54,.04)",
} as const;

const levelChip = {
  display: "inline-block",
  padding: "2px 8px",
  background: "#eef2f9",
  color: "#5a6a86",
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 600,
} as const;

const smallAddStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 11px",
  border: "1px solid #cfe0ff",
  background: "#f2f7ff",
  color: "#1560f0",
  borderRadius: 8,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
} as const;

const ghostBtnStyle = {
  padding: "4px 9px",
  border: "1px solid #dfe5ee",
  background: "#fff",
  color: "#3a4a68",
  borderRadius: 7,
  fontSize: 11.5,
  fontWeight: 600,
  cursor: "pointer",
} as const;

// Fallback names for the entry form's location selects, used only when a level
// of the tree was saved without a `level` label of its own.
const DEST_LEVELS = ["Section", "Rack", "Shelf", "Box"];

const formBlockStyle = {
  background: "#fff",
  border: "1px solid #eef2f7",
  borderRadius: 11,
  padding: "12px 13px 13px",
  marginBottom: 9,
} as const;

const stepDotStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 18,
  height: 18,
  borderRadius: "50%",
  background: "#eaf2ff",
  color: "#1560f0",
  fontSize: 10.5,
  fontWeight: 800,
  flexShrink: 0,
} as const;

const fieldLabelStyle = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  color: "#8a97b0",
  marginBottom: 4,
} as const;

const fieldSelectStyle = {
  width: "100%",
  padding: "8px 9px",
  border: "1px solid #dfe5ee",
  borderRadius: 8,
  fontSize: 12.5,
  background: "#fff",
  color: "#1a2b4a",
} as const;

const readonlyFieldStyle = {
  padding: "9px 12px",
  border: "1px dashed #dfe5ee",
  borderRadius: 9,
  fontSize: 13,
  color: "#67748e",
  background: "#f8fafd",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

const pickedRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "9px 11px",
  border: "1px solid #cfe0ff",
  background: "#f6faff",
  borderRadius: 9,
} as const;

const resultListStyle = {
  marginTop: 7,
  border: "1px solid #e9edf3",
  borderRadius: 9,
  overflow: "hidden",
  background: "#fff",
} as const;

const resultRowStyle = {
  display: "flex",
  width: "100%",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "8px 11px",
  border: "none",
  borderBottom: "1px solid #f4f7fb",
  background: "none",
  cursor: "pointer",
  textAlign: "left",
} as const;

const destWarnStyle = {
  marginTop: 8,
  padding: "7px 10px",
  borderRadius: 8,
  background: "#fffaf0",
  border: "1px solid #f5e2bf",
  fontSize: 11.5,
  color: "#8a6417",
  lineHeight: 1.45,
} as const;

const looseStockStyle = {
  display: "flex",
  width: "100%",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "11px 18px",
  border: "none",
  borderBottom: "1px solid #f4f7fb",
  background: "#fffaf0",
  cursor: "pointer",
  textAlign: "left",
} as const;
