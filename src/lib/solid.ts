/**
 * 实体体块（Solid）：用真实尺寸描述 3D 体块——占地中心 (cx, cz)、底面高度、宽 / 高 / 长、朝向。
 * 和 Body（原框 + 远近 + 厚度）一一对应：原框 = 体块在初始机位下的前脸。
 * 这里放：实体 ↔ 框的换算、地面 / 桌面支撑、在镜头视图里画框反推实体（落在地面或桌面上）、拖手柄改大小、常见物体尺寸。
 */
import type { BBox, Body, Camera, ItemLabel, LayoutDraft, LayoutItem } from "../types";
import { defaultCamera } from "./doc";
import {
  bodyOf, cameraAt, clampCamera, f0, groundY, makeFrame, project, sceneMeter, subjectZ, wrapDeg, type Frame, type Vec3,
} from "./camera";

type V3 = Vec3;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rad = (d: number) => (d * Math.PI) / 180;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface Solid {
  /** 占地中心（世界 x / z） */
  cx: number;
  cz: number;
  /** 底面高度（世界 y，向下为正；放在地上时 = 地面） */
  bottom: number;
  /** 宽（本地 x）、高、长 / 厚（本地 z），世界单位 */
  w: number;
  h: number;
  t: number;
  /** 朝向（度），和 Body.yaw 相同 */
  yaw: number;
}

/** 框 + 体块 → 实体 */
export function solidOf(it: LayoutItem, d: LayoutDraft): Solid {
  const b = bodyOf(it, d);
  const F0 = f0(d.height);
  const z = b.z;
  const [x1, y1, x2, y2] = it.bbox;
  const X1 = (x1 - d.width / 2) * z, X2 = (x2 - d.width / 2) * z;
  const Y1 = (y1 - d.height / 2) * z, Y2 = (y2 - d.height / 2) * z;
  const w = X2 - X1;
  const t = Math.max(0, b.thickness) * w;
  return { cx: (X1 + X2) / 2, cz: z * F0 + t / 2, bottom: Y2, w, h: Y2 - Y1, t, yaw: b.yaw };
}

/** 8 个角点，顺序和 cubeCorners 一致：前面 0-3（左上、右上、右下、左下），后面 4-7 */
export function solidCorners(s: Solid): V3[] {
  const cs = Math.cos(rad(s.yaw)), sn = Math.sin(rad(s.yaw));
  const top = s.bottom - s.h;
  const P = (lx: number, y: number, lz: number): V3 => [s.cx + lx * cs - lz * sn, y, s.cz + lx * sn + lz * cs];
  const face = (lz: number): V3[] => [P(-s.w / 2, top, lz), P(s.w / 2, top, lz), P(s.w / 2, s.bottom, lz), P(-s.w / 2, s.bottom, lz)];
  return [...face(-s.t / 2), ...face(s.t / 2)];
}

/** 本地方向（宽 = x，长 = z）在世界里的单位向量 */
export function solidAxes(s: Solid): { ax: V3; az: V3 } {
  const cs = Math.cos(rad(s.yaw)), sn = Math.sin(rad(s.yaw));
  return { ax: [cs, 0, sn], az: [-sn, 0, cs] };
}

/** 最小尺寸 1 厘米 */
export const minSize = (H: number) => (H / 3) * 0.01;

/**
 * 整理实体：尺寸不小于 1 厘米；长远大于宽时宽、长对调并转 90°（体块的厚度是按宽的倍数存的，最多 3 倍）；
 * 前脸不能贴到初始机位上，也不能太远。
 */
export function normalizeSolid(s: Solid, H: number): Solid {
  const m = minSize(H);
  let w = Math.max(m, s.w), t = Math.max(m, s.t), yaw = s.yaw;
  const h = Math.max(m, s.h);
  if (t > w * 3) {
    [w, t] = [t, w];
    yaw += 90;
  }
  const F0 = f0(H);
  const cz = clamp(s.cz, 0.15 * F0 + t / 2, 12 * F0 + t / 2);
  return { ...s, w, h, t, cz, yaw: Math.round(wrapDeg(yaw) * 10) / 10 };
}

