"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { api } from "@/lib/api-client";
import {
  labelStyle,
  inputStyle,
  secondaryBtnStyle,
  primaryBtnStyle,
  EmptyState,
} from "@/components/dc-ui";
import { questionLibrary, type MoveQuestionKind, type StockOptionEffect } from "@/lib/movement-questions";
import {
  applyMessageTemplate,
  applyPreviewAction,
  branchSteps,
  buildExampleWorkflow,
  dropAt,
  ensureConfiguredMovementBranches,
  findSelectMovement,
  initialPreviewState,
  leadInPath,
  movementBranches,
  movementCodesInTree,
  previewScreen,
  removeNode,
  updateNode,
  type FlowNode,
  type FlowNodeKind,
  type PreviewButton,
  type PreviewSimState,
  type SearchMoveWorkflow,
} from "@/lib/search-move-workflow";

export type MovementTypeRow = {
  id: string;
  code: string;
  name: string;
  direction: string;
  desc: string;
  isSystem: boolean;
  status: string;
};

type DragPayload =
  | { source: "palette-movement"; code: string; name: string; direction: string }
  | { source: "palette-question"; kind: MoveQuestionKind }
  | { source: "palette-step"; kind: FlowNodeKind }
  | { source: "tree-node"; nodeId: string };

const KIND_META: Record<string, { icon: string; color: string; tip: string; label?: string }> = {
  search: { icon: "🔍", color: "#1560f0", tip: "User types an item name" },
  pick_category: { icon: "📂", color: "#b45309", tip: "Walk the full category tree, then list matches" },
  pick_location: { icon: "📍", color: "#2563eb", tip: "Selectable list of storage locations" },
  pick_vendor: { icon: "◈", color: "#0d9488", tip: "Pick from Vendor Master" },
  pick_department: { icon: "⌂", color: "#0369a1", tip: "Pick from Department Master" },
  select_movement: { icon: "📋", color: "#7c3aed", tip: "Pick a Movement Master type" },
  movement: { icon: "◆", color: "#0f9d63", tip: "A Movement Master type" },
  location: { icon: "📍", color: "#2563eb", tip: "Pick location" },
  from: { icon: "⬆", color: "#2563eb", tip: "Transfer from" },
  to: { icon: "⬇", color: "#2563eb", tip: "Transfer to" },
  qty: { icon: "#", color: "#db2777", tip: "Quantity pad" },
  stock_in: {
    icon: "+",
    color: "#0f9d63",
    tip: "Silent: Accept posts +qty (not shown in Telegram)",
    label: "Increase stock (+)",
  },
  stock_out: {
    icon: "−",
    color: "#dc2626",
    tip: "Silent: Accept posts −qty (not shown in Telegram)",
    label: "Decrease stock (−)",
  },
  question: { icon: "?", color: "#ea580c", tip: "Custom question" },
  reference: { icon: "📎", color: "#64748b", tip: "Reference field" },
  remarks: { icon: "📝", color: "#64748b", tip: "Remarks field" },
  review: { icon: "✔", color: "#0f9d63", tip: "Review before cart" },
  add_to_cart: { icon: "🧺", color: "#0f9d63", tip: "Add completed line to cart" },
  done: { icon: "✓", color: "#0f9d63", tip: "Legacy — use Add to cart" },
  intent: { icon: "⇄", color: "#94a3b8", tip: "Legacy" },
  record_hub: { icon: "📋", color: "#94a3b8", tip: "Legacy" },
  request_branch: { icon: "🧺", color: "#94a3b8", tip: "Legacy" },
};

const STEP_PALETTE: FlowNodeKind[] = [
  "search",
  "pick_category",
  "pick_location",
  "pick_vendor",
  "pick_department",
  "select_movement",
  "location",
  "from",
  "to",
  "qty",
  "stock_in",
  "stock_out",
  "reference",
  "remarks",
  "review",
  "add_to_cart",
];

const SAMPLE = {
  product: "MS Round Pipe 50mm · MS Pipe",
  unit: "Meter",
  stockLines: "📍 Main warehouse — 120",
  where: "Main warehouse",
};

const DND_MIME = "application/x-move-flow";

type Props = { types: MovementTypeRow[] };

