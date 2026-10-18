import type { LayoutDraft, LayoutItem, PerspectiveSettings } from "../types";

export type BBox = [number, number, number, number];

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  group: number; // -1 未归类, 0=VP1, 1=VP2, 2=VP3
}

export interface DetectResult {
  ok: boolean;
  message: string;
  patch?: Partial<PerspectiveSettings>;
  segments?: Segment[];
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------------ */
/* 透视缩放：物体立在地面上，图像高度 ∝ (底边 y − 地平线 y)              */
/* ------------------------------------------------------------------ */

/** 拖动时按地平线距离缩放：保持底边落在地面、底边中心跟随鼠标 */
export function moveOnGround(
  orig: BBox,
  dx: number,
  dy: number,
  horizonY: number,
  W: number,
  H: number,
): BBox {
  const [x1, y1, x2, y2] = orig;
  const w = x2 - x1;
  const h = y2 - y1;
  const ob = y2;
  let nb = y2 + dy;
  const eps = 4;
  if (ob - horizonY <= eps) return translateClamped(orig, dx, dy, W, H);
  nb = Math.max(horizonY + eps, Math.min(H, nb));
  let s = (nb - horizonY) / (ob - horizonY);
  // 不超过画布、最小 8px
  s = Math.min(s, W / w, nb / h);
  s = Math.max(s, 8 / Math.min(w, h));
  const nw = w * s;
  const nh = h * s;
  const cx = (x1 + x2) / 2 + dx;
  let nx1 = cx - nw / 2;
  nx1 = clamp(nx1, 0, W - nw);
  const ny1 = Math.max(0, nb - nh);
  return [Math.round(nx1), Math.round(ny1), Math.round(nx1 + nw), Math.round(ny1 + nh)];
}

export function translateClamped(orig: BBox, dx: number, dy: number, W: number, H: number): BBox {
  const [x1, y1, x2, y2] = orig;
  const w = x2 - x1;
  const h = y2 - y1;
  const nx1 = clamp(x1 + dx, 0, W - w);
  const ny1 = clamp(y1 + dy, 0, H - h);
  return [Math.round(nx1), Math.round(ny1), Math.round(nx1 + w), Math.round(ny1 + h)];
}

/**
 * 对齐到透视：以参考框（默认最大的那个）为准，k = h / (底 − 地平线)，
 * 其余框按 k·(底 − 地平线) 重设高度，保持宽高比与底边中心。
 */
export function alignToPerspective(
  items: LayoutItem[],
  ids: string[],
  horizonY: number,
  W: number,
  H: number,
  refId?: string,
): { items: LayoutItem[]; changed: number; skipped: number } {
  const targets = items.filter((it) => it.id && ids.includes(it.id) && !it.locked);
  const grounded = targets.filter((it) => it.bbox[3] - horizonY > 4);
  if (grounded.length < 2) return { items, changed: 0, skipped: targets.length };
  let ref = grounded.find((it) => it.id === refId);
  if (!ref) {
    ref = grounded.reduce((a, b) =>
      (a.bbox[3] - a.bbox[1]) * (a.bbox[2] - a.bbox[0]) >=
      (b.bbox[3] - b.bbox[1]) * (b.bbox[2] - b.bbox[0])
        ? a
        : b,
    );
  }
  const k = (ref.bbox[3] - ref.bbox[1]) / (ref.bbox[3] - horizonY);
  let changed = 0;
  const out = items.map((it) => {
    if (!grounded.includes(it) || it === ref) return it;
    const [x1, y1, x2, y2] = it.bbox;
    const w = x2 - x1;
    const h = y2 - y1;
    let nh = k * (y2 - horizonY);
    let nw = (w / h) * nh;
    const lim = Math.min(1, W / nw, y2 / nh);
    nh *= lim;
    nw *= lim;
    nh = Math.max(8, nh);
    nw = Math.max(8, nw);
    const cx = (x1 + x2) / 2;
    const nx1 = clamp(cx - nw / 2, 0, W - nw);
    changed++;
    return {
      ...it,
      bbox: [Math.round(nx1), Math.round(y2 - nh), Math.round(nx1 + nw), Math.round(y2)] as BBox,
    };
  });
  return { items: out, changed, skipped: targets.length - grounded.length };
}

/* ------------------------------------------------------------------ */
/* 自动估计（按现有框）                                                */
/* ------------------------------------------------------------------ */

/**
 * 假设框是站在同一地面上、真实尺寸相近的物体：h_i ≈ k·(b_i − y0)。
 * 对 (底边 b, 高度 h) 做加权最小二乘 h = a·b + c ⇒ 地平线 y0 = −c / a。
 * 有 ≥2 个人物框时只用人物（人体高度最接近）。
 */
export function estimateFromBoxes(d: LayoutDraft): DetectResult {
  const W = d.width;
  const H = d.height;
  const vis = d.items.filter((it) => !it.hidden && it.label !== "text");
  const chars = vis.filter((it) => it.label === "character");
  const spread = (arr: LayoutItem[]) => {
    const bs = arr.map((it) => it.bbox[3]);
    return arr.length ? Math.max(...bs) - Math.min(...bs) : 0;
  };
  let pool = chars.length >= 2 && spread(chars) > H * 0.03 ? chars : vis;
  if (pool.length < 2) {
    return { ok: false, message: "至少需要 2 个可见的物体/人物框才能估计地平线" };
  }
  if (spread(pool) < H * 0.03) {
    return { ok: false, message: "框的底边几乎在同一高度，无法判断远近；请拉开前后位置或手动设置" };
  }
  let sw = 0, sb = 0, sh = 0, sbb = 0, sbh = 0;
  for (const it of pool) {
    const b = it.bbox[3];
    const h = it.bbox[3] - it.bbox[1];
    const w = Math.sqrt(h); // 大框权重略高（更可靠）
    sw += w; sb += w * b; sh += w * h; sbb += w * b * b; sbh += w * b * h;
  }
  const den = sw * sbb - sb * sb;
  if (Math.abs(den) < 1e-6) return { ok: false, message: "数据退化，无法估计" };
  const a = (sw * sbh - sb * sh) / den;
  const c = (sh - a * sb) / sw;
  if (a <= 0.05) {
    return {
      ok: false,
      message: "这些框不符合「越靠下越大」的近大远小规律（可能真实尺寸差异大），已保持原设置",
    };
  }
  let y0 = -c / a;
  y0 = clamp(y0, -H, 2 * H);
  // VP 水平位置：远处（离地平线近）的物体权重大，再与画面中心折中
  let wx = 0, sx = 0;
  for (const it of pool) {
    const dist = Math.max(it.bbox[3] - y0, H * 0.05);
    const w = 1 / dist;
    wx += w;
    sx += w * ((it.bbox[0] + it.bbox[2]) / 2);
  }
  const vx = Math.round(clamp(0.5 * (sx / wx) + 0.5 * (W / 2), 0, W));
  const used = pool === chars ? `${pool.length} 个人物框` : `${pool.length} 个框`;
  return {
    ok: true,
    message: `已按 ${used} 估计：地平线约在 ${Math.round((y0 / H) * 100)}% 高度`,
    patch: {
      horizon_y: Math.round(y0),
      vp1_x: vx,
      source: "boxes",
    },
  };
}

/* ------------------------------------------------------------------ */
/* 参考图消失点检测：Sobel → 方向约束 Hough → 线段验证 → 交点投票        */
/* ------------------------------------------------------------------ */

interface Seg {
  mx: number;
  my: number;
  dx: number;
  dy: number;
  len: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ang: number; // 与水平夹角 0..90
}

function angDiff(a: number, b: number): number {
  // 方向（模 π）夹角，弧度
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

function intersect(a: Seg, b: Seg): [number, number] | null {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-3) return null;
  const t = ((b.mx - a.mx) * b.dy - (b.my - a.my) * b.dx) / den;
  return [a.mx + a.dx * t, a.my + a.dy * t];
}

function voteVP(
  segs: Seg[],
  bounds: [number, number, number, number],
  tolDeg = 2.5,
): { x: number; y: number; score: number; inliers: Set<number> } | null {
  const tol = (tolDeg * Math.PI) / 180;
  const top = segs
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.len - a.s.len)
    .slice(0, 70);
  let best: { x: number; y: number; score: number } | null = null;
  for (let p = 0; p < top.length; p++) {
    for (let q = p + 1; q < top.length; q++) {
      const A = top[p].s;
      const B = top[q].s;
      if (angDiff(Math.atan2(A.dy, A.dx), Math.atan2(B.dy, B.dx)) < (3 * Math.PI) / 180) continue;
      const pt = intersect(A, B);
      if (!pt) continue;
      const [x, y] = pt;
      if (x < bounds[0] || x > bounds[2] || y < bounds[1] || y > bounds[3]) continue;
      let score = 0;
      for (const s of segs) {
        const vx = x - s.mx;
        const vy = y - s.my;
        if (vx * vx + vy * vy < 1) continue;
        const d = angDiff(Math.atan2(vy, vx), Math.atan2(s.dy, s.dx));
        if (d < tol) score += s.len * (1 - d / tol);
      }
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  if (!best) return null;
  const inliers = new Set<number>();
  segs.forEach((s, i) => {
    const d = angDiff(Math.atan2(best!.y - s.my, best!.x - s.mx), Math.atan2(s.dy, s.dx));
    if (d < tol * 1.4) inliers.add(i);
  });
  return { ...best, inliers };
}

function extractSegments(img: HTMLImageElement | HTMLCanvasElement, maxSide = 480): {
  segs: Seg[];
  w: number;
  h: number;
} {
  const iw = (img as HTMLImageElement).naturalWidth || img.width;
  const ih = (img as HTMLImageElement).naturalHeight || img.height;
  const sc = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(16, Math.round(iw * sc));
  const h = Math.max(16, Math.round(ih * sc));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const g0 = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g0[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  // 3x3 均值模糊
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) s += g0[(y + j) * w + x + k];
      g[y * w + x] = s / 9;
    }
  // Sobel
  const mag = new Float32Array(w * h);
  const ori = new Float32Array(w * h);
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const gx =
        -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
      const gy =
        -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
      mag[i] = Math.hypot(gx, gy);
      let t = Math.atan2(gy, gx); // 法线方向
      if (t < 0) t += Math.PI;
      if (t >= Math.PI) t -= Math.PI;
      ori[i] = t;
    }
  // 阈值：取前 ~10% 的梯度
  const sample: number[] = [];
  for (let i = 0; i < mag.length; i += 7) sample.push(mag[i]);
  sample.sort((a, b) => a - b);
  const thr = Math.max(40, sample[Math.floor(sample.length * 0.9)] || 0);
  const edge = new Uint8Array(w * h);
  for (let i = 0; i < mag.length; i++) if (mag[i] >= thr) edge[i] = 1;

