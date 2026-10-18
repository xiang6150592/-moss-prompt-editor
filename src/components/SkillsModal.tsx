import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Skill, SkillKind, SkillsState } from "../types";
import * as api from "../api";

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged: (state: SkillsState) => void;
  initialKind?: SkillKind;
}

const KIND_LABEL: Record<SkillKind, string> = {
  caption: "Caption",
  layout: "Layout",
  context: "上下文 Context",
};

const KINDS: SkillKind[] = ["caption", "layout", "context"];

export default function SkillsModal({ open, onClose, onChanged, initialKind }: Props) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [active, setActive] = useState<SkillsState["active"]>({
    caption: "official-caption",
    layout: "official-layout",
    context: "official-context",
  });
  const [selectedId, setSelectedId] = useState<string>("");
  const [filterKind, setFilterKind] = useState<SkillKind>(initialKind || "caption");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("");

  const selected = useMemo(
    () => skills.find((s) => s.id === selectedId) || null,
    [skills, selectedId],
  );

  const grouped = useMemo(() => {
    const g: Record<SkillKind, Skill[]> = { caption: [], layout: [], context: [] };
    for (const s of skills) {
      if (g[s.kind]) g[s.kind].push(s);
    }
    return g;
  }, [skills]);

  const applyState = (state: SkillsState, preferId?: string, preferKind?: SkillKind) => {
    setSkills(state.skills);
    setActive(state.active);
    onChanged(state);
    const kind = preferKind || filterKind;
    const list = state.skills.filter((s) => s.kind === kind);
    const id =
      preferId ||
      (list.some((s) => s.id === selectedId) ? selectedId : null) ||
      state.active[kind] ||
      list[0]?.id ||
      "";
    setSelectedId(id);
    const cur = state.skills.find((s) => s.id === id);
    if (cur) {
      setName(cur.name);
      setDescription(cur.description || "");
      setSystemPrompt(cur.system_prompt);
      setFilterKind(cur.kind);
    }
  };

  const load = async () => {
    setErr("");
    try {
      const state = await api.listSkills();
      applyState(state, undefined, initialKind || filterKind);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!open) return;
    setStatus("");
    setErr("");
    if (initialKind) setFilterKind(initialKind);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialKind]);

  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setDescription(selected.description || "");
    setSystemPrompt(selected.system_prompt);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const selectSkill = (s: Skill) => {
    setSelectedId(s.id);
    setFilterKind(s.kind);
    setName(s.name);
    setDescription(s.description || "");
    setSystemPrompt(s.system_prompt);
    setErr("");
    setStatus("");
  };

  const createNew = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.createSkill({
        name: `自定义 ${KIND_LABEL[filterKind]}`,
        kind: filterKind,
        description: "",
        system_prompt:
          selected && selected.kind === filterKind
            ? selected.system_prompt
            : `你是 MOSS-Image ${filterKind} 助手。按用户要求输出。`,
      });
      applyState(
        { skills: r.skills, active: r.active },
        r.skill.id,
        r.skill.kind,
      );
      setStatus("已新建自定义 Skill");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!selected) return;
    setBusy(true);
    setErr("");
    try {
      const body: { name?: string; description?: string; system_prompt?: string } = {
        name: name.trim(),
        description,
      };
      if (!selected.builtin) body.system_prompt = systemPrompt;
      const r = await api.updateSkill(selected.id, body);
      applyState(
        { skills: r.skills, active: r.active },
        r.skill.id,
        r.skill.kind,
      );
      setStatus(selected.builtin ? "已保存名称/描述（内置提示词请用重置）" : "已保存");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setAsActive = async () => {
    if (!selected) return;
    setBusy(true);
    setErr("");
    try {
      const state = await api.setActiveSkill(selected.kind, selected.id);
      applyState(state, selected.id, selected.kind);
      setStatus(`已设为当前 ${KIND_LABEL[selected.kind]} Skill`);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doDuplicate = async () => {
    if (!selected) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api.duplicateSkill(selected.id);
      applyState(
        { skills: r.skills, active: r.active },
        r.skill.id,
        r.skill.kind,
      );
      setStatus("已复制为自定义 Skill");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doReset = async () => {
    if (!selected?.builtin) return;
    if (!confirm("重置为官方原文？名称与 system_prompt 都会恢复。")) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api.resetSkill(selected.id);
      applyState(
        { skills: r.skills, active: r.active },
        r.skill.id,
        r.skill.kind,
      );
      setStatus("已重置为官方原文");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!selected || selected.builtin) return;
    if (!confirm(`删除「${selected.name}」？`)) return;
    setBusy(true);
    setErr("");
    try {
      const state = await api.deleteSkill(selected.id);
      applyState(state, state.active[filterKind], filterKind);
      setStatus("已删除");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Skills 管理</h2>
        <p className="hint">
          官方模板为默认内置（不可删）。可新建/复制自定义 Skill，并按 Caption / Layout / Context
          分别设为当前使用。
        </p>
        <div className="skills-layout">
          <aside className="skills-list">
            <div className="tabs" style={{ marginBottom: 8 }}>
              {KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={filterKind === k ? "active" : ""}
                  onClick={() => {
                    setFilterKind(k);
                    const list = grouped[k];
                    const prefer = active[k];
                    const hit = list.find((s) => s.id === prefer) || list[0];
                    if (hit) selectSkill(hit);
                  }}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
            {grouped[filterKind].map((s) => {
              const isActive = active[s.kind] === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`skill-item ${selectedId === s.id ? "selected" : ""}`}
                  onClick={() => selectSkill(s)}
                >
                  <div className="t">
                    {s.name}
                    {s.builtin && <span className="badge">官方</span>}
                    {isActive && <span className="badge ok">当前</span>}
                  </div>
                  <div className="m">{s.description || s.id}</div>
                </button>
              );
            })}
            <button type="button" className="primary" disabled={busy} onClick={createNew}>
              + 新建自定义
            </button>
          </aside>
          <div className="skills-editor">
            {selected ? (
              <>
                <div className="field">
                  <label>名称</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="field">
                  <label>说明</label>
                  <input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="简短描述用途"
                  />
                </div>
                <div className="field">
                  <label>
                    System Prompt
                    {selected.builtin && (
                      <span className="hint"> · 内置只读，复制后可改，或点重置恢复官方</span>
                    )}
                  </label>
                  <textarea
                    className="skill-prompt"
                    value={systemPrompt}
                    readOnly={!!selected.builtin}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                  />
                </div>
                <div className="row-actions">
                  <button type="button" className="primary" disabled={busy} onClick={setAsActive}>
                    设为当前
                  </button>
                  <button type="button" disabled={busy} onClick={saveEdit}>
                    保存
                  </button>
                  <button type="button" disabled={busy} onClick={doDuplicate}>
                    复制
                  </button>
                  {selected.builtin ? (
                    <button type="button" disabled={busy} onClick={doReset}>
                      重置官方
                    </button>
                  ) : (
                    <button type="button" className="danger" disabled={busy} onClick={doDelete}>
                      删除
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p className="hint">请选择左侧 Skill</p>
            )}
            {status && <div className="ok-msg" style={{ marginTop: 10 }}>{status}</div>}
            {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
