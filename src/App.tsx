import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Canvas from "./components/Canvas";
import LayerPanel from "./components/LayerPanel";
import PerspectiveBar from "./components/PerspectiveBar";
import {
  alignToPerspective,
  detectFromImage,
  estimateFromBoxes,
  type BBox,
  type Segment,
} from "./lib/perspective";
import HistoryPanel from "./components/HistoryPanel";
import SettingsModal from "./components/SettingsModal";
import ReverseModal from "./components/ReverseModal";
import SkillsModal from "./components/SkillsModal";
import * as api from "./api";
import {
  DEFAULT_TEMPLATES,
  emptyCaption,
  emptyLayout,
  isLayoutDraft,
  mergeEditorMeta,
  newItemId,
  normalizeLayout,
  snap16,
  BOX_COLORS,
  type DepthTier,
  type PerspectiveSettings,
  type PromptOptions,
  type AppSettings,
  type CaptionDraft,
  type ChatMessage,
  type Draft,
  type EditorMode,
  type HistoryRecord,
  type ItemLabel,
  type LayoutDraft,
  type LayoutItem,
  type ResolutionTemplate,
  type Skill,
  type SkillsState,
} from "./types";

const LS_TEMPLATES = "moss-prompt-editor-templates";
const LS_HISTORY = "moss-prompt-editor-history-cache";