  // 方向约束 Hough：θ 1°，ρ 1px，原点在中心
  const NT = 180;
  const cx = w / 2;
  const cy = h / 2;
  const D = Math.ceil(Math.hypot(w, h) / 2) + 2;
  const NR = 2 * D + 1;
  const acc = new Float32Array(NT * NR);
  const cosT = new Float32Array(NT);
  const sinT = new Float32Array(NT);
  for (let t = 0; t < NT; t++) {
    cosT[t] = Math.cos((t * Math.PI) / NT);
    sinT[t] = Math.sin((t * Math.PI) / NT);
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!edge[i]) continue;
      const tb = Math.round((ori[i] * NT) / Math.PI);
      for (let k = -2; k <= 2; k++) {
        const t = (tb + k + NT) % NT;
        const r = Math.round((x - cx) * cosT[t] + (y - cy) * sinT[t]) + D;
        acc[t * NR + r] += 1;
      }
    }
  // 峰值 NMS
  const minVotes = Math.max(12, Math.min(w, h) * 0.05);
  const peaks: { t: number; r: number; v: number }[] = [];
  for (let t = 0; t < NT; t++)
    for (let r = 0; r < NR; r++) {
      const v = acc[t * NR + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -3; dt <= 3 && isMax; dt++)
        for (let dr = -5; dr <= 5; dr++) {
          if (!dt && !dr) continue;
          const tt = (t + dt + NT) % NT;
          const rr = dt + t < 0 || dt + t >= NT ? NR - 1 - (r + dr) : r + dr;
          if (rr < 0 || rr >= NR) continue;
          if (acc[tt * NR + rr] > v) {
            isMax = false;
            break;
          }
        }
      if (isMax) peaks.push({ t, r, v });
    }
  peaks.sort((a, b) => b.v - a.v);
  const top = peaks.slice(0, 120);

  // 沿每条 Hough 线找实际连续线段（允许 3px 缺口）
  const minLen = Math.max(12, Math.min(w, h) * 0.06);
  const segs: Seg[] = [];
  const oriTol = (12 * Math.PI) / 180;
  for (const pk of top) {
    const th = (pk.t * Math.PI) / NT;
    const nx = Math.cos(th);
    const ny = Math.sin(th);
    const rho = pk.r - D;
    const dx = -ny;
    const dy = nx;
    const bx = cx + nx * rho;
    const by = cy + ny * rho;
    let runStart: number | null = null;
    let lastHit = -1e9;
    const flush = (tEnd: number) => {
      if (runStart === null) return;
      const L = tEnd - runStart;
      if (L >= minLen) {
        const x1 = bx + dx * runStart;
        const y1 = by + dy * runStart;
        const x2 = bx + dx * tEnd;
        const y2 = by + dy * tEnd;
        const a = Math.abs((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI);
        segs.push({
          mx: (x1 + x2) / 2,
          my: (y1 + y2) / 2,
          dx,
          dy,
          len: L,
          x1,
          y1,
          x2,
          y2,
          ang: a > 90 ? 180 - a : a,
        });
      }
      runStart = null;
    };
    for (let t = -D; t <= D; t++) {
      const x = bx + dx * t;
      const y = by + dy * t;
      let hit = false;
      if (x >= 2 && y >= 2 && x < w - 2 && y < h - 2) {
        for (let o = -1; o <= 1 && !hit; o++) {
          const xi = Math.round(x + nx * o);
          const yi = Math.round(y + ny * o);
          const i = yi * w + xi;
          if (edge[i] && angDiff(ori[i], th) < oriTol) hit = true;
        }
      }
      if (hit) {
        if (runStart === null) runStart = t;
        lastHit = t;
      } else if (runStart !== null && t - lastHit > 3) {
        flush(lastHit);
      }
    }
    flush(lastHit);
  }
  return { segs, w, h };
}

