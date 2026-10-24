import assert from "node:assert/strict";
import { applyChanges, diffDocs, wordDiff } from "./changeset";
import {
  alignGroupDepth, applyMoveResult, autoFrame, baseBounds, bodyOf, bringIntoView, cameraAt, cameraCenter, compileView, dragInView, dragOnPlan,
  estimateBodies, insideFrame, itemFromView, measureItems, moveTargets, planView, projectLayout, rebaseCamera, solveFraming, subjectItem,
} from "./camera";
import { emptyDoc, expandGroups, normalizeLayout } from "./doc";
import type { LayoutDraft } from "../types";

const lay: LayoutDraft = normalizeLayout({
  width: 1024, height: 1536,
  summary: { caption: "A girl on a rooftop." },
  items: [
    { id: "sky", label: "object", caption: "evening sky background", bbox: [0, 0, 1024, 1536] },
    { id: "cat", label: "object", caption: "a cat", bbox: [650, 1100, 900, 1400], body: { z: 1.6, thickness: 0.6, yaw: 0, anchor: "world" } },
    { id: "girl", label: "character", caption: "a girl", bbox: [300, 500, 700, 1450], body: { z: 1, thickness: 0.45, yaw: 0, anchor: "world" } },
    { id: "title", label: "text", caption: "title", text: "黄昏", bbox: [100, 80, 900, 260] },
  ],
} as any);

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log("✓", name);
};

t("初始机位投影 = 原框", () => {
  const p = projectLayout(lay, { ...lay.camera!, enabled: true });
  for (const it of lay.items) {
    const b = p.items[it.id].bbox;
    it.bbox.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= 1, `${it.id} ${b} vs ${it.bbox}`));
  }
  assert.deepEqual(p.order, ["sky", "cat", "girl", "title"]);
});

t("环绕 180° 后前后反转、文字不动", () => {
  const p = projectLayout(lay, { ...lay.camera!, enabled: true, orbit: 180 });
  assert.equal(p.order[0], "sky");
  assert.equal(p.order[p.order.length - 1], "title");
  assert.ok(p.order.indexOf("cat") > p.order.indexOf("girl"), p.order.join(","));
  assert.deepEqual(p.items.title.bbox, lay.items[3].bbox);
});

t("俯拍：地平线上移、主体仍在画内", () => {
  const p = projectLayout(lay, { ...lay.camera!, enabled: true, pitch: 30 });
  assert.ok(p.items.girl.visible);
  assert.ok(p.horizon && (p.horizon.a.y + p.horizon.b.y) / 2 < 1536 / 2);
});

t("推近：框变大", () => {
  const p = projectLayout(lay, { ...lay.camera!, enabled: true, distance: 0.6 });
  const w0 = 400;
  const g = p.items.girl.raw;
  assert.ok(g[2] - g[0] > w0 * 1.3);
});

t("compileView 在初始机位时为空；定为基准后机位归零", () => {
  assert.equal(compileView({ ...lay, camera: { ...lay.camera!, enabled: true } }), undefined);
  const moved = { ...lay, camera: { ...lay.camera!, enabled: true, orbit: 40, pitch: 10 } };
  const v = compileView(moved)!;
  assert.ok(v && v.items.girl.visible);
  const r = rebaseCamera(moved);
  assert.equal(r.camera!.orbit, 0);
  const g = r.items.find((x) => x.id === "girl")!;
  assert.equal(g.body!.yaw, -40);
  assert.deepEqual(g.bbox, v.items.girl.bbox);
});

t("改动拆分与部分采纳", () => {
  const base = { ...emptyDoc(), layout: lay };
  const next = JSON.parse(JSON.stringify(base));
  next.layout.summary.caption = "A girl and a cat on a rooftop.";
  next.layout.items[2].caption = "a girl in a red coat";
  next.layout.items.splice(1, 1);
  next.layout.items.push({ id: "moon", label: "object", caption: "moon", bbox: [700, 100, 850, 250] });
  const ch = diffDocs(base, next);
  const keys = ch.map((c) => c.key);
  assert.deepEqual(keys.sort(), ["add:moon", "rm:cat", "summary", "up:girl"].sort());
  const part = applyChanges(base, base, next, new Set(["add:moon", "up:girl"]));
  assert.deepEqual(part.layout.items.map((x) => x.id), ["sky", "cat", "girl", "title", "moon"]);
  assert.equal(part.layout.items[2].caption, "a girl in a red coat");
  assert.equal(part.layout.summary.caption, "A girl on a rooftop.");
});