export default function MovementFlowTree({ types }: Props) {
  const [workflow, setWorkflow] = useState<SearchMoveWorkflow | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [editorOpen, setEditorOpen] = useState(true);
  const [bodyOpen, setBodyOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [paletteSections, setPaletteSections] = useState({ movements: true, questions: true, steps: true });

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [fullscreen]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<SearchMoveWorkflow>("/api/search-move-workflow")
      .then((wf) => {
        if (cancelled) return;
        // Guarantee configured movement branches (VR / DR / New Purchase) appear
        // even if the API briefly returns a tree that predated those ensures.
        const next = ensureConfiguredMovementBranches(wf);
        setWorkflow(next);
        setSelectedId(next.rootId);
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const manualTypes = useMemo(
    () => types.filter((t) => !t.isSystem && t.status !== "Inactive"),
    [types]
  );

  const usedCodes = useMemo(() => {
    if (!workflow) return new Set<string>();
    return new Set(movementCodesInTree(workflow));
  }, [workflow]);

  const selected = workflow && selectedId ? workflow.nodes[selectedId] ?? null : null;
  const lead = workflow ? leadInPath(workflow) : [];
  const hub = workflow ? findSelectMovement(workflow) : null;
  const movements = workflow ? movementBranches(workflow) : [];

  function apply(next: SearchMoveWorkflow) {
    setWorkflow(next);
    setSaveMsg(null);
  }

  function selectNode(id: string) {
    setSelectedId(id);
    setEditorOpen(true);
  }

  async function save() {
    if (!workflow) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const saved = await api.put<SearchMoveWorkflow>("/api/search-move-workflow", workflow);
      setWorkflow(saved);
      setSaveMsg("Saved — Telegram search groups use this tree now.");
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function readPayload(e: DragEvent): DragPayload | null {
    try {
      const raw = e.dataTransfer.getData(DND_MIME) || e.dataTransfer.getData("application/json");
      if (!raw) return null;
      return JSON.parse(raw) as DragPayload;
    } catch {
      return null;
    }
  }

  function startDrag(e: DragEvent, payload: DragPayload) {
    e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
    e.dataTransfer.setData("application/json", JSON.stringify(payload));
    e.dataTransfer.effectAllowed = payload.source === "tree-node" ? "move" : "copy";
    if (payload.source === "tree-node") setDraggingId(payload.nodeId);
  }

  function endDrag() {
    setDraggingId(null);
    setDragOverKey(null);
  }

  function handleDrop(parentId: string, index: number, e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOverKey(null);
    setDraggingId(null);
    if (!workflow) return;
    const payload = readPayload(e);
    if (!payload) return;
    apply(dropAt(workflow, { parentId, index }, payload));
  }

  function resetExample() {
    const example = buildExampleWorkflow();
    apply(example);
    setSelectedId(example.rootId);
  }

  if (loadError) {
    return (
      <section style={panelStyle}>
        <div style={{ padding: 18, color: "#d63a3a" }}>{loadError}</div>
      </section>
    );
  }
  if (!workflow || !lead.length) {
    return (
      <section style={panelStyle}>
        <div style={{ padding: 28, color: "#8a97b0" }}>Loading flowchart…</div>
      </section>
    );
  }

  return (
    <section
      style={
        fullscreen
          ? {
              position: "fixed",
              inset: 0,
              zIndex: 12000,
              margin: 0,
              borderRadius: 0,
              border: "none",
              width: "100vw",
              height: "100vh",
              background: "#fff",
              display: "flex",
              flexDirection: "column",
              boxShadow: "none",
              overflow: "hidden",
            }
          : { ...panelStyle, marginBottom: 22, width: "100%" }
      }
    >
      <div style={{ ...headerRow, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0, flex: 1 }}>
          {!fullscreen ? (
            <button type="button" onClick={() => setBodyOpen((o) => !o)} style={iconToggleBtn}>
              {bodyOpen ? "▾" : "▸"}
            </button>
          ) : null}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>
              {fullscreen ? "Workflow builder — fullscreen" : "Movement flowchart"}
            </div>
            <div style={{ fontSize: 12.5, color: "#8a97b0", marginTop: 4, lineHeight: 1.45 }}>
              Same tree Telegram walks in Requests-mode groups — save to push live. Every node is editable.
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {fullscreen ? (
            <button type="button" style={{ ...primaryBtnStyle, background: "#0b1b45" }} onClick={() => setFullscreen(false)}>
              ✕ Exit fullscreen
            </button>
          ) : (
            <button
              type="button"
              style={primaryBtnStyle}
              onClick={() => {
                setBodyOpen(true);
                setPaletteOpen(true);
                setEditorOpen(true);
                setFullscreen(true);
              }}
            >
              ⛶ Fullscreen
            </button>
          )}
          <button type="button" style={secondaryBtnStyle} onClick={() => setPaletteOpen((o) => !o)}>
            {paletteOpen ? "Hide library" : "Show library"}
          </button>
          <button type="button" style={secondaryBtnStyle} onClick={() => setEditorOpen((o) => !o)}>
            {editorOpen ? "Hide editor" : "Show editor"}
          </button>
          <button type="button" style={secondaryBtnStyle} onClick={resetExample}>
            Load default example
          </button>
          <button type="button" style={secondaryBtnStyle} onClick={() => setPreviewOpen(true)}>
            ▶ Try it like Telegram
          </button>
          <button type="button" style={{ ...primaryBtnStyle, opacity: saving ? 0.7 : 1 }} disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save workflow"}
          </button>
        </div>
      </div>
      {saveMsg ? (
        <div
          style={{
            padding: "8px 18px",
            fontSize: 12.5,
            color: /fail/i.test(saveMsg) ? "#d63a3a" : "#0f9d63",
            background: "#f8fafc",
            borderBottom: "1px solid #f1f4f8",
            flexShrink: 0,
          }}
        >
          {saveMsg}
        </div>
      ) : null}

      {bodyOpen || fullscreen ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `${paletteOpen ? "260px" : "40px"} minmax(0,1fr) ${editorOpen ? "340px" : "40px"}`,
            height: fullscreen ? undefined : "min(78vh, 900px)",
            flex: fullscreen ? 1 : undefined,
            minHeight: fullscreen ? 0 : 480,
            transition: "grid-template-columns .18s ease",
          }}
        >
          <aside
            style={{
              borderRight: "1px solid #f1f4f8",
              background: "#fafbfd",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            <div style={railHeader}>
              {paletteOpen ? (
                <span style={{ fontSize: 11, fontWeight: 800, color: "#8a97b0", letterSpacing: 0.5 }}>LIBRARY</span>
              ) : null}
              <button type="button" style={iconToggleBtn} onClick={() => setPaletteOpen((o) => !o)}>
                {paletteOpen ? "‹" : "›"}
              </button>
            </div>
            {paletteOpen ? (
              <div style={{ flex: 1, overflow: "auto", padding: "4px 10px 16px", minHeight: 0 }}>
                <CollapsibleSection
                  title="Movements"
                  open={paletteSections.movements}
                  onToggle={() => setPaletteSections((s) => ({ ...s, movements: !s.movements }))}
                >
                  <Hint>Drop under Select movement to add a branch root</Hint>
                  {manualTypes.map((t) => {
                    const used = usedCodes.has(t.code);
                    return (
                      <div
                        key={t.id}
                        draggable
                        onDragStart={(e) =>
                          startDrag(e, { source: "palette-movement", code: t.code, name: t.name, direction: t.direction })
                        }
                        onDragEnd={endDrag}
                        style={{ ...chipDrag, opacity: used ? 0.55 : 1, cursor: "grab" }}
                      >
                        <span style={{ fontWeight: 700, color: "#1a2b4a" }}>{t.name}</span>
                        <span style={{ fontSize: 10.5, color: "#98a4bd", textTransform: "capitalize" }}>{t.direction}</span>
                      </div>
                    );
                  })}
                  {!manualTypes.length ? <EmptyState text="Seed movement types first." /> : null}
                </CollapsibleSection>

                <CollapsibleSection
                  title="Questions"
                  open={paletteSections.questions}
                  onToggle={() => setPaletteSections((s) => ({ ...s, questions: !s.questions }))}
                >
                  <Hint>Drop into a movement branch</Hint>
                  {questionLibrary().map((q) => (
                    <div
                      key={q.type}
                      draggable
                      onDragStart={(e) => startDrag(e, { source: "palette-question", kind: q.type })}
                      onDragEnd={endDrag}
                      style={chipDrag}
                    >
                      <span style={{ fontWeight: 700, color: "#1560f0", width: 18 }}>{q.icon}</span>
                      <div>
                        <div style={{ fontWeight: 700, color: "#1a2b4a" }}>{q.name}</div>
                        <div style={{ fontSize: 10.5, color: "#98a4bd" }}>{q.desc}</div>
                      </div>
                    </div>
                  ))}
                </CollapsibleSection>

                <CollapsibleSection
                  title="Steps"
                  open={paletteSections.steps}
                  onToggle={() => setPaletteSections((s) => ({ ...s, steps: !s.steps }))}
                >
                  <Hint>Search, location, qty, stock +/−, cart…</Hint>
                  {STEP_PALETTE.map((kind) => (
                    <div
                      key={kind}
                      draggable
                      onDragStart={(e) => startDrag(e, { source: "palette-step", kind })}
                      onDragEnd={endDrag}
                      style={chipDrag}
                    >
                      <span style={{ color: KIND_META[kind].color, fontWeight: 800, width: 18 }}>{KIND_META[kind].icon}</span>
                      <span style={{ fontWeight: 700, color: "#1a2b4a", textTransform: "capitalize" }}>
                        {KIND_META[kind].label ?? kind.replace(/_/g, " ")}
                      </span>
                    </div>
                  ))}
                </CollapsibleSection>
              </div>
            ) : null}
          </aside>

          <div
            style={{
              padding: "20px 16px 40px",
              overflow: "auto",
              minWidth: 0,
              minHeight: 0,
              background: "linear-gradient(180deg,#f4f7fb 0%,#eef2f8 100%)",
            }}
            onDragEnd={endDrag}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 0,
                minWidth: "max(100%, 720px)",
                width: "max-content",
                margin: "0 auto",
              }}
            >
              <div style={{ fontSize: 11, color: "#8a97b0", marginBottom: 10, fontWeight: 700, letterSpacing: 0.2 }}>
                Shared lead-in (editable) → movement roots side by side
              </div>

              {/* Lead-in: search → … → select movement */}
              {lead.map((id, i) => {
                const node = workflow.nodes[id];
                if (!node) return null;
                const dropParent = i === 0 ? workflow.rootId : lead[i - 1];
                return (
                  <div key={id} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", maxWidth: 400 }}>
                    {i > 0 ? (
                      <>
                        <DropGap
                          active={dragOverKey === `lead-${i}`}
                          onDragOver={(e) => {
                            e.preventDefault();
                            setDragOverKey(`lead-${i}`);
                          }}
                          onDragLeave={() => setDragOverKey(null)}
                          onDrop={(e) => handleDrop(dropParent, 0, e)}
                          label="Insert here"
                        />
                        <VConnector />
                      </>
                    ) : null}
                    <VNode
                      node={node}
                      selected={selectedId === node.id}
                      dragging={draggingId === node.id}
                      onSelect={() => selectNode(node.id)}
                      onDragStart={(e) => startDrag(e, { source: "tree-node", nodeId: node.id })}
                      onDragEnd={endDrag}
                      onRemove={
                        node.kind !== "select_movement" && lead.length > 1
                          ? () => {
                              apply(removeNode(workflow, node.id));
                              if (selectedId === node.id) setSelectedId(workflow.rootId);
                            }
                          : undefined
                      }
                    />
                  </div>
                );
              })}

              {hub ? (
                <>
                  <VConnector />
                  <div style={{ fontSize: 11, color: "#8a97b0", margin: "8px 0", fontWeight: 700, letterSpacing: 0.2 }}>
                    Movement roots — each branch is its own tree
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexDirection: "row",
                      alignItems: "flex-start",
                      justifyContent: "center",
                      gap: 0,
                      width: "100%",
                      overflowX: "auto",
                      paddingBottom: 8,
                    }}
                  >
                    <DropGap
                      vertical
                      active={dragOverKey === "hub-0"}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOverKey("hub-0");
                      }}
                      onDragLeave={() => setDragOverKey(null)}
                      onDrop={(e) => handleDrop(hub.id, 0, e)}
                      label="Insert"
                    />

                    {movements.map((move, mi) => {
                      const steps = branchSteps(workflow, move.id);
                      return (
                        <div key={move.id} style={{ display: "flex", flexDirection: "row", alignItems: "flex-start" }}>
                          <div style={branchColumn}>
                            <div style={branchRootBadge}>{move.direction ?? "move"} root</div>
                            <div style={{ width: 2, height: 12, background: "#c5d0e4", margin: "0 auto 6px" }} />
                            <VNode
                              node={move}
                              selected={selectedId === move.id}
                              dragging={draggingId === move.id}
                              compact
                              onSelect={() => selectNode(move.id)}
                              onDragStart={(e) => startDrag(e, { source: "tree-node", nodeId: move.id })}
                              onDragEnd={endDrag}
                              onRemove={() => {
                                apply(removeNode(workflow, move.id));
                                if (selectedId === move.id) setSelectedId(hub.id);
                              }}
                            />

                            <DropGap
                              active={dragOverKey === `${move.id}-0`}
                              onDragOver={(e) => {
                                e.preventDefault();
                                setDragOverKey(`${move.id}-0`);
                              }}
                              onDragLeave={() => setDragOverKey(null)}
                              onDrop={(e) => handleDrop(move.id, 0, e)}
                              label="Insert step"
                              compact
                            />

                            {steps.map((sid, si) => {
                              const step = workflow.nodes[sid];
                              if (!step) return null;
                              return (
                                <div key={sid} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
                                  <VConnector short />
                                  <VNode
                                    node={step}
                                    selected={selectedId === step.id}
                                    dragging={draggingId === step.id}
                                    compact
                                    onSelect={() => selectNode(step.id)}
                                    onDragStart={(e) => startDrag(e, { source: "tree-node", nodeId: step.id })}
                                    onDragEnd={endDrag}
                                    onRemove={() => {
                                      apply(removeNode(workflow, step.id));
                                      if (selectedId === step.id) setSelectedId(move.id);
                                    }}
                                  />
                                  <DropGap
                                    active={dragOverKey === `${move.id}-${si + 1}`}
                                    onDragOver={(e) => {
                                      e.preventDefault();
                                      setDragOverKey(`${move.id}-${si + 1}`);
                                    }}
                                    onDragLeave={() => setDragOverKey(null)}
                                    onDrop={(e) => handleDrop(move.id, si + 1, e)}
                                    label="Insert here"
                                    compact
                                  />
                                </div>
                              );
                            })}
                          </div>

                          <DropGap
                            vertical
                            active={dragOverKey === `hub-after-${mi}`}
                            onDragOver={(e) => {
                              e.preventDefault();
                              setDragOverKey(`hub-after-${mi}`);
                            }}
                            onDragLeave={() => setDragOverKey(null)}
                            onDrop={(e) => handleDrop(hub.id, mi + 1, e)}
                            label="Insert"
                          />
                        </div>
                      );
                    })}

                    {!movements.length ? (
                      <div
                        style={emptyDrop}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => handleDrop(hub.id, 0, e)}
                      >
                        Drop a movement here — branches grow side by side
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <aside
            style={{
              borderLeft: "1px solid #f1f4f8",
              background: "#fff",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            <div style={railHeader}>
              {editorOpen ? (
                <span style={{ fontSize: 11, fontWeight: 800, color: "#8a97b0", letterSpacing: 0.5 }}>EDIT NODE</span>
              ) : null}
              <button type="button" style={iconToggleBtn} onClick={() => setEditorOpen((o) => !o)}>
                {editorOpen ? "›" : "‹"}
              </button>
            </div>
            {editorOpen ? (
              <div style={{ flex: 1, overflow: "auto", padding: "4px 14px 18px", minHeight: 0 }}>
                {!selected ? (
                  <div style={{ fontSize: 13, color: "#8a97b0" }}>Click any node on the tree.</div>
                ) : (
                  <EditorPanel
                    node={selected}
                    types={manualTypes}
                    onChange={(patch) => apply(updateNode(workflow, selected.id, patch))}
                    onRemove={
                      selected.kind === "select_movement"
                        ? undefined
                        : () => {
                            apply(removeNode(workflow, selected.id));
                            setSelectedId(workflow.rootId);
                          }
                    }
                  />
                )}
              </div>
            ) : null}
          </aside>
        </div>
      ) : (
        <div style={{ padding: "14px 18px", fontSize: 13, color: "#8a97b0", borderTop: "1px solid #f1f4f8" }}>
          Flowchart minimized — click ▸ above, or open Fullscreen.
        </div>
      )}

      <TelegramPreviewModal open={previewOpen} onClose={() => setPreviewOpen(false)} workflow={workflow} />
    </section>
  );
}

function EditorPanel({
  node,
  types: _types,
  onChange,
  onRemove,
}: {
  node: FlowNode;
  types: MovementTypeRow[];
  onChange: (patch: Partial<FlowNode>) => void;
  onRemove?: () => void;
}) {
  void _types;
  const meta = KIND_META[node.kind] ?? { icon: "•", color: "#64748b", tip: node.kind };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...iconBox, background: `${meta.color}18`, color: meta.color }}>{meta.icon}</span>
        <div>
          <div style={{ fontWeight: 700, color: "#0b1b45", fontSize: 13.5 }}>{node.label}</div>
          <div style={{ fontSize: 11, color: "#98a4bd" }}>{meta.tip}</div>
        </div>
      </div>

      <div>
        <label style={labelStyle}>Label</label>
        <input
          style={inputStyle}
          value={node.label}
          onChange={(e) => {
            const label = e.target.value;
            if (node.question) onChange({ label, question: { ...node.question, label } });
            else onChange({ label });
          }}
        />
      </div>

      {node.kind === "select_movement" ? (
        <div style={{ fontSize: 12, color: "#8a97b0", lineHeight: 1.45 }}>
          Movement types appear as side-by-side branch roots under this node. Drag types from the library onto the gaps between roots.
        </div>
      ) : null}

      {node.kind === "stock_in" || node.kind === "stock_out" ? (
        <div style={{ fontSize: 12, color: "#8a97b0", lineHeight: 1.45 }}>
          Silent Accept-sign function ({node.kind === "stock_in" ? "increase" : "decrease"} stock). Not shown in
          Telegram — the bot skips this step. LOV option effects still override if mapped.
        </div>
      ) : null}

      {node.kind === "question" && node.question ? (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#3a4a68" }}>
            <input
              type="checkbox"
              checked={node.question.required}
              onChange={(e) => onChange({ question: { ...node.question!, required: e.target.checked } })}
            />
            Required
          </label>
          {node.question.type === "select" ? (
            <div>
              <label style={labelStyle}>List options (one per line)</label>
              <textarea
                style={{ ...inputStyle, minHeight: 90, resize: "vertical", fontFamily: "inherit" }}
                value={(node.question.options ?? []).join("\n")}
                onChange={(e) => {
                  const options = e.target.value
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean);
                  const prev = node.question!.optionEffects ?? {};
                  const optionEffects: Record<string, StockOptionEffect> = {};
                  for (const opt of options) {
                    const eff = prev[opt];
                    if (eff === "stock_in" || eff === "stock_out") optionEffects[opt] = eff;
                  }
                  onChange({
                    question: {
                      ...node.question!,
                      options,
                      ...(Object.keys(optionEffects).length ? { optionEffects } : { optionEffects: undefined }),
                    },
                  });
                }}
              />
              <div style={{ fontSize: 11.5, color: "#8a97b0", marginTop: 8, lineHeight: 1.4 }}>
                Map options to stock + / − for adjustments. On Accept, the effect overrides the movement
                direction. Prefer one effect-driving list per branch; if several are set, the last answered wins.
              </div>
              {(node.question.options ?? []).length > 0 ? (
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {(node.question.options ?? []).map((opt) => {
                    const current = node.question!.optionEffects?.[opt] ?? "none";
                    return (
                      <div
                        key={opt}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          flexWrap: "wrap",
                          padding: "8px 10px",
                          background: "#f4f7fb",
                          borderRadius: 10,
                          border: "1px solid #e2e8f0",
                        }}
                      >
                        <div style={{ flex: "1 1 120px", fontSize: 13, fontWeight: 600, color: "#1e293b" }}>{opt}</div>
                        <select
                          style={{ ...inputStyle, margin: 0, minWidth: 180, padding: "6px 10px" }}
                          value={current}
                          onChange={(e) => {
                            const value = e.target.value as StockOptionEffect;
                            const next = { ...(node.question!.optionEffects ?? {}) };
                            if (value === "none") delete next[opt];
                            else next[opt] = value;
                            onChange({
                              question: {
                                ...node.question!,
                                optionEffects: Object.keys(next).length ? next : undefined,
                              },
                            });
                          }}
                        >
                          <option value="none">Default (movement direction)</option>
                          <option value="stock_in">Increase stock (+)</option>
                          <option value="stock_out">Decrease stock (−)</option>
                        </select>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {node.kind !== "stock_in" && node.kind !== "stock_out" ? (
        <>
          <div>
            <label style={labelStyle}>Telegram message</label>
            <textarea
              style={{ ...inputStyle, minHeight: 150, resize: "vertical", fontFamily: "inherit", lineHeight: 1.45 }}
              value={node.message}
              onChange={(e) => onChange({ message: e.target.value })}
            />
            <div style={{ fontSize: 11, color: "#98a4bd", marginTop: 6, lineHeight: 1.4 }}>
              {"{{product}} {{type}} {{unit}} {{qty}} {{where}} {{stock_lines}} {{children}} {{vendor}} {{department}} {{question}}"}
            </div>
          </div>

          <div style={{ background: "#0e1628", borderRadius: 12, padding: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#7dd3fc", marginBottom: 8, letterSpacing: 0.4 }}>LIVE PREVIEW</div>
            <div style={{ color: "#e8eef8", fontSize: 12.5, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>
              {applyMessageTemplate(node.message, {
                product: SAMPLE.product,
                type:
                  node.kind === "pick_department"
                    ? "Department Return"
                    : node.message.toLowerCase().includes("purchasing")
                      ? "New Purchase"
                      : "Vendor Replacement",
                unit: SAMPLE.unit,
                qty: "12",
                where: SAMPLE.where,
                stock_lines: SAMPLE.stockLines,
                children: "Pressure, Conduit",
                vendor: "ABC Vendor",
                department: "Production",
                question: node.kind === "question" ? node.label : "Which plant?",
              })}
            </div>
          </div>
        </>
      ) : null}

      {onRemove ? (
        <button type="button" onClick={onRemove} style={{ ...secondaryBtnStyle, color: "#d63a3a", borderColor: "#f0c4c4" }}>
          Remove from tree
        </button>
      ) : (
        <div style={{ fontSize: 11.5, color: "#98a4bd" }}>Keep at least one node in the workflow.</div>
      )}
    </div>
  );
}

function VNode({
  node,
  selected,
  dragging,
  onSelect,
  onDragStart,
  onDragEnd,
  onRemove,
  compact,
}: {
  node: FlowNode;
  selected: boolean;
  dragging: boolean;
  onSelect: () => void;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
  onRemove?: () => void;
  compact?: boolean;
}) {
  const meta = KIND_META[node.kind] ?? { icon: "•", color: "#64748b", tip: "" };
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      style={{
        width: "100%",
        maxWidth: compact ? 220 : 400,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: compact ? "9px 10px" : "11px 12px",
        borderRadius: 12,
        border: `1.5px solid ${selected ? meta.color : "#d7deea"}`,
        background: dragging ? "#eef3fe" : "#fff",
        boxShadow: selected ? `0 0 0 3px ${meta.color}22` : "0 1px 3px rgba(16,30,54,.06)",
        cursor: "grab",
        opacity: dragging ? 0.55 : 1,
        userSelect: "none",
      }}
    >
      <span title="Drag to move" style={{ color: "#a0aec0", fontSize: 14, letterSpacing: -2, lineHeight: 1 }}>
        ⋮⋮
      </span>
      <span
        style={{
          ...iconBox,
          width: compact ? 24 : 28,
          height: compact ? 24 : 28,
          background: `${meta.color}16`,
          color: meta.color,
        }}
      >
        {meta.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: compact ? 12 : 13, fontWeight: 700, color: "#0b1b45" }}>{node.label}</div>
        <div style={{ fontSize: 10.5, color: "#8a97b0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {node.kind === "movement" && node.direction ? `${node.direction} · ` : ""}
          {node.message.replace(/\s+/g, " ").slice(0, compact ? 28 : 36)}
          {node.message.length > (compact ? 28 : 36) ? "…" : ""}
        </div>
      </div>
      {onRemove ? (
        <button
          type="button"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={{
            border: "none",
            background: "transparent",
            color: "#d63a3a",
            fontWeight: 800,
            fontSize: 16,
            cursor: "pointer",
            padding: "2px 6px",
            lineHeight: 1,
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

function VConnector({ short }: { short?: boolean }) {
  return (
    <div
      style={{
        width: 2,
        height: short ? 10 : 14,
        background: "#c5d0e4",
        borderRadius: 2,
        flexShrink: 0,
      }}
    />
  );
}

function DropGap({
  active,
  onDragOver,
  onDragLeave,
  onDrop,
  label,
  vertical,
  compact,
}: {
  active: boolean;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
  label: string;
  vertical?: boolean;
  compact?: boolean;
}) {
  if (vertical) {
    return (
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          width: active ? 36 : 18,
          minHeight: 120,
          alignSelf: "stretch",
          margin: "0 4px",
          borderRadius: 8,
          border: active ? "1.5px dashed #1560f0" : "1.5px dashed #c5d0e4",
          background: active ? "rgba(21,96,240,.12)" : "rgba(255,255,255,.35)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          writingMode: "vertical-rl",
          transform: "rotate(180deg)",
          color: active ? "#1560f0" : "#9aa8c2",
          fontSize: 10,
          fontWeight: 700,
          flexShrink: 0,
          transition: "width .12s, background .12s",
        }}
      >
        {active ? label : "⟷"}
      </div>
    );
  }
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        width: "100%",
        maxWidth: compact ? 220 : 400,
        height: active ? 40 : 18,
        margin: "2px 0",
        borderRadius: 8,
        border: active ? "1.5px dashed #1560f0" : "1.5px dashed #c5d0e4",
        background: active ? "rgba(21,96,240,.12)" : "rgba(255,255,255,.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "height .12s, background .12s",
        color: active ? "#1560f0" : "#9aa8c2",
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {active ? label : "↓ drop here"}
    </div>
  );
}

function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          border: "none",
          background: "transparent",
          padding: "8px 2px",
          cursor: "pointer",
          fontSize: 10.5,
          fontWeight: 800,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          color: "#aab4c8",
        }}
      >
        <span>{title}</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 11, color: "#98a4bd", marginBottom: 8, lineHeight: 1.35 }}>{children}</div>;
}

function TelegramPreviewModal({
  open,
  onClose,
  workflow,
}: {
  open: boolean;
  onClose: () => void;
  workflow: SearchMoveWorkflow;
}) {
  const [sim, setSim] = useState<PreviewSimState>(() => ({
    ...initialPreviewState(),
    nodeId: workflow.rootId,
  }));
  const [draft, setDraft] = useState("");
  const [log, setLog] = useState<{ who: "bot" | "you"; text: string }[]>([]);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setSim({ ...initialPreviewState(), nodeId: workflow.rootId });
    setDraft("");
    setLog([]);
  }, [open, workflow.rootId]);

  const screen = useMemo(() => previewScreen(workflow, sim), [workflow, sim]);

  useEffect(() => {
    if (!open) return;
    if (log.length === 0) {
      setLog([{ who: "bot", text: stripHtml(screen.text) }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [log, screen.text, sim.qtyDraft, open]);

  function pushLog(who: "bot" | "you", text: string) {
    setLog((prev) => [...prev, { who, text }]);
  }

  function run(action: PreviewButton["action"], value?: string, userLabel?: string) {
    if (userLabel) pushLog("you", userLabel);
    const next = applyPreviewAction(workflow, sim, action, value);
    setSim(next);
    setDraft("");
    if (action === "qty_digit" || action === "qty_del") return;
    const nextScreen = previewScreen(workflow, next);
    pushLog("bot", stripHtml(nextScreen.text));
  }

  function submitInput() {
    const text = draft.trim();
    if (!text) return;
    if (screen.input?.kind === "search") {
      run("next", text, text);
      return;
    }
    run("answer", text, text);
  }

  function reset() {
    setSim({ ...initialPreviewState(), nodeId: workflow.rootId });
    setLog([]);
    setDraft("");
  }

  if (!open) return null;

  const qtyPad = screen.buttons.filter((b) => b.action === "qty_digit" || b.action === "qty_del");
  const otherBtns = screen.buttons.filter((b) => b.action !== "qty_digit" && b.action !== "qty_del");

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 13000,
        background: "rgba(8, 14, 28, 0.72)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "12px 16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px, 100%)",
          height: "min(860px, 96vh)",
          display: "flex",
          flexDirection: "column",
          borderRadius: 20,
          overflow: "hidden",
          boxShadow: "0 28px 80px rgba(0,0,0,.45)",
          background: "#0e1621",
          border: "1px solid rgba(255,255,255,.08)",
        }}
      >
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            background: "#17212b",
            borderBottom: "1px solid rgba(255,255,255,.06)",
          }}
        >
          <button type="button" onClick={onClose} style={tgChromeBtn}>
            ← Back
          </button>
          <div style={{ flex: 1, fontSize: 13, color: "#8b9bb4", fontWeight: 600 }}>Preview · your flowchart</div>
          <button type="button" onClick={reset} style={tgChromeBtn}>
            ↺ Reset
          </button>
        </div>

        <div
          style={{
            flexShrink: 0,
            padding: "12px 14px",
            background: "#17212b",
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
          }}
        >
          Search group
          <div style={{ fontSize: 11, fontWeight: 500, color: "#8b9bb4", marginTop: 2 }}>{screen.title}</div>
        </div>

        <div ref={chatRef} style={{ flex: 1, overflow: "auto", padding: "14px 12px", background: "#0e1621" }}>
          {log.map((row, i) => (
            <div
              key={`${i}-${row.who}`}
              style={{
                display: "flex",
                justifyContent: row.who === "you" ? "flex-end" : "flex-start",
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  maxWidth: "88%",
                  padding: "9px 12px",
                  borderRadius: row.who === "you" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                  background: row.who === "you" ? "#2b5278" : "#182533",
                  color: "#e8eef8",
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.45,
                }}
              >
                {row.text}
              </div>
            </div>
          ))}
        </div>

        <div style={{ flexShrink: 0, padding: "10px 12px 14px", background: "#17212b", borderTop: "1px solid rgba(255,255,255,.06)" }}>
          {qtyPad.length ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 6,
                marginBottom: 8,
              }}
            >
              {qtyPad.map((b, i) => (
                <button key={`${b.label}-${i}`} type="button" style={tgBtn} onClick={() => run(b.action, b.value, b.label)}>
                  {b.label}
                </button>
              ))}
            </div>
          ) : null}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {otherBtns.map((b, i) => (
              <button key={`${b.label}-${i}`} type="button" style={tgBtn} onClick={() => run(b.action, b.value, b.label)}>
                {b.label}
              </button>
            ))}
          </div>
          {screen.input ? (
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitInput();
                }}
                placeholder={screen.input.placeholder}
                style={{
                  flex: 1,
                  borderRadius: 10,
                  border: "1px solid #2b3a4d",
                  background: "#242f3d",
                  color: "#fff",
                  padding: "10px 12px",
                  fontSize: 13,
                }}
              />
              <button type="button" style={{ ...tgBtn, minWidth: 64 }} onClick={submitInput}>
                Send
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

const panelStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #e6ebf2",
  borderRadius: 14,
  overflow: "hidden",
  boxShadow: "0 1px 2px rgba(16,30,54,.04)",
};

const headerRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  padding: "14px 18px",
  borderBottom: "1px solid #f1f4f8",
  flexWrap: "wrap",
};

const railHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 10px 6px",
  flexShrink: 0,
  minHeight: 40,
};

