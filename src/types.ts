export type ItemLabel = "object" | "character" | "text";
export type CanvasKind = "single" | "multi_panel" | "collage";
export type EditorMode = "caption" | "layout";

export type DepthTier = "auto" | "fg" | "mg" | "bg";

export interface LayoutItem {
  label: ItemLabel;
  caption: string;
  bbox: [number, number, number, number];
  text?: string;
  tags?: string[];
  palette?: string[];
  // ---- 编辑器元数据（编译前由后端剥离，不进入官方 schema）----
  id?: string;
  name?: string;
  hidden?: boolean;
  locked?: boolean;
  depth?: DepthTier;
  color?: number;
}

export type PerspectiveMode = 1 | 2 | 3;

/** 透视设置；坐标均为画布像素（可在画布外） */
export interface PerspectiveSettings {
  enabled: boolean;
  mode: PerspectiveMode;
  horizon_y: number;
  vp1_x: number;
  vp2_x: number;
  vp3_x: number;
  vp3_y: number;
  show_grid: boolean;
  auto_scale: boolean;
  source?: "manual" | "boxes" | "image";
}

export interface PromptOptions {
  depth: boolean;
  perspective: boolean;
}

export interface LayoutSummary {
  caption: string;
  meta?: string[];
  canvas?: CanvasKind;
  palette?: string[];
}

export interface LayoutDraft {
  width: number;
  height: number;
  bbox_coord_space: "abs";
  bbox_format: "xyxy";
  summary: LayoutSummary;
  items: LayoutItem[];
  perspective?: PerspectiveSettings;
  prompt_options?: PromptOptions;
}

export interface CaptionDraft {
  caption: string;
}

export type Draft = LayoutDraft | CaptionDraft;

export function isLayoutDraft(d: Draft): d is LayoutDraft {
  return "items" in d && Array.isArray((d as LayoutDraft).items);
}

export interface ResolutionTemplate {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface HistoryRecord {
  id: string;
  title: string;
  mode: EditorMode;
  idea: string;
  draft: Draft;
  prompt: string;
  created_at?: string;
  updated_at?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AppSettings {
  base_url: string;
  api_key: string;
  api_key_set: boolean;
  model: string;
  vision_model: string;
  prompt_prefix: string;
  negative_prompt: string;
}

export const DEFAULT_TEMPLATES: ResolutionTemplate[] = [
  { id: "sq", name: "1024×1024 方形", width: 1024, height: 1024 },
  { id: "land", name: "1280×768 横图", width: 1280, height: 768 },
  { id: "camp", name: "1536×1024 横幅", width: 1536, height: 1024 },
  { id: "port", name: "1024×1536 竖图", width: 1024, height: 1536 },
  { id: "hd", name: "1920×1088 宽屏", width: 1920, height: 1088 },
  { id: "sq2", name: "768×768 小方", width: 768, height: 768 },
];

export function emptyLayout(width = 1024, height = 1024): LayoutDraft {
  return {
    width,
    height,
    bbox_coord_space: "abs",
    bbox_format: "xyxy",
    summary: { caption: "", canvas: "single" },
    items: [],
    perspective: defaultPerspective(width, height),
    prompt_options: { ...DEFAULT_PROMPT_OPTIONS },
  };
}

export function emptyCaption(): CaptionDraft {
  return { caption: "" };
}

export function snap16(n: number): number {
  return Math.max(16, Math.round(n / 16) * 16);
}

export type SkillKind = "caption" | "layout" | "context";

export interface Skill {
  id: string;
  name: string;
  kind: SkillKind;
  builtin: boolean;
  description: string;
  system_prompt: string;
  updated_at?: string;
}

export interface SkillsState {
  skills: Skill[];
  active: Record<SkillKind, string>;
}

export const BOX_COLORS = 6;

export function newItemId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultPerspective(width: number, height: number): PerspectiveSettings {
  return {
    enabled: false,
    mode: 1,
    horizon_y: Math.round(height * 0.42),
    vp1_x: Math.round(width / 2),
    vp2_x: Math.round(width * 1.4),
    vp3_x: Math.round(width / 2),
    vp3_y: Math.round(height * 2.5),
    show_grid: false,
    auto_scale: false,
    source: "manual",
  };
}

export const DEFAULT_PROMPT_OPTIONS: PromptOptions = { depth: true, perspective: false };

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/** 补齐旧草稿缺失的字段（id/颜色/透视/选项），保持向后兼容 */
export function normalizeLayout(d: LayoutDraft): LayoutDraft {
  const used = new Set<string>();
  const items = (d.items || []).map((it, i) => {
    let id = typeof it.id === "string" && it.id ? it.id : newItemId();
    while (used.has(id)) id = newItemId();
    used.add(id);
    const depth: DepthTier =
      it.depth === "fg" || it.depth === "mg" || it.depth === "bg" ? it.depth : "auto";
    return {
      ...it,
      id,
      depth,
      hidden: !!it.hidden,
      locked: !!it.locked,
      color: typeof it.color === "number" ? ((it.color % BOX_COLORS) + BOX_COLORS) % BOX_COLORS : i % BOX_COLORS,
    };
  });
  const dp = defaultPerspective(d.width, d.height);
  const p = (d.perspective || {}) as Partial<PerspectiveSettings>;
  const mode = p.mode === 2 || p.mode === 3 ? p.mode : 1;
  const perspective: PerspectiveSettings = {
    enabled: !!p.enabled,
    mode,
    horizon_y: num(p.horizon_y, dp.horizon_y),
    vp1_x: num(p.vp1_x, dp.vp1_x),
    vp2_x: num(p.vp2_x, dp.vp2_x),
    vp3_x: num(p.vp3_x, dp.vp3_x),
    vp3_y: num(p.vp3_y, dp.vp3_y),
    show_grid: !!p.show_grid,
    auto_scale: !!p.auto_scale,
    source: p.source === "boxes" || p.source === "image" ? p.source : "manual",
  };
  const po = (d.prompt_options || {}) as Partial<PromptOptions>;
  return {
    ...d,
    items,
    perspective,
    prompt_options: {
      depth: po.depth !== false,
      perspective: !!po.perspective,
    },
  };
}

/** AI 改写后的草稿常会丢掉编辑器字段：按 id / 下标把元数据合并回来 */
export function mergeEditorMeta(prev: LayoutDraft, next: LayoutDraft): LayoutDraft {
  const byId = new Map(prev.items.filter((x) => x.id).map((x) => [x.id as string, x]));
  const sameLen = prev.items.length === next.items.length;
  const items = next.items.map((it, i) => {
    const src = (it.id && byId.get(it.id)) || (sameLen ? prev.items[i] : undefined);
    if (!src) return it;
    return {
      ...it,
      id: it.id || src.id,
      name: it.name ?? src.name,
      hidden: it.hidden ?? src.hidden,
      locked: it.locked ?? src.locked,
      depth: it.depth ?? src.depth,
      color: it.color ?? src.color,
    };
  });
  const sameSize = prev.width === next.width && prev.height === next.height;
  return normalizeLayout({
    ...next,
    items,
    perspective: next.perspective || (sameSize ? prev.perspective : undefined),
    prompt_options: next.prompt_options || prev.prompt_options,
  });
}