t("词级 diff", () => {
  const d = wordDiff("a girl in a coat", "a girl in a red coat");
  assert.ok(d.some((s) => s.op === "add" && s.t.includes("red")));
  const z = wordDiff("红色外套", "蓝色外套");
  assert.ok(z.some((s) => s.op === "del" && s.t === "红") && z.some((s) => s.op === "add" && s.t === "蓝"));
});

t("solveFraming：环绕后主体回到原位置与大小", () => {
  const cam = { ...lay.camera!, enabled: true, orbit: 50, pitch: 20 };
  const before = measureItems(lay, cam, ["girl"])!;
  const b0 = baseBounds(lay, ["girl"])!;
  const sol = solveFraming(lay, cam, ["girl"], { cx: (b0[0] + b0[2]) / 2, cy: (b0[1] + b0[3]) / 2, size: Math.sqrt((b0[2] - b0[0]) * (b0[3] - b0[1])) });
  const after = measureItems(lay, sol, ["girl"])!;
  const c = (b: number[]) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const err = (b: number[]) => Math.hypot(c(b)[0] - c(b0)[0], c(b)[1] - c(b0)[1]);
  assert.ok(err(after) < 3, `center err ${err(after)} (before ${err(before)})`);
  const sz = Math.sqrt((after[2] - after[0]) * (after[3] - after[1]));
  const sz0 = Math.sqrt((b0[2] - b0[0]) * (b0[3] - b0[1]));
  assert.ok(Math.abs(sz / sz0 - 1) < 0.01, `size ${sz} vs ${sz0}`);
  assert.equal(sol.orbit, 50);
  assert.equal(sol.pitch, 20);
});

t("solveFraming：只解平移时距离不变", () => {
  const cam = { ...lay.camera!, enabled: true, orbit: -70 };
  const sol = solveFraming(lay, cam, ["cat"], { cx: 512, cy: 768 }, ["pan_x", "pan_y"]);
  assert.equal(sol.distance, cam.distance);
  const b = measureItems(lay, sol, ["cat"])!;
  assert.ok(Math.abs((b[0] + b[2]) / 2 - 512) < 2 && Math.abs((b[1] + b[3]) / 2 - 768) < 2, String(b));
});

t("autoFrame fit：全部收进画面", () => {
  const cam = { ...lay.camera!, enabled: true, orbit: 120, pitch: 35, distance: 0.5 };
  const ids = ["cat", "girl"];
  assert.ok(!insideFrame(measureItems(lay, cam, ids), 1024, 1536));
  const sol = autoFrame(lay, cam, "fit");
  const b = measureItems(lay, sol, ids)!;
  assert.ok(insideFrame(b, 1024, 1536, 2), String(b));
  // 至少一边贴着 6% 边距
  const fill = Math.max((b[2] - b[0]) / (1024 * 0.88), (b[3] - b[1]) / (1536 * 0.88));
  assert.ok(Math.abs(fill - 1) < 0.01, String(fill));
});

t("autoFrame smart：初始机位下不动", () => {
  const cam = { ...lay.camera!, enabled: true };
  const sol = autoFrame(lay, cam, "smart");
  assert.ok(Math.abs(sol.distance - 1) < 1e-3 && Math.abs(sol.pan_x) < 1e-3 && Math.abs(sol.pan_y) < 1e-3, JSON.stringify(sol));
});

t("planView：初始机位在原点、看向 +z", () => {
  const p = planView(lay, { ...lay.camera!, enabled: true });
  assert.ok(Math.abs(p.cam.x) < 1e-6 && Math.abs(p.cam.z) < 1e-6);
  assert.ok(Math.abs(p.cam.fz - 1) < 1e-6);
  assert.equal(p.items.length, 2);
  const q = planView(lay, { ...lay.camera!, enabled: true, orbit: 90 });
  assert.ok(q.cam.x > 0 && Math.abs(q.cam.z - p.pivot.z) < 1e-6, JSON.stringify(q.cam));
  assert.ok(q.cam.fx < -0.99);
});

const ctr = (b: number[]) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const shot = (d: LayoutDraft, id: string) => measureItems(d, d.camera!, [id])!;
/** 体块中心的世界坐标（用于检查组内相对位置） */
const worldCenter = (d: LayoutDraft, id: string) => {
  const it = d.items.find((x) => x.id === id)!;
  const z = bodyOf(it, d).z;
  return [((it.bbox[0] + it.bbox[2]) / 2 - d.width / 2) * z, ((it.bbox[1] + it.bbox[3]) / 2 - d.height / 2) * z, z];
};
const CAMS = [
  { orbit: 35, pitch: 15 }, { orbit: -80, pitch: 5 }, { orbit: 150, pitch: -20, distance: 1.4 }, { orbit: 20, pitch: -10, distance: 0.6 }, { orbit: 10, pitch: 50, fov: 70 },
];