function loadTemplates(): ResolutionTemplate[] {
  try {
    const raw = localStorage.getItem(LS_TEMPLATES);
    if (raw) {
      const arr = JSON.parse(raw) as ResolutionTemplate[];
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch { /* ignore */ }
  return DEFAULT_TEMPLATES;
}

type ReorderOp = "up" | "down" | "top" | "bottom";

function reorderItems(items: LayoutItem[], ids: string[], op: ReorderOp): LayoutItem[] {
  const isSel = (it: LayoutItem) => !!it.id && ids.includes(it.id);
  if (op === "top") return [...items.filter((x) => !isSel(x)), ...items.filter(isSel)];
  if (op === "bottom") return [...items.filter(isSel), ...items.filter((x) => !isSel(x))];
  const arr = [...items];
  if (op === "up") {
    for (let i = arr.length - 2; i >= 0; i--) {
      if (isSel(arr[i]) && !isSel(arr[i + 1])) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    }
  } else {
    for (let i = 1; i < arr.length; i++) {
      if (isSel(arr[i]) && !isSel(arr[i - 1])) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
    }
  }
  return arr;
}

const DEPTH_RANK: Record<DepthTier, number> = { bg: 0, mg: 1, auto: 1, fg: 2 };

/** 发给 LLM 的图层/透视说明，便于它理解前后关系 */
function layoutContextHint(d: LayoutDraft): string {
  const lines: string[] = [];
  const vis = d.items.filter((x) => !x.hidden);
  if (vis.length) {
    const zh: Record<string, string> = { fg: "前景", mg: "中景", bg: "背景", auto: "" };
    const front = [...vis].reverse().map((it, i) => {
      const nm = it.name || it.caption.slice(0, 40);
      const tier = it.depth && it.depth !== "auto" ? `(${zh[it.depth]})` : "";
      return `${i + 1}. ${nm}${tier}`;
    });
    lines.push(`当前图层从前到后：${front.join("；")}`);
  }
  const p = d.perspective;
  if (p?.enabled) {
    const kind = p.mode === 1 ? "一点透视" : p.mode === 2 ? "两点透视" : "三点透视";
    lines.push(
      `透视：${kind}，地平线在画面 ${Math.round((p.horizon_y / d.height) * 100)}% 高度，VP1 x=${Math.round(
        (p.vp1_x / d.width) * 100,
      )}%`,
    );
  }
  return lines.join("\n");
}

export default function App() {
  const [mode, setMode] = useState<EditorMode>("layout");
  const [idea, setIdea] = useState("");
  const [layout, setLayout] = useState<LayoutDraft>(() => normalizeLayout(emptyLayout(1536, 1024)));
  const [caption, setCaption] = useState<CaptionDraft>(() => emptyCaption());
  const [selIds, setSelIds] = useState<string[]>([]);
  const [layersCollapsed, setLayersCollapsed] = useState(false);
  const [refImg, setRefImg] = useState<{ url: string; name: string } | null>(null);
  const [refOpacity, setRefOpacity] = useState(0.55);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [drawing, setDrawing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<ResolutionTemplate[]>(loadTemplates);
  const [tplId, setTplId] = useState("camp");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [activeSkills, setActiveSkills] = useState<SkillsState["active"]>({
    caption: "official-caption",
    layout: "official-layout",
    context: "official-context",
  });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [rightTab, setRightTab] = useState<"props" | "context" | "prompt">("props");
  const [historyId, setHistoryId] = useState<string | undefined>();

  const draft: Draft = mode === "layout" ? layout : caption;
  const primaryId = selIds.length ? selIds[selIds.length - 1] : null;
  const selected = primaryId ? layout.items.findIndex((x) => x.id === primaryId) : -1;
  const setSelected = (i: number) => {
    const id = i >= 0 ? layoutRef.current.items[i]?.id : undefined;
    setSelIds(id ? [id] : []);
  };
  const selectFirstOf = (d: LayoutDraft) => setSelIds(d.items[0]?.id ? [d.items[0].id] : []);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
    api
      .listSkills()
      .then((s) => {
        setSkills(s.skills);
        setActiveSkills(s.active);
      })
      .catch(() => {});
    refreshHistory();
  }, []);

  const modeSkills = useMemo(
    () => skills.filter((s) => s.kind === mode),
    [skills, mode],
  );

  const activeSkillId = activeSkills[mode] || modeSkills[0]?.id || "";

  const onSkillsChanged = (state: SkillsState) => {
    setSkills(state.skills);
    setActiveSkills(state.active);
  };

  const changeActiveSkill = async (id: string) => {
    try {
      const state = await api.setActiveSkill(mode, id);
      onSkillsChanged(state);
      setStatus(`已切换 ${mode} Skill`);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const refreshHistory = () => {
    api
      .listHistory()
      .then((r) => {
        setHistory(r.items);
        try {
          localStorage.setItem(LS_HISTORY, JSON.stringify(r.items));
        } catch { /* ignore */ }
      })
      .catch(() => {
        try {
          const raw = localStorage.getItem(LS_HISTORY);
          if (raw) setHistory(JSON.parse(raw));
        } catch { /* ignore */ }
      });
  };

  const persistTemplates = (t: ResolutionTemplate[]) => {
    setTemplates(t);
    localStorage.setItem(LS_TEMPLATES, JSON.stringify(t));
  };

  const switchMode = (m: EditorMode) => {
    setMode(m);
    setSelected(-1);
    setDrawing(false);
    setErr("");
  };

  const applyTemplate = (id: string, scaleBoxes: boolean) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setTplId(id);
    setLayout((prev) => {
      const ow = prev.width;
      const oh = prev.height;
      const nw = t.width;
      const nh = t.height;
      let items = prev.items;
      if (scaleBoxes && ow > 0 && oh > 0 && (ow !== nw || oh !== nh)) {
        const sx = nw / ow;
        const sy = nh / oh;
        items = prev.items.map((it) => {
          const [x1, y1, x2, y2] = it.bbox;
          return {
            ...it,
            bbox: [
              Math.round(x1 * sx),
              Math.round(y1 * sy),
              Math.round(x2 * sx),
              Math.round(y2 * sy),
            ] as [number, number, number, number],
          };
        });
      } else if (!scaleBoxes && (ow !== nw || oh !== nh) && prev.items.length) {
        setStatus("已切换分辨率；现有框未缩放，请确认是否仍在画布内。");
      }
      let perspective = prev.perspective;
      if (perspective && ow > 0 && oh > 0) {
        const sx = nw / ow;
        const sy = nh / oh;
        perspective = {
          ...perspective,
          horizon_y: Math.round(perspective.horizon_y * sy),
          vp1_x: Math.round(perspective.vp1_x * sx),
          vp2_x: Math.round(perspective.vp2_x * sx),
          vp3_x: Math.round(perspective.vp3_x * sx),
          vp3_y: Math.round(perspective.vp3_y * sy),
        };
      }
      return { ...prev, width: nw, height: nh, items, perspective };
    });
    setSegments(null);
  };

  const onTemplateChange = (id: string) => {
    if (id === "__custom__") {
      const w = snap16(Number(window.prompt("宽度（需为 16 的倍数）", "1280") || 0));
      const h = snap16(Number(window.prompt("高度（需为 16 的倍数）", "768") || 0));
      if (!w || !h) return;
      const name = window.prompt("模板名称", `${w}×${h}`) || `${w}×${h}`;
      const nt: ResolutionTemplate = {
        id: `c-${Date.now()}`,
        name,
        width: w,
        height: h,
      };
      const next = [...templates, nt];
      persistTemplates(next);
      applyTemplate(nt.id, true);
      return;
    }
    const scale = layout.items.length
      ? confirm("按比例缩放现有包围盒？\n确定=缩放 · 取消=仅改画布尺寸")
      : false;
    applyTemplate(id, scale);
  };

  const doCompile = async () => {
    setBusy(true);
    setErr("");
    try {
      let d: Draft = draft;
      if (mode === "layout") {
        const ld = layout;
        if (!ld.summary.caption.trim()) {
          throw new Error("请填写全局画面描述");
        }
        if (!ld.items.length) {
          throw new Error("Layout 至少需要一个框");
        }
        if (!ld.items.some((x) => !x.hidden)) {
          throw new Error("所有框都被隐藏了（隐藏的框不参与编译），请至少显示一个");
        }
        d = ld;
      } else {
        if (!caption.caption.trim()) throw new Error("Caption 不能为空");
        d = caption;
      }
      const r = await api.compile(d);
      let out = r.prompt;
      if (settings?.prompt_prefix) {
        // prefix is for Gradio prefilling; show separately, don't bake into compiled layout JSON
        if (r.mode === "caption") {
          out = `${settings.prompt_prefix}, ${r.prompt}`;
        }
      }
      setPrompt(out);
      setStatus(
        r.mode === "layout"
          ? `已编译 Layout（出图请另传 ${layout.width}×${layout.height}）`
          : "已编译 Caption"
      );
      setRightTab("prompt");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyCompiledPrompt = (rawPrompt: string | null | undefined, modeHint?: string) => {
    if (!rawPrompt) return false;
    const isLayoutJson = rawPrompt.trimStart().startsWith("{");
    const asCaption = modeHint === "caption" || (!isLayoutJson && mode === "caption");
    let out = rawPrompt;
    if (settings?.prompt_prefix && asCaption && !isLayoutJson) {
      out = `${settings.prompt_prefix}, ${rawPrompt}`;
    }
    setPrompt(out);
    return true;
  };

  const doEnhance = async () => {
    if (!idea.trim()) {
      setErr("请先输入想法");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await api.enhance({
        idea: idea.trim(),
        mode,
        width: layout.width,
        height: layout.height,
        skill_id: activeSkills[mode],
        context_hint: mode === "layout" ? layoutContextHint(layout) : undefined,
      });
      if (mode === "layout" && isLayoutDraft(r.draft)) {
        const nd = normalizeLayout({
          ...r.draft,
          perspective:
            r.draft.width === layout.width && r.draft.height === layout.height ? layout.perspective : undefined,
          prompt_options: layout.prompt_options,
        });
        setLayout(nd);
        selectFirstOf(nd);
        r.draft = nd;
      } else if (!isLayoutDraft(r.draft)) {
        setCaption(r.draft);
        switchMode("caption");
      } else if (mode === "caption" && isLayoutDraft(r.draft)) {
        // unexpected
        setLayout(normalizeLayout(r.draft));
        switchMode("layout");
      } else {
        setCaption(r.draft as unknown as CaptionDraft);
      }
      // Layout 草稿带有图层/透视选项，统一用前端合并后的草稿重新编译
      let filled = isLayoutDraft(r.draft) ? false : applyCompiledPrompt(r.prompt ?? undefined, r.mode);
      if (!filled) {
        filled = await doCompileSilent(r.draft, { showError: true });
      }
      if (r.degraded) {
        setStatus((r.message || "已降级生成") + (filled ? " · 已自动编译" : ""));
      } else if (!filled && r.compile_error) {
        setStatus("增强完成，但自动编译失败");
        setErr(r.compile_error);
      } else {
        setStatus(filled ? "增强完成 · 已自动编译" : "增强完成");
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doCompileSilent = async (
    d: Draft,
    opts?: { showError?: boolean },
  ): Promise<boolean> => {
    try {
      const r = await api.compile(d);
      let out = r.prompt;
      if (settings?.prompt_prefix && r.mode === "caption") {
        out = `${settings.prompt_prefix}, ${r.prompt}`;
      }
      setPrompt(out);
      return true;
    } catch (e: unknown) {
      if (opts?.showError) {
        setErr(e instanceof Error ? e.message : String(e));
      }
      return false;
    }
  };

  const sendContext = async () => {
    const msg = chatInput.trim();
    if (!msg) return;
    setChatInput("");
    setChat((c) => [...c, { role: "user", content: msg }]);
    setBusy(true);
    setErr("");
    try {
      const r = await api.contextEdit({
        draft,
        message: msg,
        history: chat.slice(-8),
        skill_id: activeSkills.context,
      });
      if (isLayoutDraft(r.draft)) {
        const nd = mergeEditorMeta(layout, r.draft);
        setLayout(nd);
        setSelIds((ids) => ids.filter((id) => nd.items.some((x) => x.id === id)));
        r.draft = nd;
        if (mode !== "layout") setMode("layout");
      } else {
        setCaption(r.draft);
        if (mode !== "caption") setMode("caption");
      }
      setChat((c) => [...c, { role: "assistant", content: r.reply }]);
      let filled = isLayoutDraft(r.draft) ? false : applyCompiledPrompt(r.prompt ?? undefined);
      if (!filled) {
        filled = await doCompileSilent(r.draft, { showError: true });
      }
      if (r.degraded) setStatus(filled ? "上下文：本地规则降级 · 已自动编译" : "上下文：本地规则降级");
      else setStatus(filled ? "上下文已更新 · 已自动编译" : "上下文已更新");
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m);
      setChat((c) => [...c, { role: "assistant", content: `错误：${m}` }]);
    } finally {
      setBusy(false);
    }
  };

  const saveToHistory = async () => {
    const title =
      prompt.slice(0, 40) ||
      idea.slice(0, 40) ||
      (mode === "layout" ? layout.summary.caption.slice(0, 40) : caption.caption.slice(0, 40)) ||
      "未命名";
    try {
      const saved = await api.saveHistory({
        id: historyId,
        title: title || "未命名",
        mode,
        idea,
        draft,
        prompt,
      });
      setHistoryId(saved.id);
      setStatus("已保存到历史");
      refreshHistory();
    } catch (e: unknown) {
      // fallback local
      const rec: HistoryRecord = {
        id: historyId || `local-${Date.now()}`,
        title: title || "未命名",
        mode,
        idea,
        draft,
        prompt,
        updated_at: new Date().toISOString(),
      };
      const next = [rec, ...history.filter((h) => h.id !== rec.id)];
      setHistory(next);
      setHistoryId(rec.id);
      try {
        localStorage.setItem(LS_HISTORY, JSON.stringify(next));
      } catch { /* ignore */ }
      setStatus("服务端不可用，已写入本地缓存");
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const restoreHistory = (r: HistoryRecord) => {
    setHistoryId(r.id);
    setIdea(r.idea || "");
    setPrompt(r.prompt || "");
    setMode(r.mode);
    setSelIds([]);
    setSegments(null);
    if (r.mode === "layout" && isLayoutDraft(r.draft)) {
      setLayout(normalizeLayout(r.draft));
      const ld = r.draft as LayoutDraft;
      const match = templates.find(
        (t) => t.width === ld.width && t.height === ld.height
      );
      if (match) setTplId(match.id);
    } else if (!isLayoutDraft(r.draft)) {
      setCaption(r.draft);
    } else {
      setLayout(normalizeLayout(r.draft));
      setMode("layout");
    }
    setStatus(`已恢复：${r.title}`);
  };

  const updateSelected = (patch: Partial<LayoutItem>) => {
    if (selected < 0) return;
    setLayout((prev) => ({
      ...prev,
      items: prev.items.map((it) => (it.id === primaryId ? { ...it, ...patch } : it)),
    }));
  };

  const deleteSelected = () => {
    if (selected < 0) return;
    deleteIds([layout.items[selected].id as string], true);
  };

  /** 删除；force=false 时跳过锁定的框 */
  const deleteIds = (ids: string[], force = false) => {
    const cur = layoutRef.current.items;
    const kill = cur.filter((x) => x.id && ids.includes(x.id) && (force || !x.locked)).map((x) => x.id);
    const skipped = ids.length - kill.length;
    if (!kill.length) {
      if (skipped) setStatus("选中的框已锁定，未删除");
      return;
    }
    setLayout((prev) => ({ ...prev, items: prev.items.filter((x) => !kill.includes(x.id)) }));
    setSelIds((s) => s.filter((x) => !kill.includes(x)));
    setStatus(`已删除 ${kill.length} 个框${skipped ? `（${skipped} 个锁定未删）` : ""}`);
  };

  const changeItems = (items: LayoutItem[]) => setLayout((p) => ({ ...p, items }));

  const reorder = (op: ReorderOp, ids = selIds) => {
    if (!ids.length) return;
    setLayout((prev) => ({ ...prev, items: reorderItems(prev.items, ids, op) }));
  };

  const sortBy = (by: "depth" | "ground") => {
    setLayout((prev) => {
      const idx = new Map(prev.items.map((x, i) => [x, i]));
      const items = [...prev.items].sort((a, b) => {
        if (by === "depth") {
          const d = DEPTH_RANK[a.depth || "auto"] - DEPTH_RANK[b.depth || "auto"];
          return d || idx.get(a)! - idx.get(b)!;
        }
        // 文字层保持在最上；其余按底边：越靠下越靠前
        const ta = a.label === "text" ? 1 : 0;
        const tb = b.label === "text" ? 1 : 0;
        if (ta !== tb) return ta - tb;
        return a.bbox[3] - b.bbox[3] || idx.get(a)! - idx.get(b)!;
      });
      return { ...prev, items };
    });
    setStatus(by === "depth" ? "已按 背景→中景→前景 排序" : "已按落地点排序（越靠下越靠前）");
  };

  const createItem = (bbox: BBox) => {
    const id = newItemId();
    setLayout((prev) => {
      const item: LayoutItem = {
        label: "object",
        caption: `区域 ${prev.items.length + 1}`,
        bbox,
        id,
        depth: "auto",
        hidden: false,
        locked: false,
        color: prev.items.length % BOX_COLORS,
      };
      return { ...prev, items: [...prev.items, item] };
    });
    setSelIds([id]);
  };

  const setPerspective = (p: PerspectiveSettings) => setLayout((prev) => ({ ...prev, perspective: p }));
  const setPromptOpts = (o: PromptOptions) => setLayout((prev) => ({ ...prev, prompt_options: o }));

  const autoFromBoxes = () => {
    const r = estimateFromBoxes(layout);
    if (!r.ok || !r.patch) {
      setErr(r.message);
      return;
    }
    const p = layout.perspective!;
    const next: PerspectiveSettings = { ...p, ...r.patch, enabled: true };
    if (p.mode >= 2) {
      const half = Math.max(Math.abs(p.vp2_x - p.vp1_x) / 2, layout.width * 0.9);
      next.vp1_x = Math.round((r.patch.vp1_x ?? p.vp1_x) - half);
      next.vp2_x = Math.round((r.patch.vp1_x ?? p.vp1_x) + half);
    }
    setPerspective(next);
    setErr("");
    setStatus(r.message);
  };

  const loadRef = (f: File) => {
    setRefImg((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return { url: URL.createObjectURL(f), name: f.name };
    });
    setSegments(null);
    setStatus(`已载入参考图 ${f.name}（铺满画布显示，仅本地，不随历史保存）`);
  };

  const clearRef = () => {
    setRefImg((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return null;
    });
    setSegments(null);
  };

  const detectFromRef = async () => {
    if (!refImg) return;
    setBusy(true);
    setErr("");
    try {
      const img = new Image();
      img.src = refImg.url;
      await img.decode();
      await new Promise((r) => setTimeout(r, 0));
      const r = detectFromImage(img, layout.width, layout.height);
      setSegments(r.segments || null);
      if (!r.ok || !r.patch) {
        setErr(`${r.message}。可改用「按框自动」或手动拖动消失点。`);
        return;
      }
      setPerspective({ ...layout.perspective!, ...r.patch, enabled: true });
      setStatus(`${r.message}（橙=VP1 线，青=VP2，紫=竖直 VP3，灰=未用）`);
    } catch (e: unknown) {
      setErr(`检测失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const alignPersp = () => {
    const p = layout.perspective!;
    const ids = selIds.length > 1 ? selIds : layout.items.filter((x) => !x.hidden).map((x) => x.id as string);
    const r = alignToPerspective(layout.items, ids, p.horizon_y, layout.width, layout.height, primaryId || undefined);
    if (!r.changed) {
      setErr("至少需要 2 个底边在地平线以下、未锁定的框才能对齐（先设置地平线）");
      return;
    }
    changeItems(r.items);
    if (!p.enabled) setPerspective({ ...p, enabled: true });
    setErr("");
    setStatus(`已按透视统一 ${r.changed} 个框的大小${r.skipped ? `，${r.skipped} 个在地平线以上/锁定未动` : ""}`);
  };

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (mode !== "layout" || settingsOpen || skillsOpen || reverseOpen) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable))
        return;
      const cur = layoutRef.current;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelIds(cur.items.filter((x) => !x.hidden && !x.locked).map((x) => x.id as string));
        return;
      }
      if (e.key === "Escape") {
        setSelIds([]);
        setDrawing(false);
        return;
      }
      if (!selIds.length) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteIds(selIds);
        return;
      }
      if (e.key === "[" || e.key === "{" || e.code === "BracketLeft") {
        e.preventDefault();
        reorder(e.shiftKey ? "bottom" : "down");
        return;
      }
      if (e.key === "]" || e.key === "}" || e.code === "BracketRight") {
        e.preventDefault();
        reorder(e.shiftKey ? "top" : "up");
        return;
      }
      const dirs: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const dv = dirs[e.key];
      if (dv) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        setLayout((prev) => ({
          ...prev,
          items: prev.items.map((it) => {
            if (!it.id || !selIds.includes(it.id) || it.locked) return it;
            const [x1, y1, x2, y2] = it.bbox;
            const w = x2 - x1;
            const h = y2 - y1;
            const nx = Math.max(0, Math.min(prev.width - w, x1 + dv[0] * step));
            const ny = Math.max(0, Math.min(prev.height - h, y1 + dv[1] * step));
            return { ...it, bbox: [nx, ny, nx + w, ny + h] as BBox };
          }),
        }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, settingsOpen, skillsOpen, reverseOpen, selIds],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setStatus("已复制提示词");
    } catch {
      setErr("复制失败，请手动选择文本");
    }
  };

  const sel = selected >= 0 ? layout.items[selected] : null;

  const dimsBadge = useMemo(
    () =>
      mode === "layout" ? (
        <span className="badge">
          出图 {layout.width}×{layout.height}
        </span>
      ) : (
        <span className="badge">Caption 模式</span>
      ),
    [mode, layout.width, layout.height]
  );

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">MOSS 提示词编辑器</div>
        <div className="mode-toggle">
          <button
            type="button"
            className={mode === "caption" ? "active" : ""}
            onClick={() => switchMode("caption")}
          >
            想法 Caption
          </button>
          <button
            type="button"
            className={mode === "layout" ? "active" : ""}
            onClick={() => switchMode("layout")}
          >
            拉框 Layout
          </button>
        </div>
        <select
          style={{ width: 180 }}
          value={activeSkillId}
          onChange={(e) => changeActiveSkill(e.target.value)}
          title="当前模式使用的 Skill"
        >
          {modeSkills.map((s) => (
            <option key={s.id} value={s.id}>
              {s.builtin ? "★ " : ""}
              {s.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setSkillsOpen(true)}>
          管理 Skills
        </button>
        <div className="sep" />
        {mode === "layout" && (
          <>
            <select
              style={{ width: 160 }}
              value={tplId}
              onChange={(e) => onTemplateChange(e.target.value)}
              title="分辨率模板"
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              <option value="__custom__">+ 自定义模板…</option>
            </select>
            <button
              type="button"
              className={drawing ? "primary" : ""}
              onClick={() => setDrawing((d) => !d)}
            >
              {drawing ? "拉框中…" : "新建框"}
            </button>
          </>
        )}
        <button type="button" className="primary" disabled={busy} onClick={doCompile}>
          编译
        </button>
        <button type="button" disabled={!prompt} onClick={copyPrompt}>
          复制
        </button>
        <button type="button" disabled={busy} onClick={saveToHistory}>
          存历史
        </button>
        <div className="sep" />
        <button type="button" onClick={() => setReverseOpen(true)}>
          图像反推
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)}>
          设置
        </button>
        {dimsBadge}
        {settings?.api_key_set ? (
          <span className="badge ok">API 已就绪</span>
        ) : (
          <span className="badge warn">无 Key · compile 可用</span>
        )}
      </header>

      <div className="main">
        <HistoryPanel
          items={history}
          onRestore={restoreHistory}
          onDelete={async (id) => {
            try {
              await api.deleteHistory(id);
            } catch { /* local */ }
            setHistory((h) => {
              const n = h.filter((x) => x.id !== id);
              localStorage.setItem(LS_HISTORY, JSON.stringify(n));
              return n;
            });
            if (historyId === id) setHistoryId(undefined);
          }}
          onRename={async (id, title) => {
            try {
              await api.renameHistory(id, title);
            } catch { /* local */ }
            setHistory((h) => {
              const n = h.map((x) => (x.id === id ? { ...x, title } : x));
              localStorage.setItem(LS_HISTORY, JSON.stringify(n));
              return n;
            });
          }}
          onRefresh={refreshHistory}
        />

        <div className="center">
          {mode === "caption" ? (
            <div className="canvas-wrap">
              <div className="idea-area">
                <h3>用想法生成 Caption</h3>
                <p className="hint">不必拉框。输入场景描述，点「增强」调用 LLM（无 Key 时本地降级包装原文）。</p>
                <textarea
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                  placeholder="例如：一只红色恐龙站在雨林里，电影感光影…"
                />
                <div className="row">
                  <button type="button" className="primary" disabled={busy} onClick={doEnhance}>
                    增强生成
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCaption({ caption: idea });
                      setStatus("已用原文作为 caption");
                    }}
                  >
                    原文即 Caption
                  </button>
                </div>
                <div className="field">
                  <label>当前 Caption（可直接编辑）</label>
                  <textarea
                    value={caption.caption}
                    onChange={(e) => setCaption({ caption: e.target.value })}
                    rows={8}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="layout-work">
              <PerspectiveBar
                p={layout.perspective!}
                opts={layout.prompt_options!}
                width={layout.width}
                height={layout.height}
                hasRef={!!refImg}
                refOpacity={refOpacity}
                hasSegments={!!segments}
                selCount={selIds.length}
                onChange={setPerspective}
                onChangeOpts={setPromptOpts}
                onAutoBoxes={autoFromBoxes}
                onDetectImage={() => void detectFromRef()}
                onAlign={alignPersp}
                onLoadRef={loadRef}
                onClearRef={clearRef}
                onRefOpacity={setRefOpacity}
                onClearSegments={() => setSegments(null)}
              />
              <div className={`canvas-row${layersCollapsed ? " layers-collapsed" : ""}`}>
                <Canvas
                  draft={layout}
                  selIds={selIds}
                  drawing={drawing}
                  refImage={refImg ? { url: refImg.url, opacity: refOpacity } : null}
                  segments={layout.perspective?.enabled ? segments : null}
                  onSelect={setSelIds}
                  onChangeItems={changeItems}
                  onChangePerspective={setPerspective}
                  onDrawingChange={setDrawing}
                  onCreateItem={createItem}
                  modalLocked={settingsOpen || skillsOpen || reverseOpen}
                />
                <LayerPanel
                  items={layout.items}
                  selIds={selIds}
                  collapsed={layersCollapsed}
                  onToggleCollapsed={() => setLayersCollapsed((v) => !v)}
                  onSelect={setSelIds}
                  onChangeItems={changeItems}
                  onReorder={(op) => reorder(op)}
                  onDelete={(ids) => deleteIds(ids, ids.length === 1)}
                  onSortBy={sortBy}
                />
              </div>
            </div>
          )}
          <div className="prompt-bar">
            <div>
              <label>
                编译结果{" "}
                {mode === "layout" && (
                  <span className="hint">
                    （宽高 {layout.width}×{layout.height} 需在生成接口单独传入）
                  </span>
                )}
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="生成/增强后会自动填入可粘贴提示词；也可点「编译」…"
              />
              {status && <div className="status">{status}</div>}
              {err && <div className="err">{err}</div>}
            </div>
            <div className="prompt-actions">
              <button type="button" className="primary" disabled={busy} onClick={doCompile}>
                重新编译
              </button>
              <button type="button" disabled={!prompt} onClick={copyPrompt}>
                复制
              </button>
              {settings?.negative_prompt && (
                <button
                  type="button"
                  title="复制 negative"
                  onClick={() =>
                    navigator.clipboard.writeText(settings.negative_prompt).then(() =>
                      setStatus("已复制 negative prompt")
                    )
                  }
                >
                  复制 Negative
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-h">
            <div className="tabs" style={{ margin: 0, flex: 1 }}>
              <button
                type="button"
                className={rightTab === "props" ? "active" : ""}
                onClick={() => setRightTab("props")}
              >
                属性
              </button>
              <button
                type="button"
                className={rightTab === "context" ? "active" : ""}
                onClick={() => setRightTab("context")}
              >
                上下文
              </button>
            </div>
          </div>
          <div className="panel-b">
            {rightTab === "props" && mode === "layout" && (
              <>
                <div className="field">
                  <label>想法（用于增强）</label>
                  <div className="field-hint">先写粗略想法，点下方按钮增强后会填入全局描述并生成框</div>
                  <textarea
                    value={idea}
                    onChange={(e) => setIdea(e.target.value)}
                    rows={3}
                    placeholder="描述你想要的构图…"
                  />
                  <button
                    type="button"
                    className="primary"
                    style={{ marginTop: 6 }}
                    disabled={busy}
                    onClick={doEnhance}
                  >
                    从想法生成 Layout
                  </button>
                </div>
                <div className="field">
                  <label>全局画面描述</label>
                  <div className="field-hint">整张图的总文案，增强后自动填入，也可手改；会编进最终 Layout</div>
                  <textarea
                    value={layout.summary.caption}
                    onChange={(e) =>
                      setLayout((p) => ({
                        ...p,
                        summary: { ...p.summary, caption: e.target.value },
                      }))
                    }
                    rows={4}
                    placeholder="用中文写整张图要表达的内容…"
                  />
                </div>
                <div className="field">
                  <label>画布类型</label>
                  <div className="field-hint">一般选「单图」；多图/拼图才换</div>
                  <select
                    value={layout.summary.canvas || "single"}
                    onChange={(e) =>
                      setLayout((p) => ({
                        ...p,
                        summary: {
                          ...p.summary,
                          canvas: e.target.value as LayoutDraft["summary"]["canvas"],
                        },
                      }))
                    }
                  >
                    <option value="single">单图</option>
                    <option value="multi_panel">多图分镜</option>
                    <option value="collage">拼贴</option>
                  </select>
                </div>
                <hr style={{ borderColor: "var(--border)", margin: "12px 0" }} />
                {sel ? (
                  <>
                    <div className="status">
                      选中第 {selected + 1} 层（共 {layout.items.length} 层，数字越大越靠前）
                      {selIds.length > 1 && ` · 已多选 ${selIds.length} 个`}
                    </div>
                    <div className="field">
                      <label>图层名称</label>
                      <div className="field-hint">只用于编辑器和「在 X 前面」这类前后关系描述；留空则用框内描述</div>
                      <input
                        value={sel.name || ""}
                        placeholder="例如：主角、老橡树"
                        onChange={(e) => updateSelected({ name: e.target.value || undefined })}
                      />
                    </div>
                    <div className="field">
                      <label>景深层</label>
                      <div className="field-hint">前景/中景/背景会写进提示词；「自动」只按图层顺序和重叠写前后关系</div>
                      <div className="row">
                        <select
                          value={sel.depth || "auto"}
                          onChange={(e) => updateSelected({ depth: e.target.value as DepthTier })}
                        >
                          <option value="auto">自动</option>
                          <option value="fg">前景</option>
                          <option value="mg">中景</option>
                          <option value="bg">背景</option>
                        </select>
                        <label className="chk">
                          <input
                            type="checkbox"
                            checked={!!sel.hidden}
                            onChange={(e) => updateSelected({ hidden: e.target.checked })}
                          />
                          隐藏
                        </label>
                        <label className="chk">
                          <input
                            type="checkbox"
                            checked={!!sel.locked}
                            onChange={(e) => updateSelected({ locked: e.target.checked })}
                          />
                          锁定
                        </label>
                      </div>
                      {sel.hidden && <div className="field-hint" style={{ color: "var(--warn)" }}>隐藏的框不参与编译</div>}
                    </div>
                    <div className="field">
                      <label>框类型</label>
                      <div className="field-hint">物体 / 文字 / 人物等</div>
                      <select
                        value={sel.label}
                        onChange={(e) =>
                          updateSelected({ label: e.target.value as ItemLabel })
                        }
                      >
                        <option value="object">物体</option>
                        <option value="character">人物</option>
                        <option value="text">文字</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>框内描述</label>
                      <div className="field-hint">这个框里画什么</div>
                      <textarea
                        value={sel.caption}
                        onChange={(e) => updateSelected({ caption: e.target.value })}
                        rows={3}
                        placeholder="描述该框内的内容…"
                      />
                    </div>
                    {sel.label === "text" && (
                      <div className="field">
                        <label>可见文字</label>
                        <div className="field-hint">画面上实际显示的字；换行用实际换行</div>
                        <textarea
                          value={sel.text || ""}
                          onChange={(e) => updateSelected({ text: e.target.value })}
                          rows={3}
                          placeholder="画面上要出现的原文…"
                        />
                      </div>
                    )}
                    <div className="field">
                      <label>框位置（像素）</label>
                      <div className="field-hint">左上→右下；也可在画布拖</div>
                      <div className="row">
                        {sel.bbox.map((v, i) => (
                          <input
                            key={i}
                            type="number"
                            value={v}
                            title={["x1 左", "y1 上", "x2 右", "y2 下"][i]}
                            onChange={(e) => {
                              const bbox = [...sel.bbox] as [
                                number,
                                number,
                                number,
                                number
                              ];
                              bbox[i] = Number(e.target.value);
                              updateSelected({ bbox });
                            }}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="field">
                      <label>标签</label>
                      <div className="field-hint">可选关键词，逗号分隔</div>
                      <input
                        value={(sel.tags || []).join(", ")}
                        placeholder="例如：特写, 侧光"
                        onChange={(e) =>
                          updateSelected({
                            tags: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </div>
                    <button type="button" className="danger" onClick={deleteSelected}>
                      删除此框
                    </button>
                  </>
                ) : (
                  <p className="hint">
                    点击「新建框」后在画布上拖拽；或在画布 / 右侧图层列表选中已有框编辑属性。框之间可以重叠，图层越靠上越靠前。
                  </p>
                )}
              </>
            )}
            {rightTab === "props" && mode === "caption" && (
              <p className="hint">Caption 模式请在中央编辑区修改文本，或用上下文面板发指令。</p>
            )}
            {rightTab === "context" && (
              <>
                <p className="hint" style={{ marginBottom: 8 }}>
                  当前 Context Skill：
                  {skills.find((s) => s.id === activeSkills.context)?.name ||
                    activeSkills.context}
                  {" · "}
                  <button
                    type="button"
                    className="ghost"
                    style={{ padding: "0 6px" }}
                    onClick={() => setSkillsOpen(true)}
                  >
                    管理
                  </button>
                </p>
                <div className="chat">
                  {chat.length === 0 && (
                    <p className="hint">
                      例如：「把恐龙框放大」「改总结为『…』」。有 API Key 时由 LLM
                      改 draft；无 Key 时用本地规则。
                    </p>
                  )}
                  {chat.map((m, i) => (
                    <div key={i} className={`bubble ${m.role}`}>
                      {m.content}
                    </div>
                  ))}
                </div>
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="对当前草稿说指令…"
                  rows={3}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      sendContext();
                    }
                  }}
                />
                <button
                  type="button"
                  className="primary"
                  style={{ marginTop: 8, width: "100%" }}
                  disabled={busy}
                  onClick={sendContext}
                >
                  发送（Ctrl+Enter）
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <SkillsModal
        open={skillsOpen}
        onClose={() => setSkillsOpen(false)}
        onChanged={onSkillsChanged}
        initialKind={mode}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={setSettings}
      />
      <ReverseModal
        open={reverseOpen}
        onClose={() => setReverseOpen(false)}
        mode={mode}
        width={layout.width}
        height={layout.height}
        templates={templates}
        skillId={activeSkills.layout}
        onApplyCaption={(text) => {
          if (mode === "layout") {
            setLayout((p) => ({
              ...p,
              summary: { ...p.summary, caption: text },
            }));
            setStatus("已从反推填入全局画面描述");
          } else {
            setCaption({ caption: text });
            setIdea(text.slice(0, 200));
            setStatus("已从反推填入 Caption");
          }
        }}
        onApplyLayout={(rawDraft, promptText, file) => {
          // Switch canvas to the size used for reverse so boxes match
          const draft = normalizeLayout({ ...rawDraft, prompt_options: layout.prompt_options });
          setLayout(draft);
          selectFirstOf(draft);
          if (file) loadRef(file);
          setMode("layout");
          const match = templates.find(
            (t) => t.width === draft.width && t.height === draft.height,
          );
          if (match) {
            setTplId(match.id);
          } else {
            const id = `rev-${draft.width}x${draft.height}`;
            const existing = templates.find((t) => t.id === id);
            if (existing) {
              setTplId(existing.id);
            } else {
              const nt: ResolutionTemplate = {
                id,
                name: `反推 ${draft.width}×${draft.height}`,
                width: draft.width,
                height: draft.height,
              };
              persistTemplates([...templates, nt]);
              setTplId(nt.id);
            }
          }
          void promptText;
          void doCompileSilent(draft, { showError: true });
          setStatus(
            `已从反推填入 Layout（画布已切为 ${draft.width}×${draft.height}）`,
          );
        }}
      />
    </div>
  );
}
