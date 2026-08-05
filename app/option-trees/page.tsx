"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import {
  ErrorBanner,
  PageIntro,
  EmptyState,
  Modal,
  ModalHeader,
  ModalFooter,
  labelStyle,
  inputStyle,
  secondaryBtnStyle,
  primaryBtnStyle,
  addBtnStyle,
  actionBtnStyle,
  chipStyle,
  toggleStyle,
  toggleKnobStyle,
} from "@/components/dc-ui";

type LevelInput = "nodes" | "list" | "text" | "number";

type Level = {
  label: string;
  input: LevelInput;
  options: string[];
  allowOther: boolean;
  placeholder: string;
  min: number;
  max: number;
};

type Tree = {
  id: string;
  name: string;
  desc: string;
  matches: string[];
  levels: Level[];
  status: "Active" | "Inactive";
  nodeCount: number;
};

type OptionNode = {
  id: string;
  treeId: string;
  parent: string | null;
  name: string;
  order: number;
  status: "Active" | "Inactive";
};

const EMPTY_LEVEL: Level = { label: "", input: "nodes", options: [], allowOther: false, placeholder: "", min: 0, max: 0 };

// While the editor is open a fixed list is held as the raw text the user typed,
// not as the parsed array. Parsing on every keystroke swallows the comma that
// starts the next choice, so the field can only ever hold one.
type EditorLevel = Level & { optionsText: string };

const toEditorLevel = (l: Level): EditorLevel => ({ ...l, optionsText: l.options.join(", ") });

const INPUT_LABELS: Record<LevelInput, string> = {
  nodes: "Options from this tree",
  list: "Fixed list",
  text: "Typed answer",
  number: "Number keypad",
};

// How deep in the tree a level's options live. Only `nodes` levels read from the
// forest, so a Size level under a fixed-list Colour level still hangs off the
// subcategory the user picked — the same rule the bot walks by.
function nodeDepthOfLevel(levels: Level[], index: number): number {
  return levels.slice(0, index).filter((l) => l.input === "nodes").length;
}

function fetchNodes(treeId: string): Promise<OptionNode[]> {
  return api.get<OptionNode[]>(`/api/option-trees/nodes?treeId=${treeId}`);
}