/** 实体 → 原框 + 精确体块 */
export function solidToItem(s0: Solid, W: number, H: number): { bbox: BBox; body: Body; solid: Solid } {
  const s = normalizeSolid(s0, H);
  const F0 = f0(H);
  const z = Math.round(((s.cz - s.t / 2) / F0) * 1e5) / 1e5;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const bbox: BBox = [r((s.cx - s.w / 2) / z + W / 2), r((s.bottom - s.h) / z + H / 2), r((s.cx + s.w / 2) / z + W / 2), r(s.bottom / z + H / 2)];
  const body: Body = { z, thickness: Math.round((s.t / s.w) * 1e5) / 1e5, yaw: s.yaw, anchor: "world", exact: true };
  return { bbox, body, solid: s };
}

// ---------- 支撑面：地面 + 物体顶面 ----------
export interface SupportHit {
  P: V3;
  y: number;
  /** 落在哪个体块顶面上（null = 地面） */
  id: string | null;
  t: number;
}

/** 能放东西的顶面：物体（不含人物、文字、背景板） */
function tops(d: LayoutDraft, exclude?: Set<string>): { id: string; s: Solid }[] {
  const out: { id: string; s: Solid }[] = [];
  for (const it of d.items) {
    if (it.hidden || it.label !== "object" || exclude?.has(it.id)) continue;
    if (bodyOf(it, d).anchor !== "world") continue;
    const s = solidOf(it, d);
    if (s.t <= 0 || s.h <= 0) continue;
    out.push({ id: it.id, s });
  }
  return out;
}

/** 点 (x, z) 在实体占地矩形里（本地坐标，pad = 外扩） */
export function inFootprint(s: Solid, x: number, z: number, pad = 0): boolean {
  const cs = Math.cos(rad(s.yaw)), sn = Math.sin(rad(s.yaw));
  const dx = x - s.cx, dz = z - s.cz;
  const lx = dx * cs + dz * sn, lz = -dx * sn + dz * cs;
  return Math.abs(lx) <= s.w / 2 + pad && Math.abs(lz) <= s.t / 2 + pad;
}

/** 射线打到的最近支撑面（地面或物体顶面） */
export function raySupport(d: LayoutDraft, o: V3, dir: V3, exclude?: Set<string>, ground = groundY(d)): SupportHit | null {
  let best: SupportHit | null = null;
  const tryPlane = (y: number, id: string | null, ok?: (P: V3) => boolean) => {
    if (Math.abs(dir[1]) < 1e-6) return;
    const t = (y - o[1]) / dir[1];
    if (!(t > 1e-6) || (best && t >= best.t)) return;
    const P: V3 = [o[0] + dir[0] * t, y, o[2] + dir[2] * t];
    if (ok && !ok(P)) return;
    best = { P, y, id, t };
  };
  tryPlane(ground, null);
  for (const { id, s } of tops(d, exclude)) tryPlane(s.bottom - s.h, id, (P) => inFootprint(s, P[0], P[2]));
  return best;
}

/** 实体放在 (x, z) 处应该落在哪个面上：最高的、占地包含这一点的物体顶面，否则地面 */
export function supportAt(d: LayoutDraft, x: number, z: number, exclude?: Set<string>, below = Infinity): { y: number; id: string | null } {
  let y = groundY(d), id: string | null = null;
  for (const t of tops(d, exclude)) {
    const top = t.s.bottom - t.s.h;
    if (top < y && top >= below - 1e-6 && inFootprint(t.s, x, z)) { y = top; id = t.id; }
  }
  return { y, id };
}

