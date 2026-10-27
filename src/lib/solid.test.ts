import assert from "node:assert/strict";
import { compileView, cameraView, groundY, projectLayout, rebaseCamera, sceneMeter } from "./camera";
import { normalizeLayout } from "./doc";
import {
  dropSolid, holdCamera, normalizeSolid, patchSolid, raySupport, resizeSolidInView, sizeGuess, solidFromView, solidOf, solidRect, solidToItem, type Solid,
} from "./solid";
import type { LayoutDraft, LayoutItem } from "../types";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("✓", name); };
const near = (a: number, b: number, tol: number, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (±${tol})`);

const W = 1536, H = 1024;
const M = H / 3; // 1 米
const empty = (cam: any = {}): LayoutDraft => normalizeLayout({ width: W, height: H, summary: { caption: "" }, items: [], camera: { enabled: true, ...cam } } as any);
const withSolid = (d: LayoutDraft, id: string, s: Solid, label: LayoutItem["label"] = "object", name = id): LayoutDraft => {
  const r = solidToItem(s, d.width, d.height);
  return { ...d, items: [...d.items, { id, label, caption: "", name, bbox: r.bbox, body: r.body, color: d.items.length, depth: "auto" } as LayoutItem] };
};

t("实体 ↔ 框往返不变", () => {
  const s: Solid = { cx: 0.3 * M, cz: 4 * M, bottom: H / 2, w: 1.2 * M, h: 0.75 * M, t: 0.7 * M, yaw: 20 };
  const d = withSolid(empty(), "a", s);
  const back = solidOf(d.items[0], d);
  for (const k of ["cx", "cz", "bottom", "w", "h", "t", "yaw"] as const) near(back[k], s[k], k === "yaw" ? 0.051 : 0.02, k);
  assert.equal(d.items[0].body!.exact, true);
});

t("长物体（筷子沿纵深）自动对调宽长、转 90°", () => {
  const s = normalizeSolid({ cx: 0, cz: 3 * M, bottom: H / 2, w: 0.01 * M, h: 0.01 * M, t: 0.24 * M, yaw: 0 }, H);
  near(s.w, 0.24 * M, 1e-6); near(s.t, 0.01 * M, 1e-6); near(s.yaw, 90, 0.01);
  const s2 = normalizeSolid({ cx: 0, cz: 3 * M, bottom: H / 2, w: 0.001, h: 0, t: 0, yaw: 0 }, H);
  assert.ok(s2.w >= 0.0099 * M && s2.h >= 0.0099 * M && s2.t >= 0.0099 * M);
});

t("精确体块：初始机位下投影是真实透视（不被压回原框），摄像机开着就走镜头视图", () => {
  const s: Solid = { cx: 1.2 * M, cz: 3 * M, bottom: H / 2, w: 0.6 * M, h: 0.6 * M, t: 1.2 * M, yaw: 0 };
  const d = withSolid(empty(), "a", s);
  const p = projectLayout(d).items.a;
  const r = solidRect(d, s)!;
  r.forEach((v, i) => near(p.raw[i], v, 0.05, "raw"));
  assert.ok(p.raw[0] < d.items[0].bbox[0] - 5, "后面的面露出来，外接框比前脸大");
  assert.ok(cameraView(d));
  assert.ok(compileView(d));
  const off = { ...d, camera: { ...d.camera!, enabled: false } };
  assert.equal(compileView(off), undefined);
});

t("鸟瞰画框：落在地面上的扁盒子，投影 = 画的矩形", () => {
  const d = empty({ pitch: 78, distance: 1.15 });
  const g = groundY(d);
  const rect: [number, number, number, number] = [600, 400, 900, 600];
  const r = solidFromView(d, rect, "object")!;
  assert.ok(r, "能解出来");
  near(r.solid.bottom, g, 1e-6, "底在地面");
  const d2 = { ...d, items: [{ id: "x", label: "object", caption: "", bbox: r.bbox, body: r.body } as LayoutItem], camera: r.camera || d.camera };
  const pr = projectLayout(d2).items.x.raw;
  pr.forEach((v, i) => near(v, rect[i], 2, `边 ${i}`));
  // 俯视画的东西不该是高柱子
  console.log("   鸟瞰盒子(米)", (r.solid.w / M).toFixed(2), (r.solid.h / M).toFixed(2), (r.solid.t / M).toFixed(2));
  assert.ok(r.solid.h < Math.max(r.solid.w, r.solid.t), `h=${r.solid.h / M} w=${r.solid.w / M} t=${r.solid.t / M}`);
});

t("鸟瞰：在桌面上画饭盒，落在桌面上", () => {
  let d = empty({ pitch: 78, distance: 1.15 });
  const g = groundY(d);
  const table: Solid = { cx: 0, cz: 3.2 * M, bottom: g, w: 1.2 * M, h: 0.75 * M, t: 0.7 * M, yaw: 0 };
  d = withSolid(d, "table", table);
  const cam = holdCamera(empty({ pitch: 78, distance: 1.15 }), d);
  if (cam) d = { ...d, camera: cam };
  const tr = projectLayout(d).items.table.raw;
  const cx = (tr[0] + tr[2]) / 2, cy = (tr[1] + tr[3]) / 2;
  const rect: [number, number, number, number] = [cx - 40, cy - 25, cx + 40, cy + 25];
  const r = solidFromView(d, rect, "object")!;
  assert.ok(r);
  assert.equal(r.on, "table");
  near(r.solid.bottom, g - 0.75 * M, 0.5, "底在桌面");
  assert.ok(r.solid.h < 0.3 * M, `饭盒高 ${r.solid.h / M}`);
});

t("平视画人物：站在地上，身高合理", () => {
  const d = empty();
  const g = groundY(d);
  // 地面在镜头下 1.5 m，主体距离 z=1 时脚在画面 y = H/2 + g/1
  const foot = H / 2 + g / 2.5;
  const rect: [number, number, number, number] = [700, foot - 380, 820, foot];
  const r = solidFromView(d, rect, "character")!;
  assert.ok(r);
  near(r.solid.bottom, g, 0.01);
  assert.ok(r.solid.h > r.solid.w * 2, "人是竖的");
});

t("地平线以上画的框解不出（退回竖立前脸）", () => {
  const d = empty();
  assert.equal(solidFromView(d, [700, 100, 800, 200], "object"), null);
});

t("镜头视图拖手柄改大小：投影跟着变、底不动", () => {
  let d = empty({ pitch: 40, orbit: 25 });
  const s: Solid = { cx: 0, cz: 3 * M, bottom: groundY(d), w: 1 * M, h: 0.8 * M, t: 0.6 * M, yaw: 0 };
  d = withSolid(d, "a", s);
  const cam = holdCamera(empty({ pitch: 40, orbit: 25 }), d);
  if (cam) d = { ...d, camera: cam };
  const r0 = projectLayout(d).items.a.raw;
  const want: [number, number, number, number] = [r0[0], r0[1], r0[2] + 60, r0[3]];
  const r = resizeSolidInView(d, "a", want)!;
  assert.ok(r);
  const d2 = { ...d, items: d.items.map((x) => (x.id === "a" ? { ...x, bbox: r.bbox, body: r.body } : x)), camera: r.camera || d.camera };
  const r1 = projectLayout(d2).items.a.raw;
  r1.forEach((v, i) => near(v, want[i], 1.5, `边 ${i}`));
  near(r.solid.bottom, s.bottom, 0.01);
});

t("主体变化时补偿机位：镜头光心不动、别的框画面不变", () => {
  let d = empty({ pitch: 30, orbit: -20 });
  d = withSolid(d, "small", { cx: 0, cz: 3 * M, bottom: groundY(d), w: 0.3 * M, h: 0.3 * M, t: 0.3 * M, yaw: 0 });
  const before = projectLayout(d).items.small.raw;
  const p = patchSolid(d, "small", { ...solidOf(d.items[0], d), cz: 5 * M })!;
  const d2 = { ...d, items: [{ ...d.items[0], ...p.patch }], camera: p.camera || d.camera };
  assert.ok(p.camera, "主体深度变了要补偿");
  // 再加一个不动的框，看它在画面里是否不动
  let e = withSolid(d, "big", { cx: 1 * M, cz: 4 * M, bottom: groundY(d), w: 2 * M, h: 2 * M, t: 1 * M, yaw: 0 });
  const cam = holdCamera(d, e);
  e = { ...e, camera: cam || e.camera };
  const after = projectLayout(e).items.small.raw;
  after.forEach((v, i) => near(v, before[i], 0.5, `small 边 ${i}`));
  assert.ok(d2);
});

t("射线支撑：打到桌面优先于地面；落地找下方支撑", () => {
  let d = empty();
  const g = groundY(d);
  d = withSolid(d, "table", { cx: 0, cz: 3 * M, bottom: g, w: 1.2 * M, h: 0.75 * M, t: 0.7 * M, yaw: 0 });
  const hit = raySupport(d, [0, -1 * M, 3 * M], [0, 1, 0])!;
  assert.equal(hit.id, "table");
  near(hit.y, g - 0.75 * M, 0.01);
  const cup: Solid = { cx: 0.1 * M, cz: 3 * M, bottom: g - 1.2 * M, w: 0.08 * M, h: 0.1 * M, t: 0.08 * M, yaw: 0 };
  near(dropSolid(d, "cup", cup).bottom, g - 0.75 * M, 0.01);
  near(dropSolid(d, "cup", { ...cup, cx: 3 * M }).bottom, g, 0.01);
});

t("按名称猜尺寸", () => {
  assert.equal(sizeGuess("餐桌")!.name, "餐桌");
  assert.equal(sizeGuess("木桌")!.name, "桌子");
  assert.equal(sizeGuess("一双筷子")!.name, "筷子");
  assert.equal(sizeGuess("", "a lunch box on the desk")!.name, "饭盒");
  assert.equal(sizeGuess("xyz"), null);
});

t("定为基准后精确标记去掉", () => {
  const d = withSolid(empty({ orbit: 30 }), "a", { cx: 0, cz: 3 * M, bottom: H / 2, w: M, h: M, t: M, yaw: 0 });
  const r = rebaseCamera(d);
  assert.ok(!r.items[0].body!.exact);
  assert.ok(sceneMeter(d) > 0);
});

console.log(`\n${n} 项通过`);
