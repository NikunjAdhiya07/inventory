"use client";

import { useEffect, useState } from "react";
import PageShell from "@/components/page-shell";
import { api } from "@/lib/api-client";
import {
  PageIntro,
  EmptyState,
  Modal,
  ModalHeader,
  ModalFooter,
  tdStyle,
  thStyle,
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

type ConfigField = { key: string; label: string; type: "text" | "toggle" | "select" | "number" | "dataSource"; default?: unknown; options?: string[]; appliesToDataSource?: string };
type StepLibEntry = { id: string; type: string; name: string; desc: string; icon: string; category: string; configSchema: ConfigField[] };
type StepInstance = { instanceId: string; type: string; label: string; required: boolean; order: number; config: Record<string, unknown> };
type Workflow = { id: string; name: string; desc: string; status: "Draft" | "Active"; version: number; isDefault: boolean; steps: StepInstance[] };
type Assignment = { id: string; scope: "group" | "category"; chatId?: string; category?: string };
type Group = { id: string; chatId: string; title: string; status: string };
type Named = { id: string; name: string };
type Version = { id: string; version: number; name: string; steps: StepInstance[]; createdAt: string; createdBy: string };

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [lib, setLib] = useState<StepLibEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Reference lists for config + assignment dropdowns.
  const [categories, setCategories] = useState<Named[]>([]);
  const [units, setUnits] = useState<Named[]>([]);
  const [locations, setLocations] = useState<Named[]>([]);
  const [roles, setRoles] = useState<Named[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  // Builder state.
  const [builder, setBuilder] = useState<Workflow | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [configStep, setConfigStep] = useState<StepInstance | null>(null);

  // Assign / versions / delete state.
  const [assignWf, setAssignWf] = useState<Workflow | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [assignScope, setAssignScope] = useState<"group" | "category">("group");
  const [assignValue, setAssignValue] = useState("");
  const [versionsWf, setVersionsWf] = useState<Workflow | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [delId, setDelId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get<Workflow[]>("/api/workflows"), api.get<StepLibEntry[]>("/api/step-library")])
      .then(([wf, sl]) => {
        if (cancelled) return;
        setWorkflows(wf);
        setLib(sl);
      })
      .finally(() => !cancelled && setLoading(false));
    // Reference data for dropdowns.
    api.get<Named[]>("/api/categories").then((d) => !cancelled && setCategories(d));
    api.get<Named[]>("/api/units").then((d) => !cancelled && setUnits(d));
    api.get<Named[]>("/api/locations").then((d) => !cancelled && setLocations(d));
    api.get<Named[]>("/api/roles").then((d) => !cancelled && setRoles(d));
    api.get<Group[]>("/api/telegram-groups").then((d) => !cancelled && setGroups(d));
    return () => {
      cancelled = true;
    };
  }, []);

  function namedList(source?: string): Named[] {
    if (source === "categories") return categories;
    if (source === "units") return units;
    if (source === "locations") return locations;
    if (source === "roles") return roles;
    return [];
  }

  // ---------------- create ----------------
  async function createWorkflow() {
    if (!newName.trim()) return;
    const created = await api.post<Workflow>("/api/workflows", { name: newName.trim() });
    setWorkflows((prev) => [created, ...prev]);
    setCreateOpen(false);
    setNewName("");
    setBuilder({ ...created, steps: created.steps || [] });
  }

  // ---------------- builder ----------------
  function addStep(entry: StepLibEntry) {
    if (!builder) return;
    const config: Record<string, unknown> = {};
    for (const f of entry.configSchema) config[f.key] = f.default;
    const step: StepInstance = {
      instanceId: crypto.randomUUID(),
      type: entry.type,
      label: defaultLabel(entry),
      required: true,
      order: builder.steps.length + 1,
      config,
    };
    setBuilder({ ...builder, steps: [...builder.steps, step] });
  }

  function updateStep(instanceId: string, patch: Partial<StepInstance>) {
    if (!builder) return;
    setBuilder({ ...builder, steps: builder.steps.map((s) => (s.instanceId === instanceId ? { ...s, ...patch } : s)) });
  }

  function removeStep(instanceId: string) {
    if (!builder) return;
    setBuilder({ ...builder, steps: builder.steps.filter((s) => s.instanceId !== instanceId).map((s, i) => ({ ...s, order: i + 1 })) });
  }

  function reorderSteps(targetId: string) {
    if (!builder || !dragId) return;
    const arr = [...builder.steps];
    const from = arr.findIndex((s) => s.instanceId === dragId);
    const to = arr.findIndex((s) => s.instanceId === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const [m] = arr.splice(from, 1);
    arr.splice(to, 0, m);
    arr.forEach((s, i) => (s.order = i + 1));
    setBuilder({ ...builder, steps: arr });
    setDragId(null);
  }

  async function saveBuilder(): Promise<Workflow | null> {
    if (!builder) return null;
    const updated = await api.patch<Workflow>(`/api/workflows/${builder.id}`, { name: builder.name, desc: builder.desc, steps: builder.steps });
    setWorkflows((prev) => prev.map((w) => (w.id === builder.id ? updated : w)));
    setBuilder(updated.steps ? { ...updated } : updated);
    return updated;
  }

  async function activateBuilder() {
    if (!builder) return;
    if (builder.steps.length === 0) return;
    await saveBuilder();
    try {
      const activated = await api.post<Workflow>(`/api/workflows/${builder.id}/activate`, { setDefault: builder.isDefault });
      setWorkflows((prev) => prev.map((w) => (w.id === builder.id ? activated : w)));
      setBuilder(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Activation failed");
    }
  }

  // ---------------- assignments ----------------
  async function openAssign(wf: Workflow) {
    setAssignWf(wf);
    setAssignScope("group");
    setAssignValue("");
    const list = await api.get<Assignment[]>(`/api/workflows/${wf.id}/assignments`);
    setAssignments(list);
  }
  async function addAssignment() {
    if (!assignWf || !assignValue) return;
    const body = assignScope === "group" ? { scope: "group", chatId: assignValue } : { scope: "category", category: assignValue };
    const created = await api.post<Assignment>(`/api/workflows/${assignWf.id}/assignments`, body);
    setAssignments((prev) => [...prev, created]);
    setAssignValue("");
  }
  async function removeAssignment(a: Assignment) {
    if (!assignWf) return;
    setAssignments((prev) => prev.filter((x) => x.id !== a.id));
    await api.del(`/api/workflows/${assignWf.id}/assignments?assignmentId=${a.id}`);
  }

  // ---------------- versions ----------------
  async function openVersions(wf: Workflow) {
    setVersionsWf(wf);
    const list = await api.get<Version[]>(`/api/workflows/${wf.id}/versions`);
    setVersions(list);
  }

  async function doDelete() {
    const id = delId;
    setDelId(null);
    setWorkflows((prev) => prev.filter((w) => w.id !== id));
    if (id) await api.del(`/api/workflows/${id}`);
  }

  const activeCount = workflows.filter((w) => w.status === "Active").length;

  return (
    <PageShell section="Automation" page="Workflows" maxWidth={1320}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <PageIntro title="Workflows" description="Design the bot's inventory-entry conversation: pick steps, order them, set rules, and assign each workflow to a group or category." />
        <button onClick={() => setCreateOpen(true)} style={addBtnStyle}>
          ＋ New Workflow
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginBottom: 22 }}>
        <Stat label="Total Workflows" value={workflows.length} />
        <Stat label="Active" value={activeCount} color="#0f9d63" />
        <Stat label="Step Types Available" value={lib.length} />
      </div>

      <section style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(16,30,54,.04)" }}>
        <div style={{ padding: "15px 18px", borderBottom: "1px solid #f1f4f8", fontSize: 14, fontWeight: 700, color: "#0b1b45" }}>All workflows</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafbfd", color: "#8a97b0", textAlign: "left" }}>
              <th style={thStyle("16px")}>Workflow</th>
              <th style={{ ...thStyle(), textAlign: "center" }}>Steps</th>
              <th style={{ ...thStyle(), textAlign: "center" }}>Version</th>
              <th style={thStyle()}>Status</th>
              <th style={{ ...thStyle(), textAlign: "right", padding: "11px 16px 11px 14px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {workflows.map((w) => (
              <tr key={w.id}>
                <td style={tdStyle("16px")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <div style={{ fontWeight: 600, color: "#1a2b4a" }}>{w.name}</div>
                    {w.isDefault ? <span style={{ fontSize: 10.5, fontWeight: 700, background: "#eaf2ff", color: "#1560f0", borderRadius: 20, padding: "1px 8px" }}>DEFAULT</span> : null}
                  </div>
                  {w.desc ? <div style={{ fontSize: 11.5, color: "#98a4bd", marginTop: 2, maxWidth: 460, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.desc}</div> : null}
                </td>
                <td style={{ ...tdStyle(), textAlign: "center", color: "#4a5878" }}>{w.steps?.length ?? 0}</td>
                <td style={{ ...tdStyle(), textAlign: "center", color: "#8a97b0", fontFamily: "var(--font-mono)" }}>v{w.version}</td>
                <td style={tdStyle()}>
                  <span style={chipStyle(w.status === "Active")}>{w.status}</span>
                </td>
                <td style={{ ...tdStyle(), padding: "12px 16px 12px 14px" }}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                    <button onClick={() => setBuilder({ ...w, steps: w.steps || [] })} style={actionBtnStyle("#1560f0", "#cfe0ff")}>
                      Build
                    </button>
                    <button onClick={() => openAssign(w)} style={actionBtnStyle("#0d9488", "#bfe6e1")}>
                      Assign
                    </button>
                    <button onClick={() => openVersions(w)} style={actionBtnStyle("#3a4a68", "#dfe5ee")}>
                      Versions
                    </button>
                    <button onClick={() => setDelId(w.id)} style={actionBtnStyle("#d63a3a", "#f4d0d0")}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && workflows.length === 0 ? <EmptyState text="No workflows yet. Create one to design your first bot flow." /> : null}
        {loading ? <EmptyState text="Loading…" /> : null}
      </section>

      {/* Create */}
      {createOpen ? (
        <Modal onClose={() => setCreateOpen(false)} maxWidth={460}>
          <ModalHeader title="New Workflow" subtitle="Give it a name — you'll add steps next." onClose={() => setCreateOpen(false)} />
          <div style={{ padding: "22px 24px" }}>
            <label style={labelStyle}>
              Workflow Name <span style={{ color: "#e0524f" }}>*</span>
            </label>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. High-Value Item Entry" style={inputStyle} autoFocus />
          </div>
          <ModalFooter>
            <button onClick={() => setCreateOpen(false)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={createWorkflow} style={primaryBtnStyle}>
              Create & Build
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {/* Builder */}
      {builder ? (
        <Modal onClose={() => setBuilder(null)} maxWidth={960}>
          <ModalHeader title={`Build — ${builder.name}`} subtitle="Add steps from the library, drag to reorder, set rules, then activate." onClose={() => setBuilder(null)} />
          <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 0, minHeight: 420 }}>
            {/* Palette */}
            <div style={{ borderRight: "1px solid #f1f4f8", padding: "16px 14px", background: "#fafbfd", maxHeight: 560, overflowY: "auto" }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", color: "#aab4c8", marginBottom: 10 }}>Step Library</div>
              {lib.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => addStep(entry)}
                  style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", padding: "9px 10px", marginBottom: 6, border: "1px solid #e9edf3", borderRadius: 9, background: "#fff", cursor: "pointer" }}
                  title={entry.desc}
                >
                  <span style={{ fontSize: 15, width: 20, textAlign: "center" }}>{entry.icon}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "#1a2b4a" }}>{entry.name}</span>
                  <span style={{ marginLeft: "auto", color: "#1560f0", fontWeight: 800 }}>＋</span>
                </button>
              ))}
            </div>

            {/* Steps */}
            <div style={{ padding: "16px 20px", maxHeight: 560, overflowY: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", color: "#aab4c8" }}>Conversation Steps ({builder.steps.length})</div>
                {builder.isDefault ? <span style={{ fontSize: 10.5, fontWeight: 700, background: "#eaf2ff", color: "#1560f0", borderRadius: 20, padding: "1px 8px" }}>DEFAULT</span> : null}
              </div>
              {builder.steps.length === 0 ? (
                <div style={{ padding: "40px 0", textAlign: "center", color: "#98a4bd", fontSize: 13 }}>Add steps from the library on the left. Back navigation between steps is automatic.</div>
              ) : (
                builder.steps.map((s, i) => {
                  const entry = lib.find((l) => l.type === s.type);
                  return (
                    <div
                      key={s.instanceId}
                      draggable
                      onDragStart={() => setDragId(s.instanceId)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => reorderSteps(s.instanceId)}
                      onDragEnd={() => setDragId(null)}
                      style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 12px", marginBottom: 8, border: "1px solid #e9edf3", borderRadius: 10, background: dragId === s.instanceId ? "#eef4ff" : "#fff" }}
                    >
                      <span style={{ cursor: "grab", color: "#c4ccda", fontSize: 15 }}>⠿</span>
                      <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "#c4ccda", width: 16 }}>{i + 1}</span>
                      <span style={{ fontSize: 15, width: 20, textAlign: "center" }}>{entry?.icon ?? "▪"}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#1a2b4a" }}>{entry?.name ?? s.type}</div>
                        <div style={{ fontSize: 11.5, color: "#98a4bd", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</div>
                      </div>
                      <button
                        onClick={() => updateStep(s.instanceId, { required: !s.required })}
                        style={{ ...chipStyle(s.required), background: s.required ? "#eef4ff" : "#f4f6f9", color: s.required ? "#1560f0" : "#8a97b0", border: `1px solid ${s.required ? "#cfe0ff" : "#e4e9f0"}` }}
                        title="Toggle required / optional"
                      >
                        {s.required ? "Required" : "Optional"}
                      </button>
                      <button onClick={() => setConfigStep(s)} style={actionBtnStyle("#3a4a68", "#dfe5ee")} title="Configure">
                        ⚙
                      </button>
                      <button onClick={() => removeStep(s.instanceId)} style={actionBtnStyle("#d63a3a", "#f4d0d0")} title="Remove">
                        ✕
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <ModalFooter>
            <button onClick={() => setBuilder(null)} style={secondaryBtnStyle}>
              Close
            </button>
            <button onClick={saveBuilder} style={{ ...secondaryBtnStyle, borderColor: "#cfe0ff", color: "#1560f0" }}>
              Save Draft
            </button>
            <button onClick={activateBuilder} style={primaryBtnStyle} title="Save + publish a new version">
              Save & Activate
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {/* Step config */}
      {configStep && builder ? (
        <StepConfigModal
          step={configStep}
          entry={lib.find((l) => l.type === configStep.type)}
          namedList={namedList}
          onClose={() => setConfigStep(null)}
          onSave={(patch) => {
            updateStep(configStep.instanceId, patch);
            setConfigStep(null);
          }}
        />
      ) : null}

      {/* Assign */}
      {assignWf ? (
        <Modal onClose={() => setAssignWf(null)} maxWidth={560}>
          <ModalHeader title={`Assign — ${assignWf.name}`} subtitle="Entries started in an assigned group follow this workflow. An Active workflow with no assignment simply isn't used yet." onClose={() => setAssignWf(null)} />
          <div style={{ padding: "18px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            {assignments.length === 0 ? (
              <div style={{ padding: "10px 0", color: "#98a4bd", fontSize: 13 }}>No assignments yet.</div>
            ) : (
              <div style={{ border: "1px solid #eef1f6", borderRadius: 12, overflow: "hidden" }}>
                {assignments.map((a, i) => (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderTop: i === 0 ? "none" : "1px solid #f1f4f8" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: a.scope === "group" ? "#1560f0" : "#0d9488", background: a.scope === "group" ? "#eaf2ff" : "#e5f5f2", borderRadius: 6, padding: "2px 8px" }}>{a.scope}</span>
                    <span style={{ flex: 1, fontSize: 13, color: "#1a2b4a", fontFamily: a.scope === "group" ? "var(--font-mono)" : undefined }}>
                      {a.scope === "group" ? groups.find((g) => g.chatId === a.chatId)?.title ?? a.chatId : a.category}
                    </span>
                    <button onClick={() => removeAssignment(a)} style={actionBtnStyle("#d63a3a", "#f4d0d0")}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ border: "1px solid #eef2f7", borderRadius: 11, padding: 14, background: "#f8fafd", display: "flex", gap: 10, alignItems: "flex-end" }}>
              <div>
                <label style={labelStyle}>Scope</label>
                <select value={assignScope} onChange={(e) => { setAssignScope(e.target.value as "group" | "category"); setAssignValue(""); }} style={{ ...inputStyle, background: "#fff", width: 130 }}>
                  <option value="group">Group</option>
                  <option value="category">Category</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>{assignScope === "group" ? "Telegram group" : "Category"}</label>
                <select value={assignValue} onChange={(e) => setAssignValue(e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                  <option value="">Select…</option>
                  {assignScope === "group"
                    ? groups.map((g) => (
                        <option key={g.id} value={g.chatId}>
                          {g.title}
                        </option>
                      ))
                    : categories.map((c) => (
                        <option key={c.id} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                </select>
              </div>
              <button onClick={addAssignment} style={primaryBtnStyle} disabled={!assignValue}>
                Add
              </button>
            </div>
          </div>
          <ModalFooter>
            <button onClick={() => setAssignWf(null)} style={secondaryBtnStyle}>
              Done
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {/* Versions */}
      {versionsWf ? (
        <Modal onClose={() => setVersionsWf(null)} maxWidth={560}>
          <ModalHeader title={`Versions — ${versionsWf.name}`} subtitle="Each activation captures an immutable snapshot. In-progress entries keep running the version they started on." onClose={() => setVersionsWf(null)} />
          <div style={{ padding: "18px 24px" }}>
            {versions.length === 0 ? (
              <div style={{ color: "#98a4bd", fontSize: 13 }}>No published versions yet. Activate the workflow to create version 1.</div>
            ) : (
              <div style={{ border: "1px solid #eef1f6", borderRadius: 12, overflow: "hidden" }}>
                {versions.map((v, i) => (
                  <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderTop: i === 0 ? "none" : "1px solid #f1f4f8" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "#1560f0" }}>v{v.version}</span>
                    <span style={{ flex: 1, fontSize: 12.5, color: "#4a5878" }}>{v.steps.length} steps · {v.createdBy}</span>
                    <span style={{ fontSize: 11.5, color: "#98a4bd" }}>{new Date(v.createdAt).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <ModalFooter>
            <button onClick={() => setVersionsWf(null)} style={secondaryBtnStyle}>
              Close
            </button>
          </ModalFooter>
        </Modal>
      ) : null}

      {/* Delete */}
      {delId ? (
        <Modal onClose={() => setDelId(null)} maxWidth={420} align="center">
          <div style={{ padding: 24 }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: "#fdecec", color: "#d63a3a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 14 }}>
              🗑
            </div>
            <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#0b1b45" }}>Delete this workflow?</h3>
            <p style={{ margin: 0, fontSize: 13.5, color: "#67748e", lineHeight: 1.55 }}>It moves to the recycle bin and its assignments are removed. In-progress entries already running a pinned version are unaffected.</p>
          </div>
          <ModalFooter>
            <button onClick={() => setDelId(null)} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button onClick={doDelete} style={{ ...primaryBtnStyle, background: "#d63a3a" }}>
              Delete
            </button>
          </ModalFooter>
        </Modal>
      ) : null}
    </PageShell>
  );
}

function defaultLabel(entry: StepLibEntry): string {
  const map: Record<string, string> = {
    item_capture: "Send the item name and/or a photo of the product.",
    category_select: "Select a category:",
    subcategory_select: "Select a subcategory:",
    location_tree: "Choose the storage location:",
    quantity: "Enter the quantity:",
    unit_select: "Select a unit:",
    custom_text: "Enter a value:",
    custom_number: "Enter a number:",
    approval: "This entry needs approval.",
    review_confirm: "Please review your entry:",
  };
  return map[entry.type] ?? `${entry.name}:`;
}

function Stat({ label, value, color = "#0b1b45" }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e9edf3", borderRadius: 13, padding: "18px 20px" }}>
      <div style={{ fontSize: 12.5, color: "#8a97b0", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color, letterSpacing: "-.5px", marginTop: 4 }}>{value}</div>
    </div>
  );
}

function StepConfigModal({
  step,
  entry,
  namedList,
  onClose,
  onSave,
}: {
  step: StepInstance;
  entry?: StepLibEntry;
  namedList: (source?: string) => Named[];
  onClose: () => void;
  onSave: (patch: Partial<StepInstance>) => void;
}) {
  const [label, setLabel] = useState(step.label);
  const [config, setConfig] = useState<Record<string, unknown>>({ ...step.config });
  const schema = entry?.configSchema ?? [];

  function setC(key: string, value: unknown) {
    setConfig((c) => ({ ...c, [key]: value }));
  }

  return (
    <Modal onClose={onClose} maxWidth={480}>
      <ModalHeader title={`Configure — ${entry?.name ?? step.type}`} subtitle="The prompt is what the bot shows the user at this step." onClose={onClose} />
      <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <label style={labelStyle}>Prompt / label</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} />
        </div>
        {schema.map((f) => {
          const val = config[f.key];
          if (f.type === "toggle") {
            const on = Boolean(val);
            return (
              <div key={f.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <label style={{ fontSize: 12.5, fontWeight: 600, color: "#3a4a68" }}>{f.label}</label>
                <button onClick={() => setC(f.key, !on)} style={toggleStyle(on)}>
                  <span style={toggleKnobStyle(on)} />
                </button>
              </div>
            );
          }
          if (f.type === "number") {
            return (
              <div key={f.key}>
                <label style={labelStyle}>{f.label}</label>
                <input type="number" value={val === undefined ? "" : String(val)} onChange={(e) => setC(f.key, Number(e.target.value))} style={inputStyle} />
              </div>
            );
          }
          if (f.type === "select" || f.type === "dataSource") {
            const options = f.options ?? namedList(f.appliesToDataSource ?? (f.type === "dataSource" ? String(f.default) : undefined)).map((n) => n.name);
            return (
              <div key={f.key}>
                <label style={labelStyle}>{f.label}</label>
                <select value={val === undefined ? "" : String(val)} onChange={(e) => setC(f.key, e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                  {f.type === "dataSource" && f.default ? <option value={String(f.default)}>{String(f.default)}</option> : <option value="">Select…</option>}
                  {options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
            );
          }
          return (
            <div key={f.key}>
              <label style={labelStyle}>{f.label}</label>
              <input value={val === undefined ? "" : String(val)} onChange={(e) => setC(f.key, e.target.value)} style={inputStyle} />
            </div>
          );
        })}
      </div>
      <ModalFooter>
        <button onClick={onClose} style={secondaryBtnStyle}>
          Cancel
        </button>
        <button onClick={() => onSave({ label, config })} style={primaryBtnStyle}>
          Save Step
        </button>
      </ModalFooter>
    </Modal>
  );
}