// ---------- 拟合：让实体在镜头里的投影外接框 = 画的矩形 ----------
function bboxIn(fr: Frame, s: Solid): BBox | null {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const P of solidCorners(s)) {
    const p = project(fr, P);
    if (!p) return null;
    x1 = Math.min(x1, p.u); y1 = Math.min(y1, p.v); x2 = Math.max(x2, p.u); y2 = Math.max(y2, p.v);
  }
  return [x1, y1, x2, y2];
}

/** 实体在机位 cam 下的投影外接框（未裁剪；有角点在镜头后面时返回 null） */
export function solidRect(d: LayoutDraft, s: Solid, cam?: Camera): BBox | null {
  return bboxIn(makeFrame(clampCamera(cam || d.camera || defaultCamera()), d.width, d.height, subjectZ(d)), s);
}

/** 阻尼最小二乘，有限差分雅可比 */
function lm(x0: number[], resid: (x: number[]) => number[] | null, iters = 40): { x: number[]; r: number[] } | null {
  let x = [...x0];
  let r = resid(x);
  if (!r) return null;
  const cost = (v: number[] | null) => (v ? v.reduce((a, b) => a + b * b, 0) : Infinity);
  let c0 = cost(r), lambda = 1e-3;
  const n = x.length;
  for (let it = 0; it < iters && c0 > 1e-14; it++) {
    const m = r.length;
    const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
    let ok = true;
    for (let j = 0; j < n && ok; j++) {
      const h = 1e-5;
      const xp = [...x]; xp[j] += h;
      let rp = resid(xp), hh = h;
      if (!rp) { xp[j] = x[j] - h; rp = resid(xp); hh = -h; }
      if (!rp) { ok = false; break; }
      for (let i = 0; i < m; i++) J[i][j] = (rp[i] - r[i]) / hh;
    }
    if (!ok) break;
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) for (let i = 0; i < m; i++) A[a][b] += J[i][a] * J[i][b];
      for (let i = 0; i < m; i++) g[a] -= J[i][a] * r[i];
    }
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const M = A.map((row, a) => row.map((v, b) => (a === b ? v + lambda * (v + 1e-9) : v)));
      const dlt = gauss(M, g);
      if (!dlt) { lambda *= 10; continue; }
      const xn = x.map((v, i) => v + dlt[i]);
      const rn = resid(xn), cn = cost(rn);
      if (cn < c0) { x = xn; r = rn!; c0 = cn; lambda = Math.max(1e-9, lambda / 3); improved = true; break; }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return { x, r };
}

function gauss(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-15) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** 体型先验：长 / 宽、高 / √(宽×长) */
const PRIOR: Record<"object" | "character", { t: number; h: number }> = {
  object: { t: 0.8, h: 0.8 },
  character: { t: 0.55, h: 4.6 },
};

/**
 * 解实体：底面固定在 bottom、朝向固定，调整占地中心和宽 / 高 / 长，让投影外接框 = rect。
 * prior(s) 给出弱约束（4 个方程 5 个未知数，剩下的自由度交给它）。
 */
function fitSolid(fr: Frame, rect: BBox, init: Solid, S: number, prior: (s: Solid, x: number[]) => number[], minT = 0): { s: Solid; err: number } | null {
  const D = Math.max(1, Math.hypot(rect[2] - rect[0], rect[3] - rect[1]));
  const toS = (x: number[]): Solid => ({ ...init, cx: x[0] * S, cz: x[1] * S, w: Math.exp(x[2]), h: Math.exp(x[3]), t: Math.exp(x[4]) });
  const resid = (x: number[]): number[] | null => {
    if (x.some((v) => !Number.isFinite(v))) return null;
    const s = toS(x);
    if (s.cz - s.t / 2 < minT) return null;
    const b = bboxIn(fr, s);
    if (!b) return null;
    return [(b[0] - rect[0]) / D, (b[1] - rect[1]) / D, (b[2] - rect[2]) / D, (b[3] - rect[3]) / D, ...prior(s, x)];
  };
  const x0 = [init.cx / S, init.cz / S, Math.log(init.w), Math.log(init.h), Math.log(init.t)];
  const out = lm(x0, resid, 60);
  if (!out) return null;
  const s = toS(out.x);
  const b = bboxIn(fr, s);
  if (!b) return null;
  return { s, err: Math.max(...b.map((v, i) => Math.abs(v - rect[i]))) };
}