const iconToggleBtn: CSSProperties = {
  border: "1px solid #e2e8f0",
  background: "#fff",
  borderRadius: 8,
  width: 28,
  height: 28,
  cursor: "pointer",
  color: "#4a5a78",
  fontSize: 14,
  fontWeight: 700,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const chipDrag: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  marginBottom: 6,
  borderRadius: 10,
  border: "1px solid #e2e8f0",
  background: "#fff",
  cursor: "grab",
  fontSize: 12.5,
};

const iconBox: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 800,
  fontSize: 13,
  flexShrink: 0,
};

const branchColumn: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  width: 240,
  flexShrink: 0,
  padding: "0 4px",
};

const branchRootBadge: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "#7c8aa5",
  background: "#eef2f8",
  borderRadius: 999,
  padding: "3px 10px",
  marginBottom: 2,
};

const emptyDrop: CSSProperties = {
  minWidth: 220,
  minHeight: 100,
  margin: "8px 12px",
  borderRadius: 12,
  border: "1.5px dashed #c5d0e4",
  background: "rgba(255,255,255,.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  textAlign: "center",
  fontSize: 12.5,
  color: "#8a97b0",
  fontWeight: 600,
};

const tgChromeBtn: CSSProperties = {
  border: "none",
  background: "#242f3d",
  color: "#c5d0e0",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const tgBtn: CSSProperties = {
  border: "none",
  background: "#2b5278",
  color: "#fff",
  borderRadius: 10,
  padding: "10px 12px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  textAlign: "center",
};