t("cameraAt：换主体深度后镜头光心不变", () => {
  for (const c of CAMS) {
    const d: LayoutDraft = { ...lay, camera: { ...lay.camera!, enabled: true, ...c, pan_x: 0.2, pan_y: -0.1 } };
    const C = cameraCenter(d);
    const same = cameraAt(d.camera!, 1024, 1536, 1, C);
    for (const k of ["distance", "pan_x", "pan_y", "pan_z"] as const) assert.ok(Math.abs(same[k] - d.camera![k]) < 1e-9, k);
    const d2 = { ...d, items: d.items.map((x) => (x.id === "girl" ? { ...x, body: { ...x.body!, z: 1.3 } } : x)) };
    const cam2 = cameraAt(d.camera!, 1024, 1536, 1.3, C);
    const C2 = cameraCenter(d2, cam2);
    assert.ok(Math.hypot(C2[0] - C[0], C2[1] - C[1], C2[2] - C[2]) < 1e-6, JSON.stringify(c));
  }
});

t("dragInView：拖哪个框都跟着鼠标走，别的框在画面里不动（含主体）", () => {
  for (const cam of CAMS) {
    const d: LayoutDraft = { ...lay, camera: { ...lay.camera!, enabled: true, ...cam } };
    for (const id of ["cat", "girl"]) {
      const before = shot(d, id);
      const r = dragInView(d, id, [id], 60, -40, "fixed");
      assert.ok(r && r.patches[id]?.bbox, `${id} ${JSON.stringify(cam)}`);
      const d2 = applyMoveResult(d, r!);
      const after = shot(d2, id);
      const ddx = ctr(after)[0] - ctr(before)[0], ddy = ctr(after)[1] - ctr(before)[1];
      assert.ok(Math.abs(ddx - 60) < 1.5 && Math.abs(ddy + 40) < 1.5, `${id} ${JSON.stringify(cam)} moved ${ddx.toFixed(1)},${ddy.toFixed(1)}`);
      const other = id === "cat" ? "girl" : "cat";
      const o1 = shot(d, other), o2 = shot(d2, other);
      o1.forEach((v, i) => assert.ok(Math.abs(v - o2[i]) < 0.05, `${other} moved ${o1} → ${o2}`));
      // 镜头固定：光心位置不变
      const C1 = cameraCenter(d), C2 = cameraCenter(d2);
      assert.ok(Math.hypot(C1[0] - C2[0], C1[1] - C2[1], C1[2] - C2[2]) < 1e-3);
    }
  }
});

t("成组：拖一个，整组做同样的世界平移（相对位置不变）", () => {
  const g = normalizeLayout({ ...lay, items: lay.items.map((x) => (x.id === "cat" || x.id === "girl" ? { ...x, group: "g1" } : x)) } as any);
  const d: LayoutDraft = { ...g, camera: { ...g.camera!, enabled: true, orbit: 55, pitch: 18 } };
  const ids = moveTargets(d, ["cat"], "free", "cat").ids;
  assert.deepEqual(ids.sort(), ["cat", "girl"]);
  const r = dragInView(d, "cat", ids, -80, 30, "fixed")!;
  const d2 = applyMoveResult(d, r);
  const rel = (x: LayoutDraft) => worldCenter(x, "cat").map((v, i) => v - worldCenter(x, "girl")[i]);
  rel(d).forEach((v, i) => assert.ok(Math.abs(v - rel(d2)[i]) < 0.5, `rel ${rel(d)} → ${rel(d2)}`));
  const c0 = ctr(shot(d, "cat")), c1 = ctr(shot(d2, "cat"));
  assert.ok(Math.abs(c1[0] - c0[0] + 80) < 1.5 && Math.abs(c1[1] - c0[1] - 30) < 1.5);
  // 换任何机位，两者的投影相对关系都和没拖之前一样整体平移（这里只验证世界坐标刚体）
  assert.deepEqual(expandGroups(d.items, ["girl"]).sort(), ["cat", "girl"]);
});