export default function OptionTreesPage() {
  const [trees, setTrees] = useState<Tree[]>([]);
  const [nodes, setNodes] = useState<OptionNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [nodeModal, setNodeModal] = useState<{ parent: string | null; editing: OptionNode | null } | null>(null);
  const [nodeName, setNodeName] = useState("");
  const [nodeOrder, setNodeOrder] = useState<number | string>(0);

  const [delTree, setDelTree] = useState<Tree | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Tree[]>("/api/option-trees")
      .then((data) => {
        if (cancelled) return;
        setTrees(data);
        setSelectedId((id) => id ?? data[0]?.id ?? null);
      })
      .catch((err: Error) => !cancelled && setLoadError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetchNodes(selectedId)
      .then((list) => !cancelled && setNodes(list))
      .catch((err: Error) => !cancelled && setLoadError(err.message));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selected = trees.find((t) => t.id === selectedId) ?? null;
  const editing = trees.find((t) => t.id === editingId) ?? null;

  // Scoped to the selected tree so a list still in flight — or left over from
  // the tree that was showing a moment ago — can never render under this one.
  function childrenOf(parent: string | null) {
    return nodes.filter((n) => n.treeId === selectedId && (n.parent ?? null) === parent);
  }
  function hasChildren(id: string) {
    return nodes.some((n) => n.parent === id);
  }

  // Depth-first rows for the table, honouring the collapse state.
  function flatten() {
    const out: { node: OptionNode; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const n of childrenOf(parent)) {
        out.push({ node: n, depth });
        if (!collapsed[n.id]) walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  async function saveTree(form: { name: string; desc: string; matches: string[]; levels: Level[]; status: "Active" | "Inactive" }) {
    if (editingId) {
      const updated = await api.patch<Tree>(`/api/option-trees/${editingId}`, form);
      setTrees((prev) => prev.map((t) => (t.id === editingId ? { ...updated, nodeCount: t.nodeCount } : t)));
    } else {
      const created = await api.post<Tree>("/api/option-trees", form);
      setTrees((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedId(created.id);
    }
    setEditorOpen(false);
  }

  async function toggleTreeStatus(t: Tree) {
    const status = t.status === "Active" ? "Inactive" : "Active";
    setTrees((prev) => prev.map((x) => (x.id === t.id ? { ...x, status } : x)));
    await api.patch(`/api/option-trees/${t.id}`, { status });
  }

  async function doDeleteTree() {
    const t = delTree;
    setDelTree(null);
    if (!t) return;
    setTrees((prev) => prev.filter((x) => x.id !== t.id));
    if (selectedId === t.id) setSelectedId(null);
    await api.del(`/api/option-trees/${t.id}`);
  }

  async function saveNode() {
    if (!selected || !nodeModal || !nodeName.trim()) return;
    const payload = { name: nodeName.trim(), order: Number(nodeOrder) || 0 };
    try {
      if (nodeModal.editing) {
        await api.patch<OptionNode>(`/api/option-trees/nodes/${nodeModal.editing.id}`, payload);
      } else {
        await api.post<OptionNode>("/api/option-trees/nodes", { ...payload, treeId: selected.id, parent: nodeModal.parent });
        setTrees((prev) => prev.map((t) => (t.id === selected.id ? { ...t, nodeCount: t.nodeCount + 1 } : t)));
      }
      setNodeModal(null);
      setNodes(await fetchNodes(selected.id));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function toggleNodeStatus(n: OptionNode) {
    const status = n.status === "Active" ? "Inactive" : "Active";
    setNodes((prev) => prev.map((x) => (x.id === n.id ? { ...x, status } : x)));
    await api.patch(`/api/option-trees/nodes/${n.id}`, { status });
  }

  async function deleteNode(n: OptionNode) {
    try {
      await api.del(`/api/option-trees/nodes/${n.id}`);
      setNodes((prev) => prev.filter((x) => x.id !== n.id));
      setTrees((prev) => prev.map((t) => (t.id === n.treeId ? { ...t, nodeCount: Math.max(0, t.nodeCount - 1) } : t)));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  const rows = flatten();
  const nodeLevels = (selected?.levels ?? []).filter((l) => l.input === "nodes");

  return (
    <PageShell section="Master Data" page="Nested Categories" maxWidth={1320}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro
          title="Nested Categories"
          description="Multi-level drill-downs the bot asks one question at a time. A tree is its levels — Type of Wire → Subcategory → Colour → Size — and the options that answer them."
        />
        <button
          onClick={() => {
            setEditingId(null);
            setEditorOpen(true);
          }}
          style={addBtnStyle}
        >
          ＋ New Tree
        </button>
      </div>

      {loadError && <ErrorBanner message={loadError} />}

      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16, alignItems: "start" }}>
        {/* Trees */}
        <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
          <div style={{ padding: "15px 18px", borderBottom: "1px solid #f1f4f8", fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Trees</div>
          {trees.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "12px 16px",
                border: "none",
                borderTop: "1px solid #f1f4f8",
                background: selectedId === t.id ? "#eef4ff" : "#fff",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13, color: "#1a2b4a" }}>{t.name}</span>
                {t.status === "Inactive" ? (
                  <span style={{ fontSize: 10.5, fontWeight: 700, background: "#f4f6f9", color: "#8a97b0", borderRadius: 20, padding: "1px 8px" }}>OFF</span>
                ) : null}
              </div>
              <div style={{ fontSize: 11.5, color: "#98a4bd", marginTop: 3 }}>
                {t.levels.length} level{t.levels.length === 1 ? "" : "s"} · {t.nodeCount} option{t.nodeCount === 1 ? "" : "s"}
              </div>
            </button>
          ))}
          {!loading && trees.length === 0 ? <EmptyState text="No trees yet. Create one to start a drill-down." /> : null}
          {loading ? <EmptyState text="Loading…" /> : null}
        </section>

        {/* Selected tree */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {selected ? (
            <>
              <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#0b1b45" }}>{selected.name}</div>
                    <div style={{ fontSize: 12.5, color: "#8a97b0", marginTop: 3 }}>{selected.desc || "No description."}</div>
                    <div style={{ fontSize: 11.5, color: "#67748e", marginTop: 8 }}>
                      Also matches: {selected.matches.length ? <b>{selected.matches.join(", ")}</b> : <i>nothing but the name</i>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button onClick={() => toggleTreeStatus(selected)} style={chipStyle(selected.status === "Active")}>
                      {selected.status}
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(selected.id);
                        setEditorOpen(true);
                      }}
                      style={actionBtnStyle("#1560f0", "#cfe0ff")}
                    >
                      Edit levels
                    </button>
                    <button onClick={() => setDelTree(selected)} style={actionBtnStyle("#d63a3a", "#f4d0d0")}>
                      Delete
                    </button>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                  {selected.levels.map((l, i) => (
                    <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                      {i > 0 ? <span style={{ color: "#c4ccda" }}>→</span> : null}
                      <span style={{ padding: "5px 11px", borderRadius: 8, background: l.input === "nodes" ? "#eef4ff" : "#f4f6f9", color: l.input === "nodes" ? "#1560f0" : "#5a6a86", fontSize: 12, fontWeight: 600 }}>
                        {l.label}
                        <span style={{ fontWeight: 500, opacity: 0.7 }}> · {INPUT_LABELS[l.input]}</span>
                      </span>
                    </span>
                  ))}
                  {selected.levels.length === 0 ? <span style={{ fontSize: 12.5, color: "#98a4bd" }}>No levels yet — the bot has nothing to ask.</span> : null}
                </div>
              </section>

              <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
                <div style={{ padding: "13px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid #f1f4f8" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>Options</div>
                    <div style={{ fontSize: 11.5, color: "#98a4bd", marginTop: 2 }}>
                      {nodeLevels.length
                        ? `Top level answers “${nodeLevels[0].label}”. Add children under an option to answer the next tree level.`
                        : "This tree has no levels that read from the forest, so it needs no options."}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setNodeModal({ parent: null, editing: null });
                      setNodeName("");
                      setNodeOrder(childrenOf(null).length + 1);
                    }}
                    style={{ padding: "7px 12px", border: "1px solid #cfe0ff", background: "#f2f7ff", color: "#1560f0", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                  >
                    ＋ Top-level option
                  </button>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <tbody>
                    {rows.map(({ node: n, depth }) => {
                      const kids = hasChildren(n.id);
                      const levelName = (selected.levels.filter((l) => l.input === "nodes")[depth]?.label) ?? `Level ${depth + 1}`;
                      return (
                        <tr key={n.id}>
                          <td style={{ padding: "10px 14px 10px 18px", borderTop: "1px solid #f1f4f8" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: depth * 22 }}>
                              <button
                                onClick={kids ? () => setCollapsed((c) => ({ ...c, [n.id]: !c[n.id] })) : undefined}
                                style={{ width: 18, height: 18, border: "none", background: "none", color: "#8a97b0", cursor: kids ? "pointer" : "default", fontSize: 11, flexShrink: 0 }}
                              >
                                {kids ? (collapsed[n.id] ? "▸" : "▾") : ""}
                              </button>
                              <span style={{ fontSize: 13, color: depth === 0 ? "#1560f0" : "#9aa6bd", flexShrink: 0 }}>{kids ? "▤" : "▢"}</span>
                              <span style={{ fontWeight: depth === 0 ? 700 : 500, color: n.status === "Active" ? "#1a2b4a" : "#a8b2c4" }}>{n.name}</span>
                            </div>
                          </td>
                          <td style={{ padding: "10px 14px", borderTop: "1px solid #f1f4f8" }}>
                            <span style={{ display: "inline-block", padding: "3px 9px", background: "#eef2f9", color: "#5a6a86", borderRadius: 6, fontSize: 11.5, fontWeight: 600 }}>{levelName}</span>
                          </td>
                          <td style={{ padding: "10px 14px", borderTop: "1px solid #f1f4f8", textAlign: "center", color: "#8a97b0", fontFamily: "var(--font-mono)", width: 60 }}>{n.order || "—"}</td>
                          <td style={{ padding: "10px 14px", borderTop: "1px solid #f1f4f8", width: 90 }}>
                            <button onClick={() => toggleNodeStatus(n)} style={chipStyle(n.status === "Active")}>
                              {n.status}
                            </button>
                          </td>
                          <td style={{ padding: "10px 18px 10px 14px", borderTop: "1px solid #f1f4f8" }}>
                            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                              {depth + 1 < nodeLevels.length ? (
                                <button
                                  onClick={() => {
                                    setNodeModal({ parent: n.id, editing: null });
                                    setNodeName("");
                                    setNodeOrder(childrenOf(n.id).length + 1);
                                  }}
                                  style={actionBtnStyle("#1560f0", "#cfe0ff")}
                                  title={`Add an option for “${nodeLevels[depth + 1].label}”`}
                                >
                                  ＋ Child
                                </button>
                              ) : null}
                              <button
                                onClick={() => {
                                  setNodeModal({ parent: n.parent, editing: n });
                                  setNodeName(n.name);
                                  setNodeOrder(n.order);
                                }}
                                style={actionBtnStyle("#3a4a68", "#dfe5ee")}
                              >
                                Edit
                              </button>
                              <button onClick={() => deleteNode(n)} style={actionBtnStyle("#d63a3a", "#f4d0d0")}>
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {rows.length === 0 ? <EmptyState text="No options yet. Add the answers to the first level." /> : null}
              </section>
            </>
          ) : (
            <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, padding: "40px 0" }}>
              <EmptyState text="Select a tree on the left, or create one." />
            </section>
          )}
        </div>
      </div>

      {editorOpen ? (
        <TreeEditor key={editingId ?? "new"} tree={editing} onClose={() => setEditorOpen(false)} onSave={saveTree} />
      ) : null}

      {nodeModal ? (
        <Modal onClose={() => setNodeModal(null)} maxWidth={460}>
          <ModalHeader
            title={nodeModal.editing ? "Edit option" : "New option"}
            subtitle={
              nodeModal.editing
                ? "Renaming an option does not change entries already raised against it."
                : nodeModal.parent
                  ? `Offered only after the option above it is picked.`
                  : "Offered at the first level of this tree."
            }
            onClose={() => setNodeModal(null)}
          />
          <div style={{ padding: "22px 24px", display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}>
            <div>
              <label style={labelStyle}>
                Option <span style={{ color: "#e0524f" }}>*</span>
              </label>
              <input value={nodeName} onChange={(e) => setNodeName(e.target.value)} placeholder="e.g. Copper" style={inputStyle} autoFocus />
            </div>
            <div>
              <label style={labelStyle}>Order</label>
              <input value={nodeOrder} onChange={(e) => setNodeOrder(e.target.value)} type="number" style={inputStyle} />
            </div>
          </div>
          <ModalFooter>
            <button onClick={() => setNodeModal(null)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={saveNode} style={primaryBtnStyle}>
              Save
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {delTree ? (
        <Modal onClose={() => setDelTree(null)} maxWidth={440} align="center">
          <div style={{ padding: 24 }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: "#fdecec", color: "#d63a3a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 14 }}>
              🗑
            </div>
            <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>Delete &ldquo;{delTree.name}&rdquo;?</h3>
            <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>
              Its {delTree.nodeCount} option{delTree.nodeCount === 1 ? "" : "s"} go to the recycle bin with it. Workflow steps pointing at this tree will
              step aside until another tree matches. Entries already raised keep what they captured.
            </p>
          </div>
          <ModalFooter>
            <button onClick={() => setDelTree(null)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={doDeleteTree} style={{ ...primaryBtnStyle, background: "#d63a3a" }}>
              Delete
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

// The levels editor. Levels ARE the questions, so this is where a tree is
// actually designed — the options under it only answer what is defined here.
function TreeEditor({
  tree,
  onClose,
  onSave,
}: {
  tree: Tree | null;
  onClose: () => void;
  onSave: (form: { name: string; desc: string; matches: string[]; levels: Level[]; status: "Active" | "Inactive" }) => Promise<void>;
}) {
  const [name, setName] = useState(tree?.name ?? "");
  const [desc, setDesc] = useState(tree?.desc ?? "");
  const [matches, setMatches] = useState((tree?.matches ?? []).join(", "));
  const [levels, setLevels] = useState<EditorLevel[]>(
    tree?.levels?.length ? tree.levels.map(toEditorLevel) : [toEditorLevel(EMPTY_LEVEL)],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function setLevel(i: number, patch: Partial<EditorLevel>) {
    setLevels((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function move(i: number, delta: number) {
    setLevels((prev) => {
      const next = [...prev];
      const j = i + delta;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function submit() {
    if (!name.trim()) {
      setError("A tree needs a name.");
      return;
    }
    const cleaned = levels
      .filter((l) => l.label.trim())
      .map(({ optionsText, ...l }) => ({ ...l, options: optionsText.split(",").map((o) => o.trim()).filter(Boolean) }));
    if (!cleaned.length) {
      setError("Add at least one level — a tree with no levels asks nothing.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        desc,
        matches: matches.split(",").map((m) => m.trim()).filter(Boolean),
        levels: cleaned,
        status: tree?.status ?? "Active",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} maxWidth={720}>
      <ModalHeader
        title={tree ? `Edit — ${tree.name}` : "New nested category tree"}
        subtitle="Levels are the questions, asked top to bottom. Only “Options from this tree” levels drill down the option forest."
        onClose={onClose}
      />
      <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16, maxHeight: 520, overflowY: "auto" }}>
        {error ? <ErrorBanner message={error} /> : null}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div>
            <label style={labelStyle}>
              Tree name <span style={{ color: "#e0524f" }}>*</span>
            </label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Wire" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Also matches (comma separated)</label>
            <input value={matches} onChange={(e) => setMatches(e.target.value)} placeholder="cable, wiring" style={inputStyle} />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Description</label>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What this drill-down captures…" style={inputStyle} />
        </div>

        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", color: "#aab4c8", marginTop: 4 }}>
          Levels ({levels.length})
        </div>
        {levels.map((l, i) => (
          <div key={i} style={{ border: "1px solid #e9edf3", borderRadius: 11, padding: 14, background: "#fbfcfe", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "#c4ccda", width: 16 }}>{i + 1}</span>
              <input
                value={l.label}
                onChange={(e) => setLevel(i, { label: e.target.value })}
                placeholder="Question, e.g. Type of Wire"
                style={{ ...inputStyle, flex: 1 }}
              />
              <select value={l.input} onChange={(e) => setLevel(i, { input: e.target.value as LevelInput })} style={{ ...inputStyle, background: "#fff", width: 190 }}>
                {(Object.keys(INPUT_LABELS) as LevelInput[]).map((k) => (
                  <option key={k} value={k}>
                    {INPUT_LABELS[k]}
                  </option>
                ))}
              </select>
              <button onClick={() => move(i, -1)} disabled={i === 0} style={actionBtnStyle("#3a4a68", "#dfe5ee")} title="Move up">
                ↑
              </button>
              <button onClick={() => move(i, 1)} disabled={i === levels.length - 1} style={actionBtnStyle("#3a4a68", "#dfe5ee")} title="Move down">
                ↓
              </button>
              <button onClick={() => setLevels((prev) => prev.filter((_, idx) => idx !== i))} style={actionBtnStyle("#d63a3a", "#f4d0d0")} title="Remove level">
                ✕
              </button>
            </div>

            {l.input === "nodes" ? (
              <div style={{ fontSize: 11.5, color: "#67748e" }}>
                Answered from the option forest — this is tree depth {nodeDepthOfLevel(levels, i) + 1}. Author the options under
                <b> Options</b> after saving.
              </div>
            ) : null}
            {l.input === "list" ? (
              <div>
                <label style={labelStyle}>Choices (comma separated)</label>
                <input
                  value={l.optionsText}
                  onChange={(e) => setLevel(i, { optionsText: e.target.value })}
                  placeholder="Red, Black, Blue, Green, Yellow"
                  style={inputStyle}
                />
              </div>
            ) : null}
            {l.input === "text" ? (
              <div>
                <label style={labelStyle}>Hint under the question</label>
                <input value={l.placeholder} onChange={(e) => setLevel(i, { placeholder: e.target.value })} placeholder="e.g. Where will it be used?" style={inputStyle} />
              </div>
            ) : null}
            {l.input === "number" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div>
                  <label style={labelStyle}>Minimum</label>
                  <input type="number" value={l.min} onChange={(e) => setLevel(i, { min: Number(e.target.value) || 0 })} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Maximum (0 = no limit)</label>
                  <input type="number" value={l.max} onChange={(e) => setLevel(i, { max: Number(e.target.value) || 0 })} style={inputStyle} />
                </div>
              </div>
            ) : null}
            {l.input === "nodes" || l.input === "list" ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <label style={{ fontSize: 12.5, fontWeight: 600, color: "#3a4a68" }}>
                  Allow a typed answer too
                  <span style={{ display: "block", fontWeight: 500, fontSize: 11.5, color: "#98a4bd" }}>
                    For the value nobody thought to add. A typed answer does not drill any deeper.
                  </span>
                </label>
                <button onClick={() => setLevel(i, { allowOther: !l.allowOther })} style={toggleStyle(l.allowOther)}>
                  <span style={toggleKnobStyle(l.allowOther)} />
                </button>
              </div>
            ) : null}
          </div>
        ))}
        <button
          onClick={() => setLevels((prev) => [...prev, toEditorLevel(EMPTY_LEVEL)])}
          style={{ ...secondaryBtnStyle, borderColor: "#cfe0ff", color: "#1560f0", alignSelf: "flex-start" }}
        >
          ＋ Add level
        </button>
      </div>
      <ModalFooter>
        <button onClick={onClose} style={secondaryBtnStyle}>
          Cancel
        </button>
        <button onClick={submit} style={primaryBtnStyle} disabled={saving}>
          {saving ? "Saving…" : "Save tree"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