/** 主体深度变了时补偿机位：镜头光心留在原地，画面不跳 */
export function holdCamera(before: LayoutDraft, after: LayoutDraft): Camera | undefined {
  if (!before.camera) return undefined;
  const pz0 = subjectZ(before), pz1 = subjectZ(after);
  if (Math.abs(pz1 - pz0) < 1e-9) return undefined;
  const C = makeFrame(clampCamera(before.camera), before.width, before.height, pz0).C;
  return cameraAt(before.camera, before.width, before.height, pz1, C);
}

export interface SolidResult {
  bbox: BBox;
  body: Body;
  solid: Solid;
  camera?: Camera;
  /** 落在哪个物体上（null = 地面） */
  on: string | null;
}

/**
 * 镜头视图里画框 → 放在地面（或桌面等物体顶面）上的实体。
 * 例如鸟瞰时画的桌子、饭盒：画出来的是它们的俯视轮廓，这里反推成“平放在桌面上、扁的盒子”，而不是竖起来的高柱子。
 * 起点 / 框下沿打不到任何支撑面（比如画在地平线以上）时返回 null，调用方退回原来的竖立前脸体块。
 */
export function solidFromView(d: LayoutDraft, rect: BBox, label: ItemLabel): SolidResult | null {
  if (label === "text") return null;
  const W = d.width, H = d.height;
  const cam = clampCamera(d.camera || defaultCamera());
  const pz = subjectZ(d);
  const fr = makeFrame(cam, W, H, pz);
  const F0 = f0(H);
  const S = sceneMeter(d);
  const rw = rect[2] - rect[0], rh = rect[3] - rect[1];
  if (rw < 2 || rh < 2) return null;
  // 看下去的程度：0 = 平视，1 = 垂直向下
  const down = clamp(fr.fwd[1] / Math.sin(rad(60)), 0, 1);
  const k = 1 - 0.5 * down;
  const probe = { u: (rect[0] + rect[2]) / 2, v: rect[1] + rh * Math.min(0.985, k) };
  const ray: V3 = [
    fr.fwd[0] + (fr.right[0] * (probe.u - W / 2)) / fr.f + (fr.down[0] * (probe.v - H / 2)) / fr.f,
    fr.fwd[1] + (fr.right[1] * (probe.u - W / 2)) / fr.f + (fr.down[1] * (probe.v - H / 2)) / fr.f,
    fr.fwd[2] + (fr.right[2] * (probe.u - W / 2)) / fr.f + (fr.down[2] * (probe.v - H / 2)) / fr.f,
  ];
  const hit = raySupport(d, fr.C, ray);
  if (!hit) return null;
  const zc = dot(sub(hit.P, fr.C), fr.fwd);
  if (!(zc > fr.near) || zc > F0 * 40) return null;
  const kind = label === "character" ? "character" : "object";
  const pr = PRIOR[kind];
  const w0 = Math.max(minSize(H), (rw * zc) / fr.f);
  const t0 = w0 * pr.t;
  const h0 = kind === "character" ? Math.max((rh * zc) / fr.f * (1 - down), pr.h * Math.sqrt(w0 * t0) * 0.5) : pr.h * Math.sqrt(w0 * t0);
  const o = rad(cam.orbit);
  const hf: V3 = [-Math.sin(o), 0, Math.cos(o)];
  const off = t0 * (k - 0.5);
  const init: Solid = { cx: hit.P[0] + hf[0] * off, cz: hit.P[2] + hf[2] * off, bottom: hit.y, w: w0, h: h0, t: t0, yaw: Math.round(wrapDeg(cam.orbit) * 10) / 10 };
  const lamb = 0.03;
  const prior = (s: Solid) => [lamb * Math.log(s.t / s.w / pr.t), lamb * Math.log(s.h / Math.sqrt(s.w * s.t) / pr.h)];
  const fit = fitSolid(fr, rect, init, S, prior, 0.15 * F0);
  if (!fit || fit.err > Math.max(3, 0.04 * Math.hypot(rw, rh))) return null;
  const out = solidToItem(fit.s, W, H);
  const probeItem = { id: "__new", label, caption: "", bbox: out.bbox, body: out.body } as LayoutItem;
  const camera = holdCamera(d, { ...d, items: [...d.items, probeItem] });
  return { ...out, camera, on: hit.id };
}