/**
 * 从参考图检测消失点。返回的坐标已换算到画布像素（参考图按拉伸铺满画布显示）。
 */
export function detectFromImage(
  img: HTMLImageElement,
  W: number,
  H: number,
): DetectResult {
  let res: ReturnType<typeof extractSegments>;
  try {
    res = extractSegments(img);
  } catch (e) {
    return { ok: false, message: `读取图片像素失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const { segs, w, h } = res;
  const sx = W / w;
  const sy = H / h;
  const toCanvas = (s: Seg, group: number): Segment => ({
    x1: s.x1 * sx,
    y1: s.y1 * sy,
    x2: s.x2 * sx,
    y2: s.y2 * sy,
    group,
  });
  if (segs.length < 4) {
    return { ok: false, message: `只找到 ${segs.length} 条直线，图片缺少明显的透视线（建筑、道路、室内边线）` };
  }
  const oblique = segs.filter((s) => s.ang >= 4 && s.ang <= 78);
  const vertical = segs.filter((s) => s.ang > 78);
  if (oblique.length < 3) {
    return {
      ok: false,
      message: `检测到 ${segs.length} 条线，但倾斜线太少（多为水平/竖直），可能是正对的平视画面；请手动设置`,
      segments: segs.map((s) => toCanvas(s, -1)),
    };
  }
  const bounds: [number, number, number, number] = [-3 * w, -2 * h, 4 * w, 3 * h];
  const v1 = voteVP(oblique, bounds);
  if (!v1 || v1.inliers.size < 3) {
    return {
      ok: false,
      message: "直线方向过于杂乱，未形成稳定的消失点",
      segments: segs.map((s) => toCanvas(s, -1)),
    };
  }
  const rest = oblique.filter((_, i) => !v1.inliers.has(i));
  let v2: ReturnType<typeof voteVP> = null;
  if (rest.length >= 3) {
    const cand = voteVP(rest, bounds);
    if (
      cand &&
      cand.inliers.size >= 3 &&
      cand.score > v1.score * 0.3 &&
      Math.abs(cand.y - v1.y) < h * 0.3 &&
      Math.abs(cand.x - v1.x) > w * 0.6
    ) {
      v2 = cand;
    }
  }
  let v3: ReturnType<typeof voteVP> = null;
  if (vertical.length >= 3) {
    const cand = voteVP(vertical, [-2 * w, -8 * h, 3 * w, 9 * h], 1.5);
    if (cand && cand.inliers.size >= 3 && Math.abs(cand.y - h / 2) < 3 * h) v3 = cand;
  }

  const groupOf = new Map<Seg, number>();
  oblique.forEach((s, i) => v1.inliers.has(i) && groupOf.set(s, 0));
  if (v2) rest.forEach((s, i) => v2!.inliers.has(i) && groupOf.set(s, 1));
  if (v3) vertical.forEach((s, i) => v3!.inliers.has(i) && groupOf.set(s, 2));
  const segments = segs.map((s) => toCanvas(s, groupOf.has(s) ? groupOf.get(s)! : -1));

  let horizon = v1.y;
  if (v2) horizon = (v1.y * v1.score + v2.y * v2.score) / (v1.score + v2.score);
  const patch: Partial<PerspectiveSettings> = {
    horizon_y: Math.round(horizon * sy),
    vp1_x: Math.round(v1.x * sx),
    source: "image",
  };
  let mode: 1 | 2 | 3 = 1;
  if (v2) {
    mode = 2;
    const a = v1.x < v2.x ? v1 : v2;
    const b = v1.x < v2.x ? v2 : v1;
    patch.vp1_x = Math.round(a.x * sx);
    patch.vp2_x = Math.round(b.x * sx);
    if (v3) {
      mode = 3;
      patch.vp3_x = Math.round(v3.x * sx);
      patch.vp3_y = Math.round(v3.y * sy);
    }
  }
  patch.mode = mode;
  const parts = [`${mode} 点透视`, `地平线约 ${Math.round((horizon / h) * 100)}% 高度`];
  if (!v2 && v3) parts.push("（竖线也有汇聚，但只找到一个水平消失点，按 1 点处理）");
  return {
    ok: true,
    message: `检测到 ${segs.length} 条直线 · ${parts.join(" · ")}`,
    patch,
    segments,
  };
}

/* ------------------------------------------------------------------ */
/* 透视描述（前端预览用；后端编译时生成同样的文本）                     */
/* ------------------------------------------------------------------ */

export function horizonLabel(p: PerspectiveSettings, H: number): string {
  const r = p.horizon_y / H;
  if (r < 0) return "地平线在画面上方之外（俯视）";
  if (r < 0.2) return "高地平线（俯视）";
  if (r < 0.4) return "地平线在上三分之一（略俯视）";
  if (r <= 0.6) return "地平线居中（平视）";
  if (r <= 0.8) return "地平线在下三分之一（略仰视）";
  if (r <= 1) return "低地平线（仰视）";
  return "地平线在画面下方之外（强仰视）";
}
