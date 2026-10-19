import type {
  AppSettings,
  Draft,
  HistoryRecord,
  LayoutItem,
  PerspectiveSettings,
  Skill,
  SkillKind,
  SkillsState,
} from "./types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { detail: text };
  }
  if (!r.ok) {
    const d = data as { detail?: string };
    throw new Error(d?.detail || r.statusText || `HTTP ${r.status}`);
  }
  return data as T;
}

export function compile(draft: Draft) {
  return req<{ prompt: string; mode: string }>("/api/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft }),
  });
}

export function enhance(body: {
  idea: string;
  mode: "caption" | "layout";
  width?: number;
  height?: number;
  skill_id?: string;
  context_hint?: string;
  /** 用户画框。bbox 为画布绝对像素 xyxy，与图像同坐标系。 */
  boxes?: LayoutItem[];
  perspective?: PerspectiveSettings;
}) {
  return req<{
    draft: Draft;
    mode: string;
    degraded?: boolean;
    message?: string;
    prompt?: string | null;
    compile_error?: string;
  }>("/api/enhance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function contextEdit(body: {
  draft: Draft;
  message: string;
  history?: { role: string; content: string }[];
  skill_id?: string;
}) {
  return req<{
    draft: Draft;
    reply: string;
    degraded?: boolean;
    prompt?: string | null;
    compile_error?: string;
  }>("/api/context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function reverseImage(
  file: File,
  opts?: {
    mode?: "caption" | "layout";
    detail?: "long" | "medium" | "short";
    width?: number;
    height?: number;
    skill_id?: string;
  },
) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("mode", opts?.mode || "caption");
  fd.append("detail", opts?.detail || "medium");
  if (opts?.width != null) fd.append("width", String(opts.width));
  if (opts?.height != null) fd.append("height", String(opts.height));
  if (opts?.skill_id) fd.append("skill_id", opts.skill_id);
  return req<{
    mode?: "caption" | "layout";
    detail?: string;
    caption?: { long: string; medium: string; short: string };
    watermark?: unknown[];
    borders?: string[];
    draft?: import("./types").LayoutDraft;
    prompt?: string | null;
    compile_error?: string;
  }>("/api/reverse", { method: "POST", body: fd });
}

export function getSettings() {
  return req<AppSettings>("/api/settings");
}

export function putSettings(body: Partial<AppSettings> & { api_key?: string }) {
  return req<AppSettings>("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function listHistory() {
  return req<{ items: HistoryRecord[] }>("/api/history");
}

export function saveHistory(item: Partial<HistoryRecord> & { title: string; draft: Draft }) {
  return req<HistoryRecord>("/api/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });
}

export function deleteHistory(id: string) {
  return req<{ ok: boolean }>(`/api/history/${id}`, { method: "DELETE" });
}

export function renameHistory(id: string, title: string) {
  return req<HistoryRecord>(`/api/history/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export function testSettings(body: {
  base_url?: string;
  api_key?: string;
  model?: string;
} = {}) {
  return req<{
    ok: boolean;
    base_url: string;
    models_ok: boolean;
    chat_ok: boolean;
    latency_ms: number | null;
    model_count: number;
    sample_models: string[];
    tested_model?: string;
    message: string;
  }>("/api/settings/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function listUpstreamModels(body: {
  base_url?: string;
  api_key?: string;
} = {}) {
  return req<{ base_url: string; models: string[]; count: number }>(
    "/api/settings/models",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export function listSkills() {
  return req<SkillsState>("/api/skills");
}

export function setActiveSkill(kind: SkillKind, id: string) {
  return req<SkillsState>("/api/skills/active", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, id }),
  });
}

export function createSkill(body: {
  name: string;
  kind: SkillKind;
  description?: string;
  system_prompt: string;
}) {
  return req<{ skill: Skill; skills: Skill[]; active: SkillsState["active"] }>("/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function updateSkill(
  id: string,
  body: { name?: string; description?: string; system_prompt?: string },
) {
  return req<{ skill: Skill; skills: Skill[]; active: SkillsState["active"] }>(
    `/api/skills/${id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export function resetSkill(id: string) {
  return req<{ skill: Skill; skills: Skill[]; active: SkillsState["active"] }>(
    `/api/skills/${id}/reset`,
    { method: "POST" },
  );
}

export function duplicateSkill(id: string) {
  return req<{ skill: Skill; skills: Skill[]; active: SkillsState["active"] }>(
    `/api/skills/${id}/duplicate`,
    { method: "POST" },
  );
}

export function deleteSkill(id: string) {
  return req<SkillsState>(`/api/skills/${id}`, { method: "DELETE" });
}