t("冻结模式：所有 3D 体块一起动，文字 / 背景板不动；锁定的组整组不动", () => {
  const d: LayoutDraft = { ...lay, camera: { ...lay.camera!, enabled: true, orbit: -40 } };
  assert.deepEqual(moveTargets(d, ["cat"], "frozen", "cat").ids.sort(), ["cat", "girl"]);
  assert.deepEqual(moveTargets(d, ["title"], "frozen", "title").ids, ["title"]);
  const locked = normalizeLayout({ ...lay, items: lay.items.map((x) => (x.id === "cat" ? { ...x, group: "g", locked: true } : x.id === "girl" ? { ...x, group: "g" } : x)) } as any);
  const m = moveTargets(locked, ["girl"], "free", "girl");
  assert.deepEqual(m.ids, []);
  assert.equal(m.pinned, 2);
});

t("镜头随主体：拖主体时镜头一起平移，主体在画面里不动", () => {
  const d: LayoutDraft = { ...lay, camera: { ...lay.camera!, enabled: true, orbit: 30, pitch: 10 } };
  const r = dragInView(d, "girl", ["girl"], 50, 0, "subject")!;
  assert.ok(r.camFollowed && r.camera);
  const d2 = applyMoveResult(d, r);
  const a = shot(d, "girl"), b = shot(d2, "girl");
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 0.5, `girl ${a} → ${b}`));
  // 不是主体的框：镜头不跟
  const r2 = dragInView(d, "cat", ["cat"], 50, 0, "subject")!;
  assert.ok(!r2.camFollowed);
});

t("冻结 + 镜头随主体：当前画面完全不变，只改原构图", () => {
  for (const cam of CAMS) {
    const d: LayoutDraft = { ...lay, camera: { ...lay.camera!, enabled: true, ...cam } };
    const ids = moveTargets(d, ["girl"], "frozen", "girl").ids;
    const r = dragInView(d, "girl", ids, -70, 40, "subject");
    if (!r) continue;
    const d2 = applyMoveResult(d, r);
    for (const id of ids) {
      const a = shot(d, id), b = shot(d2, id);
      a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 0.6, `${id} ${JSON.stringify(cam)} ${a} → ${b}`));
    }
    assert.ok(d2.items.some((x, i) => x.bbox.some((v, j) => Math.abs(v - d.items[i].bbox[j]) > 1)), "原构图应该变");
  }
});

t("拉回画面：出画 / 镜头后面的框挪回画内，镜头不动", () => {
  for (const cam of [{ orbit: 0, pan_x: 0.9 }, { orbit: 170, pitch: 5, distance: 0.4 }, { orbit: 60, distance: 0.5, pan_y: 0.5 }]) {
    const d: LayoutDraft = { ...lay, camera: { ...lay.camera!, enabled: true, ...cam } };
    const r = bringIntoView(d, "cat", ["cat"]);
    if (!r) { assert.ok(insideFrame(shot(d, "cat"), 1024, 1536, 1)); continue; }
    const d2 = applyMoveResult(d, r);
    assert.ok(insideFrame(shot(d2, "cat"), 1024, 1536, 2), `${JSON.stringify(cam)} ${shot(d2, "cat")}`);
    const C1 = cameraCenter(d), C2 = cameraCenter(d2);
    assert.ok(Math.hypot(C1[0] - C2[0], C1[1] - C2[1], C1[2] - C2[2]) < 1e-3);
  }
});

t("俯视图拖动：在地面上平移，高度不变", () => {
  const d: LayoutDraft = { ...lay, camera: { ...lay.camera!, enabled: true, orbit: 90 } };
  const r = dragOnPlan(d, ["cat"], 200, 300, "fixed")!;
  const d2 = applyMoveResult(d, r);
  const w0 = worldCenter(d, "cat"), w1 = worldCenter(d2, "cat");
  assert.ok(Math.abs(w1[0] - w0[0] - 200) < 1 && Math.abs(w1[1] - w0[1]) < 1, `${w0} → ${w1}`);
  const pv = planView(d2, d2.camera!), pv0 = planView(d, d.camera!);
  const c0 = pv0.items.find((x) => x.id === "cat")!.center, c1 = pv.items.find((x) => x.id === "cat")!.center;
  assert.ok(Math.abs(c1.z - c0.z - 300) < 1, `${c0.z} → ${c1.z}`);
});