/**
 * 镜头视图里拖手柄改大小：rect 是想要的投影外接框（拖动开始时的投影框 + 手柄位移）。
 * 底面和朝向不动，其余按“改动最小”的原则解出来（尽量只改被拉的那个方向）。
 */
export function resizeSolidInView(d: LayoutDraft, id: string, rect: BBox): SolidResult | null {
  const it = d.items.find((x) => x.id === id);
  if (!it || bodyOf(it, d).anchor !== "world") return null;
  const W = d.width, H = d.height;
  const cam = clampCamera(d.camera || defaultCamera());
  const fr = makeFrame(cam, W, H, subjectZ(d));
  const S = sceneMeter(d);
  const s0 = normalizeSolid(solidOf(it, d), H);
  const x0 = [s0.cx / S, s0.cz / S, Math.log(s0.w), Math.log(s0.h), Math.log(s0.t)];
  const lamb = 0.02;
  const prior = (_s: Solid, x: number[]) => x.map((v, i) => lamb * (v - x0[i]));
  const fit = fitSolid(fr, rect, s0, S, prior, 0.15 * f0(H));
  if (!fit) return null;
  const out = solidToItem(fit.s, W, H);
  const after = { ...d, items: d.items.map((x) => (x.id === id ? { ...x, bbox: out.bbox, body: out.body } : x)) };
  return { ...out, camera: holdCamera(d, after), on: null };
}