t("成组对齐远近：手持物对齐到人物深度，原框不变；只剩一个成员的组自动解散", () => {
  const d = normalizeLayout({
    width: 1536, height: 1024, summary: { caption: "" },
    items: [
      { id: "sol", label: "character", caption: "soldier", bbox: [880, 120, 1220, 900], body: { z: 1, thickness: 0.45, yaw: 0, anchor: "world" } },
      { id: "gun", label: "object", caption: "rifle", bbox: [300, 420, 1000, 520], body: { z: 2.3, thickness: 0.6, yaw: 0, anchor: "world" } },
      { id: "rock", label: "object", caption: "rock", bbox: [100, 600, 300, 700], group: "lonely" },
    ],
  } as any);
  assert.equal(d.items[2].group, undefined);
  const r = alignGroupDepth(d, ["sol", "gun"]);
  assert.equal(r.aligned.length, 1);
  assert.equal(r.patches.gun.body!.z, 0.97);
  assert.equal(r.patches.gun.bbox, undefined);
  // 同组的两个人物：小的跟着大的估算深度
  const e = normalizeLayout({
    width: 1536, height: 1024, summary: { caption: "" },
    items: [
      { id: "a", label: "character", caption: "adult", bbox: [600, 100, 1000, 1000], group: "g" },
      { id: "b", label: "character", caption: "child", bbox: [700, 500, 900, 700], group: "g" },
    ],
  } as any);
  assert.ok(Math.abs(bodyOf(e.items[1], e).z - bodyOf(e.items[0], e).z * 0.97) < 0.02);
});

t("估算体块：手持物跟随角色深度", () => {
  const d = normalizeLayout({
    width: 1536, height: 1024, summary: { caption: "" },
    items: [
      { id: "sol", label: "character", caption: "soldier", bbox: [880, 120, 1220, 900] },
      { id: "gun", label: "object", caption: "rifle", bbox: [300, 420, 1000, 520] },
      { id: "rock", label: "object", caption: "rock", bbox: [100, 600, 300, 700] },
    ],
  } as any);
  const zs = bodyOf(d.items[0], d).z, zg = bodyOf(d.items[1], d).z, zr = bodyOf(d.items[2], d).z;
  assert.ok(Math.abs(zg - zs * 0.97) < 0.02, `${zg} vs ${zs}`);
  assert.ok(zr > zs, "不相干的物体仍按地平线估");
  const e = estimateBodies(d);
  assert.equal(e.items[1].body!.z, zg);
});

t("镜头视图里画框：投影正好是画出的矩形，别的框不动", () => {
  const base = estimateBodies(lay);
  const d: LayoutDraft = { ...base, camera: { ...base.camera!, enabled: true, orbit: 35, pitch: 12, distance: 1.2 } };
  const before = projectLayout(d);
  // 画在女孩身上（深度取女孩）、画在空地（取主体深度）、画一个比主体还大的角色（主体变了，机位要补偿）
  const cases: [number[], "object" | "character", { x: number; y: number }][] = [
    [[420, 700, 560, 820], "object", { x: 430, y: 710 }],
    [[60, 1200, 220, 1380], "object", { x: 61, y: 1201 }],
    [[80, 300, 700, 1500], "character", { x: 81, y: 301 }],
  ];
  for (const [rect, label, start] of cases) {
    const r = itemFromView(d, rect as any, label, start)!;
    assert.ok(r && r.body.anchor === "world");
    const n2: LayoutDraft = { ...d, camera: r.camera || d.camera, items: [...d.items, { id: "new", label, caption: "", bbox: r.bbox, color: 0, depth: "auto", body: r.body } as any] };
    const p = projectLayout(n2);
    p.items.new.raw.forEach((v, i) => assert.ok(Math.abs(v - rect[i]) <= 1.5, `${label} ${p.items.new.raw} vs ${rect}`));
    for (const it of d.items) before.items[it.id].raw.forEach((v, i) => assert.ok(Math.abs(v - p.items[it.id].raw[i]) <= 1, `${it.id} 跳了`));
    if (label === "character") assert.ok(r.camera, "新主体要补偿机位");
  }
  const onGirl = itemFromView(d, [420, 700, 560, 820], "object", { x: 430, y: 710 })!;
  const girlZ = bodyOf(d.items[2], d).z;
  assert.ok(Math.abs(onGirl.body.z - girlZ) < 0.25, `画在女孩身上的深度 ${onGirl.body.z} ≈ ${girlZ}`);
  const txt = itemFromView(d, [10, 10, 200, 80], "text")!;
  assert.equal(txt.body.anchor, "screen");
  assert.deepEqual(txt.bbox, [10, 10, 200, 80]);
});

console.log(`${n} passed`);