/** 按实体改一个框（3D 里拉伸 / 键盘 / 面板），返回补丁和需要补偿的机位 */
export function patchSolid(d: LayoutDraft, id: string, s: Solid): { patch: Partial<LayoutItem>; camera?: Camera; solid: Solid } | null {
  const it = d.items.find((x) => x.id === id);
  if (!it) return null;
  const out = solidToItem(s, d.width, d.height);
  const patch: Partial<LayoutItem> = { bbox: out.bbox, body: out.body };
  const after = { ...d, items: d.items.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
  return { patch, camera: holdCamera(d, after), solid: out.solid };
}

// ---------- 常见物体尺寸（米：宽 × 高 × 长） ----------
export interface SizePreset {
  name: string;
  w: number;
  h: number;
  t: number;
  label?: ItemLabel;
  re: RegExp;
}

export const SIZE_PRESETS: SizePreset[] = [
  { name: "成年人", w: 0.5, h: 1.7, t: 0.3, label: "character", re: /(人|男|女|士兵|战士|警察|医生|老师|学生|演员|主角|角色|少年|少女|老人|老奶奶|老爷爷|person|man|woman|soldier|girl|boy|people|character)/i },
  { name: "儿童", w: 0.4, h: 1.2, t: 0.25, label: "character", re: /(儿童|小孩|孩子|小朋友|宝宝|child|kid|baby)/i },
  { name: "桌子", w: 1.2, h: 0.75, t: 0.7, re: /(桌|台面|书桌|办公桌|desk|table)/i },
  { name: "餐桌", w: 1.6, h: 0.75, t: 0.9, re: /(餐桌|饭桌|dining table)/i },
  { name: "茶几", w: 1.0, h: 0.45, t: 0.55, re: /(茶几|coffee table)/i },
  { name: "椅子", w: 0.45, h: 0.9, t: 0.5, re: /(椅|凳|chair|stool)/i },
  { name: "沙发", w: 2.0, h: 0.85, t: 0.9, re: /(沙发|sofa|couch)/i },
  { name: "床", w: 1.5, h: 0.5, t: 2.0, re: /(床|bed)/i },
  { name: "柜子", w: 0.8, h: 1.8, t: 0.45, re: /(柜|书架|架子|cabinet|shelf|wardrobe)/i },
  { name: "门", w: 0.9, h: 2.1, t: 0.05, re: /(门|door)/i },
  { name: "汽车", w: 1.8, h: 1.5, t: 4.5, re: /(汽车|轿车|车辆|小车|car|vehicle|sedan|suv)/i },
  { name: "自行车", w: 0.6, h: 1.0, t: 1.7, re: /(自行车|单车|bike|bicycle)/i },
  { name: "树", w: 2.0, h: 4.5, t: 2.0, re: /(树|tree)/i },
  { name: "木箱", w: 0.6, h: 0.5, t: 0.5, re: /(箱|盒子|crate|box)/i },
  { name: "饭盒", w: 0.2, h: 0.07, t: 0.15, re: /(饭盒|便当|餐盒|lunch ?box|bento)/i },
  { name: "碗", w: 0.15, h: 0.07, t: 0.15, re: /(碗|bowl)/i },
  { name: "盘子", w: 0.25, h: 0.025, t: 0.25, re: /(盘|碟|plate|dish)/i },
  { name: "杯子", w: 0.08, h: 0.1, t: 0.08, re: /(杯|mug|cup|glass)/i },
  { name: "瓶子", w: 0.07, h: 0.25, t: 0.07, re: /(瓶|bottle)/i },
  { name: "筷子", w: 0.24, h: 0.01, t: 0.012, re: /(筷|chopstick)/i },
  { name: "勺子", w: 0.15, h: 0.015, t: 0.035, re: /(勺|调羹|spoon)/i },
  { name: "书", w: 0.15, h: 0.03, t: 0.21, re: /(书|本子|笔记本(?!电脑)|book|notebook)/i },
  { name: "手机", w: 0.075, h: 0.01, t: 0.155, re: /(手机|phone|smartphone)/i },
  { name: "笔记本电脑", w: 0.33, h: 0.02, t: 0.23, re: /(笔记本电脑|电脑|laptop|computer)/i },
  { name: "台灯", w: 0.2, h: 0.45, t: 0.2, re: /(台灯|灯|lamp)/i },
  { name: "步枪", w: 1.0, h: 0.2, t: 0.06, re: /(枪|rifle|gun)/i },
  { name: "狗", w: 0.3, h: 0.6, t: 0.8, re: /(狗|犬|dog|puppy)/i },
  { name: "猫", w: 0.2, h: 0.3, t: 0.45, re: /(猫|cat|kitten)/i },
];

/** 按名称 / 描述猜一个常见尺寸（名称优先） */
export function sizeGuess(name: string, caption = ""): SizePreset | null {
  for (const text of [name, caption]) {
    if (!text.trim()) continue;
    // 越具体（匹配越长）越优先：“餐桌”优先于“桌”
    let best: SizePreset | null = null, bestLen = 0;
    for (const p of SIZE_PRESETS) {
      const m = text.match(p.re);
      if (m && m[0].length > bestLen) { best = p; bestLen = m[0].length; }
    }
    if (best) return best;
  }
  return null;
}

/** 新建时的默认尺寸（米） */
export function defaultSize(label: ItemLabel): { w: number; h: number; t: number } {
  return label === "character" ? { w: 0.5, h: 1.7, t: 0.3 } : { w: 0.5, h: 0.5, t: 0.5 };
}

/** 画出占地后按大小给一个默认高度（米） */
export function defaultHeight(label: ItemLabel, wM: number, tM: number): number {
  if (label === "character") return 1.7;
  return clamp(Math.sqrt(wM * tM) * 0.8, 0.05, 2.5);
}

/** 落地：底面放到它下面最近的支撑面（地面或物体顶面）上 */
export function dropSolid(d: LayoutDraft, id: string, s: Solid): Solid {
  const ex = new Set([id]);
  // 先找占地中心下方、顶面不高于当前底面的支撑
  const sp = supportAt(d, s.cx, s.cz, ex, s.bottom);
  return { ...s, bottom: sp.y };
}

// ---------- 新建画布时的镜头视角 ----------
export interface ViewPreset {
  id: string;
  name: string;
  hint: string;
  cam: Partial<Camera> | null;
  /** 默认放一张桌子当台面（桌面俯拍） */
  table?: boolean;
}

export const VIEW_PRESETS: ViewPreset[] = [
  { id: "eye", name: "平视", hint: "人眼高度看过去，最直观；框就是物体正面", cam: { pitch: 0 } },
  { id: "slight", name: "略微俯拍", hint: "稍高一点往下看，能看到桌面、地面", cam: { pitch: 15 } },
  { id: "high", name: "高机位俯拍", hint: "从高处斜着往下看，适合场景全貌", cam: { pitch: 40 } },
  { id: "bird", name: "鸟瞰", hint: "几乎垂直往下看；画的框是物体的顶面轮廓", cam: { pitch: 78, distance: 1.15 } },
  { id: "table", name: "桌面俯拍", hint: "近距离俯拍桌上的东西（美食、文具），自带一张桌子当台面", cam: { pitch: 62, distance: 0.3 }, table: true },
  { id: "low", name: "低机位仰拍", hint: "从低处往上看，主体显得高大", cam: { pitch: -25 } },
  { id: "side", name: "左前 45°", hint: "斜侧面，立体感强", cam: { orbit: -45, pitch: 10 } },
  { id: "none", name: "暂不设置", hint: "先画平面草图，以后再开摄像机", cam: null },
];

/** 按机位找最接近的视角预设（界面高亮用） */
export function viewPresetOf(c?: Camera | null): string {
  if (!c?.enabled) return "none";
  const d = defaultCamera();
  for (const v of VIEW_PRESETS) {
    if (!v.cam) continue;
    const want = { ...d, ...v.cam };
    // 只比角度：加减体块时为了让镜头不动会换算距离 / 平移，那不算换了视角
    if ((["orbit", "pitch", "roll", "fov"] as const).every((k) => Math.abs(want[k] - c[k]) < 0.6)) return v.id;
  }
  return "";
}

/**
 * 桌面俯拍用的台面：放在镜头光轴落到桌面高度的位置，宽 1.6 m、深 1 m、高 0.75 m。
 * 返回实体（地面 = 空画布的默认地面）；镜头没往下看时返回 null。
 */
export function tableUnderCamera(d: LayoutDraft): Solid | null {
  const cam = clampCamera(d.camera || defaultCamera());
  const fr = makeFrame(cam, d.width, d.height, subjectZ(d));
  const M = sceneMeter(d);
  const g = groundY(d);
  const top = g - 0.75 * M;
  if (fr.fwd[1] < 0.2) return null;
  const k = (top - fr.C[1]) / fr.fwd[1];
  if (!(k > 0)) return null;
  const P: V3 = [fr.C[0] + fr.fwd[0] * k, top, fr.C[2] + fr.fwd[2] * k];
  return { cx: P[0], cz: P[2], bottom: g, w: 1.6 * M, h: 0.75 * M, t: 1.0 * M, yaw: Math.round(wrapDeg(cam.orbit) * 10) / 10 };
}
