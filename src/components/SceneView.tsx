/**
 * 镜头调度室 · 3D 场景：自由视角看整个场景（体块、拍摄镜头的视锥和画框、灯位），
 * 在这里直接拖体块（地面上平移，Shift 上下）、拖镜头、拖灯。所有改动和主画布同步、可撤销。
 */
import { Box, Camera as CameraIcon, Check, Grid3x3, Lightbulb, PersonStanding, Plus, SunDim, Trash2, User, X } from "lucide-react";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bodyOf, cameraMoved, moveTargets, sceneData, translateItems, wrapDeg, type Vec3 } from "../lib/camera";
import { boxColor, itemName } from "../lib/doc";
import { normalizeLighting, vecAngles } from "../lib/lighting";
import {
  drawGhost, drawScaleFigure, drawScene, drawSolidEdit, lightPos, obsFrame, pointInPoly, presetObs, projectPt, rayAt, rayPlane, raySphere, v3,
  type DrawItem, type HandleHit, type HandleKind, type HitMap, type Obs, type ObsFrame, type ObsPreset,
} from "../lib/scene3d";
import {
  SIZE_PRESETS, defaultHeight, defaultSize, dropSolid, minSize, normalizeSolid, raySupport, sizeGuess, solidAxes, solidCorners, solidOf, supportAt, type SizePreset, type Solid,
} from "../lib/solid";
import { addSolidItem, applyMove, removeItems, select, setLighting, toast, updateItem, updateSolid, useStore, withGroup } from "../store";
import type { Camera, ItemLabel, LayoutDraft } from "../types";
import { AutoTextarea, Seg, cx } from "../ui";

type V3 = Vec3;
const OBS = new Map<string, Obs>();
const PREF_KEY = "moss.scene.prefs";
interface ScenePrefs { grid: boolean; lights: boolean; shadows: boolean; scale: boolean; newLabel: "object" | "character" }
const loadPrefs = (): ScenePrefs => {
  const d: ScenePrefs = { grid: true, lights: true, shadows: true, scale: true, newLabel: "object" };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; } catch { return d; }
};

const PRESETS: { v: ObsPreset; t: string; title: string }[] = [
  { v: "persp", t: "透视", title: "斜上方看整个场景（双击空白处也会回到这里）" },
  { v: "top", t: "顶视", title: "从正上方看：站位、机位和灯位" },
  { v: "front", t: "正面", title: "从机位方向看过去" },
  { v: "side", t: "侧面", title: "从侧面看：前后距离、高度" },
  { v: "shot", t: "机位", title: "从拍摄镜头的位置看（和画面一致）" },
];

/** 新建后的命名浮层里给的常用尺寸 */
const QUICK_SIZES: Record<"object" | "character", string[]> = {
  object: ["桌子", "椅子", "木箱", "柜子", "汽车", "杯子", "碗", "饭盒", "书", "手机"],
  character: ["成年人", "儿童"],
};
const presetByName = (n: string) => SIZE_PRESETS.find((p) => p.name === n)!;
const fmt2 = (v: number) => (v >= 0.1 ? v.toFixed(2) : v.toFixed(3));

/** 射线到直线（P, u）的最近点参数；几乎平行时返回 null */
function axisParam(r: { o: V3; d: V3 }, P: V3, u: V3): number | null {
  const w0 = v3.sub(r.o, P);
  const b = v3.dot(r.d, u);
  const den = 1 - b * b;
  if (den < 0.03) return null;
  return (v3.dot(u, w0) - b * v3.dot(r.d, w0)) / den;
}
/** 屏幕上沿轴拖动 dx, dy 像素 ≈ 轴向多少世界单位（射线法失效时的退路） */
function screenAxis(F: ObsFrame, P: V3, u: V3, unit: number, dx: number, dy: number): number {
  const a = projectPt(F, P), b = projectPt(F, v3.add(P, v3.mul(u, unit)));
  if (!a || !b) return 0;
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  if (l < 2) return 0;
  return ((dx * (b.x - a.x) + dy * (b.y - a.y)) / l) * (unit / l);
}

export function SceneView({ L, cam, pageId, selection, hover, setHover, onCam, activeLight, setActiveLight }: {
  L: LayoutDraft;
  cam: Camera;
  pageId: string;
  selection: string[];
  hover: string | null;
  setHover: (id: string | null) => void;
  onCam: (p: Partial<Camera>, key?: string) => void;
  activeLight: string | null;
  setActiveLight: (id: string | null) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [prefs, setPrefsState] = useState<ScenePrefs>(loadPrefs);
  const setPrefs = (p: Partial<ScenePrefs>) => setPrefsState((o) => {
    const n = { ...o, ...p };
    try { localStorage.setItem(PREF_KEY, JSON.stringify(n)); } catch { /* ignore */ }
    return n;
  });
  const sd = useMemo(() => sceneData(L, cam), [L, cam]);
  const lighting = useMemo(() => (L.lighting ? normalizeLighting(L.lighting) : null), [L.lighting]);
  const [obs, setObsState] = useState<Obs | null>(() => OBS.get(pageId) || null);
  const obsRef = useRef<Obs | null>(obs);
  obsRef.current = obs;
  const setObs = (o: Obs) => { OBS.set(pageId, o); obsRef.current = o; setObsState(o); };
  const anim = useRef(0);
  const hit = useRef<HitMap | null>(null);
  const [cursor, setCursor] = useState("");
  const [mode, setMode] = useState<"" | "orbit" | "pan" | "item" | "cam" | "light" | "create" | "handle">("");
  // ---- 新建实体 / 编辑手柄 ----
  const [creating, setCreating] = useState(false);
  const [ghost, setGhost] = useState<Solid | null>(null);
  const [namer, setNamer] = useState<string | null>(null);
  const [hoverHandle, setHoverHandle] = useState<HandleKind | null>(null);
  const [activeHandle, setActiveHandle] = useState<HandleKind | null>(null);
  const [focused, setFocused] = useState(false);
  const handles = useRef<HandleHit[]>([]);
  const meter = sd.meter;
  const clickSolid = (P: V3, y: number): Solid => {
    const z = defaultSize(prefs.newLabel);
    return { cx: P[0], cz: P[2], bottom: y, w: z.w * meter, h: z.h * meter, t: z.t * meter, yaw: 0 };
  };
  const footSolid = (A: V3, B: V3, y: number, square: boolean): Solid => {
    let dx = B[0] - A[0], dz = B[2] - A[2];
    if (square) { const m = Math.max(Math.abs(dx), Math.abs(dz)); dx = Math.sign(dx || 1) * m; dz = Math.sign(dz || 1) * m; }
    const mn = minSize(L.height);
    const w = Math.max(mn, Math.abs(dx)), t = Math.max(mn, Math.abs(dz));
    const h = defaultHeight(prefs.newLabel, w / meter, t / meter) * meter;
    return { cx: A[0] + dx / 2, cz: A[2] + dz / 2, bottom: y, w, h, t, yaw: 0 };
  };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((en) => {
      const r = en[0].contentRect;
      const w = Math.floor(r.width), h = Math.floor(r.height);
      setSize((p) => (p.w === w && p.h === h ? p : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 切页 / 第一次量到尺寸：取默认视角
  useEffect(() => {
    if (!size.w || !size.h) return;
    const o = OBS.get(pageId);
    if (o) { obsRef.current = o; setObsState(o); }
    else setObs(presetObs(sd, cam, "persp", size.w / size.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, size.w > 0 && size.h > 0]);

  const animateObs = (to: Obs) => {
    cancelAnimationFrame(anim.current);
    const from = obsRef.current || to;
    const t0 = performance.now();
    const dy = wrapDeg(to.yaw - from.yaw);
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 280);
      const k = 1 - Math.pow(1 - t, 3);
      const lerp = (a: number, b: number) => a + (b - a) * k;
      setObs({
        yaw: from.yaw + dy * k, pitch: lerp(from.pitch, to.pitch), fov: lerp(from.fov, to.fov),
        dist: Math.exp(lerp(Math.log(from.dist), Math.log(to.dist))),
        target: [lerp(from.target[0], to.target[0]), lerp(from.target[1], to.target[1]), lerp(from.target[2], to.target[2])],
      });
      if (t < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(anim.current), []);
  const goPreset = (k: ObsPreset) => animateObs(presetObs(sd, cam, k, size.w / Math.max(1, size.h)));

  const items = useMemo(() => {
    const m = new Map<string, DrawItem>();
    L.items.forEach((it, i) => m.set(it.id, { id: it.id, color: boxColor(it, i), index: i, name: itemName(it, i), hidden: !!it.hidden, locked: !!it.locked }));
    return m;
  }, [L.items]);
  const moved = cameraMoved(L);
  const selSet = useMemo(() => new Set(selection), [selection]);
  // 单选一个 3D 体块时显示手柄 / 尺寸
  const edit = useMemo(() => {
    if (selection.length !== 1 || creating) return null;
    const it = L.items.find((x) => x.id === selection[0]);
    if (!it || it.hidden || it.label === "text" || bodyOf(it, L).anchor !== "world") return null;
    const s = solidOf(it, L);
    return { id: it.id, s, locked: !!it.locked, support: supportAt(L, s.cx, s.cz, new Set([it.id]), s.bottom).y };
  }, [L, selection, creating]);
  const subjSolid = useMemo(() => {
    let best: Solid | null = null;
    for (const it of L.items) {
      if (it.hidden || it.label !== "character" || bodyOf(it, L).anchor !== "world") continue;
      const s = solidOf(it, L);
      if (!best || s.h > best.h) best = s;
    }
    return best;
  }, [L]);

  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !obs || !size.w || !size.h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(size.w * dpr) || c.height !== Math.round(size.h * dpr)) {
      c.width = Math.round(size.w * dpr);
      c.height = Math.round(size.h * dpr);
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const F = obsFrame(obs, size.w, size.h);
    hit.current = drawScene(ctx, {
      sd, items, F, cam, moved, lighting, selection: selSet, hover, grid: prefs.grid,
      showLights: prefs.lights, shadows: prefs.shadows, activeLight, dpr,
    });
    handles.current = [];
    if (prefs.scale) {
      // 比例人：站在选中（或主体）体块的右手边，帮新手判断大小
      const ref = edit?.s || subjSolid;
      const right = v3.norm([F.right[0], 0, F.right[2]]);
      const feet: V3 = ref
        ? [ref.cx + right[0] * (Math.max(ref.w, ref.t) / 2 + meter * 0.45), sd.ground, ref.cz + right[2] * (Math.max(ref.w, ref.t) / 2 + meter * 0.45)]
        : [sd.pivot[0] + right[0] * meter * 0.8, sd.ground, sd.pivot[2] + right[2] * meter * 0.8];
      drawScaleFigure(ctx, F, feet, meter);
    }
    if (ghost) drawGhost(ctx, F, ghost, meter, "#f0a04b");
    else if (edit) {
      handles.current = drawSolidEdit(ctx, F, edit.s, {
        meter, ground: sd.ground, support: edit.support, color: items.get(edit.id)?.color || "#f0a04b", active: activeHandle, hover: hoverHandle, locked: edit.locked,
      });
    }
    (c as unknown as { __hit?: HitMap & { handles?: HandleHit[] } }).__hit = { ...hit.current, handles: handles.current }; // 供自动化测试读取命中区域
  }, [sd, items, obs, size, cam, moved, lighting, selSet, hover, prefs, activeLight, ghost, edit, subjSolid, activeHandle, hoverHandle, meter]);

  // ---------- 命中 ----------
  type Hit = { kind: "light"; id: string } | { kind: "cam" } | { kind: "item"; id: string } | null;
  const handleAt = (x: number, y: number): HandleKind | null => {
    let best: HandleKind | null = null, bd = 11;
    for (const h of handles.current) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bd) { bd = d; best = h.kind; }
    }
    return best;
  };
  const hitTest = (x: number, y: number): Hit => {
    const h = hit.current;
    if (!h) return null;
    for (let i = h.lights.length - 1; i >= 0; i--) if (Math.hypot(h.lights[i].x - x, h.lights[i].y - y) < 13) return { kind: "light", id: h.lights[i].id };
    if (h.camera && Math.hypot(h.camera.x - x, h.camera.y - y) < 12) return { kind: "cam" };
    for (let i = h.items.length - 1; i >= 0; i--) if (pointInPoly(x, y, h.items[i].poly)) return { kind: "item", id: h.items[i].id };
    return null;
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const drag = useRef<null | {
    kind: "orbit" | "pan" | "item" | "cam" | "light" | "create" | "handle"; x: number; y: number; moved: boolean; key: string; obs: Obs;
    /** 新建：起点（支撑面上）和支撑面高度 */
    P0?: V3; y0?: number;
    /** 手柄：哪个、起始实体、轴、起始参数 */
    handle?: HandleKind; id?: string; s0?: Solid; axP?: V3; axU?: V3; t0?: number | null; a0r?: number;
    ids?: string[]; base?: LayoutDraft; plane?: { P: V3; n: V3 }; vertical?: boolean;
    cam0?: Camera; a0?: number; r0?: number; T?: V3;
    light?: string; far?: boolean; add?: boolean; clickId?: string | null;
  }>(null);

  const onDown = (e: React.PointerEvent) => {
    if (e.button > 2 || !obs) return;
    if ((e.target as HTMLElement).closest(".scene-ui")) return;
    e.preventDefault();
    e.stopPropagation();
    cancelAnimationFrame(anim.current);
    wrap.current!.setPointerCapture(e.pointerId);
    const p = local(e);
    const F = obsFrame(obs, size.w, size.h);
    const key = `scene${Date.now()}`;
    const base = { x: e.clientX, y: e.clientY, moved: false, key, obs };
    wrap.current!.focus({ preventScroll: true });
    if (namer) setNamer(null);
    if (creating && e.button === 0) {
      const r = rayAt(F, p.x, p.y);
      const sup = raySupport(L, r.o, r.d, undefined, sd.ground);
      if (sup) {
        drag.current = { ...base, kind: "create", P0: sup.P, y0: sup.y };
        setGhost(clickSolid(sup.P, sup.y));
        return;
      }
      toast("这里打不到地面：往下一点（地平线以下）再画", "info");
    }
    const hk = e.button === 0 && !creating ? handleAt(p.x, p.y) : null;
    if (hk && edit && !edit.locked) {
      const s0 = edit.s;
      const { ax, az } = solidAxes(s0);
      const mid: V3 = [s0.cx, s0.bottom - s0.h / 2, s0.cz];
      const r = rayAt(F, p.x, p.y);
      let axP: V3 = mid, axU: V3 = [0, -1, 0];
      if (hk === "h") axP = [s0.cx, s0.bottom - s0.h, s0.cz];
      else if (hk === "w+" || hk === "w-") { axU = hk === "w+" ? ax : v3.mul(ax, -1); axP = v3.add(mid, v3.mul(axU, s0.w / 2)); }
      else if (hk === "t+" || hk === "t-") { axU = hk === "t+" ? az : v3.mul(az, -1); axP = v3.add(mid, v3.mul(axU, s0.t / 2)); }
      const rp = hk === "rot" ? rayPlane(r, [0, s0.bottom, 0], [0, 1, 0]) : null;
      drag.current = {
        ...base, kind: "handle", handle: hk, id: edit.id, s0, axP, axU,
        t0: hk === "rot" ? null : axisParam(r, axP, axU),
        a0r: rp ? Math.atan2(rp[2] - s0.cz, rp[0] - s0.cx) : undefined,
      };
      setActiveHandle(hk);
      return;
    }
    const pan = e.button === 1 || e.button === 2 || (e.shiftKey && e.button === 0 && !hitTest(p.x, p.y));
    const h = e.button === 0 ? hitTest(p.x, p.y) : null;
    if (h?.kind === "light" && lighting) {
      setActiveLight(h.id);
      const P = lightPos(sd, lighting, cam, h.id);
      const S = hit.current!.lightCenter;
      const far = !!P && v3.dot(v3.sub(P, S), v3.sub(F.eye, S)) < 0;
      drag.current = { ...base, kind: "light", light: h.id, far };
      return;
    }
    if (h?.kind === "cam") {
      const C = sd.frame.C;
      const r = rayAt(F, p.x, p.y);
      const P = rayPlane(r, C, [0, 1, 0]) || C;
      const T = sd.pivot;
      const v = [P[0] - T[0], P[2] - T[2]];
      drag.current = { ...base, kind: "cam", cam0: { ...cam }, a0: Math.atan2(v[0], -v[1]), r0: Math.max(1e-6, Math.hypot(v[0], v[1])), T };
      return;
    }
    if (h?.kind === "item") {
      const st = useStore.getState();
      const id = h.id;
      const solo = e.altKey;
      const sel = st.selection;
      const unit = withGroup([id], solo);
      const add = e.ctrlKey || e.metaKey;
      const ids = add ? (sel.includes(id) ? sel.filter((x) => !unit.includes(x)) : [...sel, ...unit.filter((x) => !sel.includes(x))])
        : sel.includes(id) && !solo ? sel : unit;
      select(ids);
      const it = L.items.find((x) => x.id === id);
      const si = sd.items.find((x) => x.id === id);
      if (!it || !si || si.anchor !== "world" || add || !ids.includes(id)) { drag.current = null; return; }
      const t = moveTargets(L, ids, st.moveScope, id, solo);
      if (!t.ids.length) {
        if (t.pinned) toast("锁定的框（或组里有锁定的框）不能移动");
        drag.current = null;
        return;
      }
      const r = rayAt(F, p.x, p.y);
      const vertical = e.shiftKey;
      const hf = v3.norm([F.fwd[0], 0, F.fwd[2]]);
      const plane = vertical ? { P: si.center, n: (Math.hypot(F.fwd[0], F.fwd[2]) > 1e-3 ? hf : [0, 0, 1]) as V3 } : { P: si.center, n: [0, 1, 0] as V3 };
      const P0 = rayPlane(r, plane.P, plane.n);
      if (!P0) { drag.current = null; return; }
      drag.current = { ...base, kind: "item", ids: t.ids, base: L, P0, plane, vertical };
      return;
    }
    drag.current = { ...base, kind: pan ? "pan" : "orbit", add: e.ctrlKey || e.metaKey };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const p = local(e);
    if (!d) {
      if (creating) { setCursor("crosshair"); return; }
      const hk = handleAt(p.x, p.y);
      if (hk !== hoverHandle) setHoverHandle(hk);
      if (hk) { setCursor(hk === "rot" ? "grab" : hk === "h" ? "ns-resize" : "ew-resize"); return; }
      const h = hitTest(p.x, p.y);
      const id = h?.kind === "item" ? h.id : null;
      if (id !== hover) setHover(id);
      setCursor(h?.kind === "item" ? (sd.items.find((x) => x.id === id)?.anchor === "world" ? "move" : "pointer") : h ? "grab" : "");
      return;
    }
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    if (!d.moved) { d.moved = true; setMode(d.kind); }
    const o = d.obs;
    if (d.kind === "create") {
      const F = obsFrame(o, size.w, size.h);
      const P = rayPlane(rayAt(F, p.x, p.y), [0, d.y0!, 0], [0, 1, 0]);
      if (!P) return;
      setGhost(footSolid(d.P0!, P, d.y0!, e.shiftKey));
      return;
    }
    if (d.kind === "handle") {
      const F = obsFrame(o, size.w, size.h);
      const r = rayAt(F, p.x, p.y);
      const s0 = d.s0!;
      const mn = minSize(L.height);
      const snap = (v: number) => (e.shiftKey ? Math.max(mn, Math.round(v / (meter * 0.05)) * meter * 0.05) : v);
      let s1: Solid = s0;
      if (d.handle === "rot") {
        const P = rayPlane(r, [0, s0.bottom, 0], [0, 1, 0]);
        if (!P || d.a0r === undefined) return;
        let yaw = s0.yaw + ((Math.atan2(P[2] - s0.cz, P[0] - s0.cx) - d.a0r) * 180) / Math.PI;
        if (e.shiftKey) yaw = Math.round(yaw / 15) * 15;
        s1 = { ...s0, yaw: Math.round(wrapDeg(yaw) * 10) / 10 };
      } else {
        const tt = d.t0 !== null && d.t0 !== undefined ? axisParam(r, d.axP!, d.axU!) : null;
        const delta = tt !== null && d.t0 !== null && d.t0 !== undefined ? tt - d.t0 : screenAxis(F, d.axP!, d.axU!, meter * 0.5, dx, dy);
        const lim = meter * 30;
        const dl = Math.max(-lim, Math.min(lim, delta));
        if (d.handle === "h") s1 = { ...s0, h: snap(Math.max(mn, s0.h + dl)) };
        else {
          const wide = d.handle === "w+" || d.handle === "w-";
          const cur = wide ? s0.w : s0.t;
          const both = e.altKey;
          const nv = snap(Math.max(mn, cur + (both ? 2 * dl : dl)));
          const shift = both ? 0 : (nv - cur) / 2;
          const c = v3.add([s0.cx, 0, s0.cz], v3.mul(d.axU!, shift));
          s1 = wide ? { ...s0, w: nv, cx: c[0], cz: c[2] } : { ...s0, t: nv, cx: c[0], cz: c[2] };
        }
      }
      updateSolid(d.id!, s1, d.key);
      return;
    }
    if (d.kind === "orbit") {
      setObs({ ...o, yaw: o.yaw + dx * 0.35, pitch: Math.max(-89, Math.min(89, o.pitch + dy * 0.3)) });
    } else if (d.kind === "pan") {
      const F = obsFrame(o, size.w, size.h);
      const k = o.dist / F.f;
      setObs({ ...o, target: v3.add(o.target, v3.add(v3.mul(F.right, -dx * k), v3.mul(F.down, -dy * k))) });
    } else if (d.kind === "item") {
      const F = obsFrame(o, size.w, size.h);
      const P = rayPlane(rayAt(F, p.x, p.y), d.plane!.P, d.plane!.n);
      if (!P) return;
      let T: V3 = v3.sub(P, d.P0!);
      T = d.vertical ? [0, T[1], 0] : [T[0], 0, T[2]];
      const lim = sd.D0 * 12;
      if (v3.len(T) > lim) T = v3.mul(v3.norm(T), lim);
      applyMove(translateItems(d.base!, d.ids!, T, useStore.getState().moveHold), d.key);
    } else if (d.kind === "cam") {
      const c0 = d.cam0!;
      if (e.shiftKey) {
        onCam({ pitch: c0.pitch + dy * 0.3 }, d.key);
        return;
      }
      const F = obsFrame(o, size.w, size.h);
      const P = rayPlane(rayAt(F, p.x, p.y), sd.frame.C, [0, 1, 0]);
      if (!P) return;
      const v = [P[0] - d.T![0], P[2] - d.T![2]];
      const a = Math.atan2(v[0], -v[1]);
      onCam({ orbit: wrapDeg(c0.orbit + ((a - d.a0!) * 180) / Math.PI), distance: c0.distance * (Math.hypot(v[0], v[1]) / d.r0!) }, d.key);
    } else if (d.kind === "light" && lighting) {
      const F = obsFrame(o, size.w, size.h);
      const S = hit.current!.lightCenter, R = hit.current!.lightRadius;
      const P = raySphere(rayAt(F, p.x, p.y), S, R, !!d.far);
      const a = vecAngles(v3.sub(P, S));
      const follow = lighting.follow;
      const az = wrapDeg(a.azimuth - (follow && cam.enabled ? cam.orbit : 0));
      const id = d.light!;
      setLighting((lg) => ({ preset: "", lights: lg.lights.map((l) => (l.id === id ? { ...l, azimuth: Math.round(az * 10) / 10, elevation: a.elevation } : l)) }), d.key);
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setMode("");
    if (d?.kind === "handle") { setActiveHandle(null); return; }
    if (d?.kind === "create") {
      const g = ghost;
      setGhost(null);
      setCreating(false);
      if (!g) return;
      const label = prefs.newLabel as ItemLabel;
      const n = normalizeSolid(g, L.height);
      if (Math.abs(n.cz - g.cz) > meter * 0.02) toast("离初始机位太近，已往前挪了一点", "info");
      const id = addSolidItem(g, label);
      if (id) setNamer(id);
      return;
    }
    if (!d || d.moved || e.button !== 0) return;
    if (d.kind === "orbit") {
      const p = local(e);
      if (!hitTest(p.x, p.y) && !d.add) select([]);
    }
  };

  /** 把观察视角对准某个体块并拉近到合适大小（小物件如饭盒、筷子离得远时手柄会挤在一起） */
  const focusItem = (id: string) => {
    const o = obsRef.current;
    const it = L.items.find((x) => x.id === id);
    if (!o || !it) return;
    const so = solidOf(it, L);
    const diag = Math.hypot(so.w, so.h, so.t);
    const fit = diag / (2 * Math.tan(((o.fov || 50) * Math.PI) / 360)) / 0.22;
    const dist = Math.max(sd.D0 * 0.05, Math.min(sd.D0 * 60, Math.max(fit, meter * 1.0)));
    animateObs({ ...o, target: [so.cx, so.bottom - so.h / 2, so.cz], dist });
  };
  const onDbl = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".scene-ui") || !obs || creating) return;
    if (handleAt(local(e).x, local(e).y)) return;
    const p = local(e);
    const h = hitTest(p.x, p.y);
    if (h?.kind === "item") { focusItem(h.id); return; }
    if (!h) goPreset("persp");
  };

  // 滚轮缩放（非被动监听，阻止 WebView 缩放）
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    if ((e.target as HTMLElement).closest(".scene-ui")) return;
    e.preventDefault();
    const o = obsRef.current;
    if (!o) return;
    const dv = e.deltaY || e.deltaX;
    if (!dv) return;
    cancelAnimationFrame(anim.current);
    setObs({ ...o, dist: Math.max(sd.D0 * 0.05, Math.min(sd.D0 * 60, o.dist * (dv > 0 ? 1.1 : 1 / 1.1))) });
  };
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fn = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, []);

  // ---------- 键盘（场景获得焦点时） ----------
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
    const k = e.key;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === "Escape") {
      if (namer) { setNamer(null); return stop(); }
      if (creating) { setCreating(false); setGhost(null); return stop(); }
      return;
    }
    if ((k === "n" || k === "N") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      setCreating((v) => !v);
      setNamer(null);
      return stop();
    }
    if ((k === "f" || k === "F") && !e.ctrlKey && !e.metaKey && !e.altKey && selection.length) {
      focusItem(selection[0]);
      return stop();
    }
    if (!edit || e.ctrlKey && (k === "z" || k === "y")) return;
    const it = L.items.find((x) => x.id === edit.id);
    if (!it) return;
    if (k === "Delete" || k === "Backspace") { removeItems([edit.id]); setNamer(null); return stop(); }
    if (edit.locked) {
      if (k.startsWith("Arrow") || "qQeEgG".includes(k)) { toast("锁定的框不能修改"); stop(); }
      return;
    }
    const step = meter * (e.altKey ? 0.01 : e.ctrlKey || e.metaKey ? 0.25 : 0.05);
    const sg = e.shiftKey ? -1 : 1;
    const s0 = edit.s;
    const mn = minSize(L.height);
    let s1: Solid | null = null;
    if (k === "ArrowUp") s1 = { ...s0, h: Math.max(mn, s0.h + sg * step) };
    else if (k === "ArrowRight") s1 = { ...s0, w: Math.max(mn, s0.w + sg * step) };
    else if (k === "ArrowLeft") s1 = { ...s0, w: Math.max(mn, s0.w - sg * step) };
    else if (k === "ArrowDown") s1 = { ...s0, t: Math.max(mn, s0.t + sg * step) };
    else if (k === "q" || k === "Q" || k === "e" || k === "E") {
      const d = (e.shiftKey ? 5 : 15) * (k.toLowerCase() === "q" ? -1 : 1);
      s1 = { ...s0, yaw: Math.round(wrapDeg(s0.yaw + d) * 10) / 10 };
    } else if (k === "g" || k === "G") {
      s1 = dropSolid(L, edit.id, s0);
      if (Math.abs(s1.bottom - s0.bottom) < 1e-6) { toast("已经落在地面 / 桌面上了"); return stop(); }
    }
    if (!s1) return;
    updateSolid(edit.id, s1, `scene-key-${edit.id}`);
    stop();
  };

  // ---------- 命名浮层 ----------
  const nIt = namer ? L.items.find((x) => x.id === namer) : undefined;
  useEffect(() => { if (namer && !nIt) setNamer(null); }, [namer, nIt]);
  const namerPos = (() => {
    if (!nIt || !obs) return null;
    const so = solidOf(nIt, L);
    const F = obsFrame(obs, size.w, size.h);
    // 放在体块投影外接框的旁边（优先右侧，放不下再放左侧 / 下方），不挡住刚建的体块和手柄
    const pts = solidCorners(so).map((P) => projectPt(F, P)).filter((q): q is NonNullable<typeof q> => !!q);
    const NW = 272, NH = 250, gap = 34;
    if (!pts.length) return { left: Math.max(8, size.w - NW - 12), top: 48 };
    const x1 = Math.min(...pts.map((q) => q.x)), x2 = Math.max(...pts.map((q) => q.x));
    const y1 = Math.min(...pts.map((q) => q.y)), y2 = Math.max(...pts.map((q) => q.y));
    const top = Math.max(44, Math.min(size.h - NH - 40, (y1 + y2) / 2 - NH / 2));
    let left: number;
    if (x2 + gap + NW <= size.w - 8) left = x2 + gap;
    else if (x1 - gap - NW >= 8) left = x1 - gap - NW;
    else return { left: Math.max(8, Math.min(size.w - NW - 8, (x1 + x2) / 2 - NW / 2)), top: y2 + 16 + NH <= size.h - 40 ? y2 + 16 : Math.max(44, y1 - NH - 16) };
    return { left, top };
  })();
  const applySize = (id: string, p: SizePreset) => {
    const it = L.items.find((x) => x.id === id);
    if (!it) return;
    const so = solidOf(it, L);
    updateSolid(id, dropSolid(L, id, { ...so, w: p.w * meter, h: p.h * meter, t: p.t * meter }), "", !it.name ? { name: p.name } : undefined);
  };
  const closeNamer = () => { setNamer(null); wrap.current?.focus({ preventScroll: true }); };

  const lgOn = !!lighting?.enabled;
  const nSel = selection.length;
  const selName = nSel === 1 ? (() => { const k = L.items.findIndex((x) => x.id === selection[0]); return k >= 0 ? itemName(L.items[k], k) : ""; })() : "";

  return (
    <div ref={wrap} tabIndex={0} className={cx("scene-view", mode && `is-${mode}`, creating && "is-creating")} style={{ cursor: mode ? undefined : cursor || undefined }}
      onKeyDown={onKey} onFocus={() => setFocused(true)} onBlur={(e) => { if (!wrap.current?.contains(e.relatedTarget as Node)) setFocused(false); }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={onDbl}
      onPointerCancel={() => { drag.current = null; setMode(""); }} onPointerLeave={() => !drag.current && hover && setHover(null)}
      onContextMenu={(e) => e.preventDefault()}>
      <canvas ref={canvas} className="scene-canvas" style={{ width: size.w, height: size.h }} />
      <div className="scene-ui scene-top">
        <span className="scene-title"><Box size={12} />3D 场景</span>
        <div className="scene-seg">
          {PRESETS.map((p) => (
            <button key={p.v} type="button" title={p.title} onClick={() => goPreset(p.v)}>
              {p.v === "shot" && <CameraIcon size={11} />}{p.t}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <div className={cx("scene-add", creating && "on")}>
          <button type="button" className="scene-add-btn" onClick={() => { setCreating(!creating); setNamer(null); wrap.current?.focus({ preventScroll: true }); }}
            title="在地面或桌面上拖出占地范围，直接按真实尺寸建体块（N）">
            <Plus size={12} />体块
          </button>
          <button type="button" className={cx("scene-add-kind", prefs.newLabel === "object" && "on")} onClick={() => setPrefs({ newLabel: "object" })} title="新建物体"><Box size={11} /></button>
          <button type="button" className={cx("scene-add-kind", prefs.newLabel === "character" && "on")} onClick={() => setPrefs({ newLabel: "character" })} title="新建角色（默认 1.7 m 高）"><User size={11} /></button>
        </div>
        <button type="button" className={cx("scene-tg", prefs.scale && "on")} onClick={() => setPrefs({ scale: !prefs.scale })} title="比例人：1.7 米高的参照剪影"><PersonStanding size={13} /></button>
        <button type="button" className={cx("scene-tg", prefs.grid && "on")} onClick={() => setPrefs({ grid: !prefs.grid })} title="地面网格（每格约 1 米，按主体身高换算）"><Grid3x3 size={13} /></button>
        <button type="button" className={cx("scene-tg", prefs.shadows && "on")} onClick={() => setPrefs({ shadows: !prefs.shadows })} title="地面阴影（按主光方向投影）"><SunDim size={13} /></button>
        <button type="button" className={cx("scene-tg", prefs.lights && "on")} disabled={!lgOn} onClick={() => setPrefs({ lights: !prefs.lights })} title={lgOn ? "显示灯位（可直接拖动）" : "灯光未开启：在右侧「灯光」里打开"}><Lightbulb size={13} /></button>
      </div>
      {selName && <div className="scene-ui scene-sel"><span className="dot" style={{ background: items.get(selection[0])?.color }} />{selName}</div>}
      {nIt && namerPos && (
        <div className="scene-ui scene-namer" style={namerPos} onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.stopPropagation(); closeNamer(); }
            if (e.key === "Enter" && !e.shiftKey && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); closeNamer(); }
          }}>
          <div className="namer-head">
            <Seg small value={nIt.label === "character" ? "character" : "object"} onChange={(v) => {
                // 改成角色时按成年人尺寸（之前是物体的小盒子）；改回物体时尺寸不动
                const so = solidOf(nIt, L);
                if (v === "character" && so.h < meter * 1.2) {
                  const p = presetByName("成年人");
                  updateSolid(nIt.id, dropSolid(L, nIt.id, { ...so, w: p.w * meter, h: p.h * meter, t: p.t * meter }), "", { label: v });
                } else updateItem(nIt.id, { label: v });
                setPrefs({ newLabel: v });
              }}
              options={[{ v: "object", t: <><Box size={11} />物体</> }, { v: "character", t: <><User size={11} />角色</> }]} />
            <div className="spacer" />
            <button type="button" className="btn btn-ghost btn-xs btn-icon" title="关闭（Esc）" onClick={closeNamer}><X size={13} /></button>
          </div>
          <input className="input input-sm" autoFocus value={nIt.name || ""} placeholder={nIt.label === "character" ? "名称，例如：女孩 / 士兵" : "名称，例如：木桌 / 饭盒 / 筷子"}
            onChange={(e) => updateItem(nIt.id, { name: e.target.value || undefined }, `name-${nIt.id}`)} />
          <AutoTextarea className="textarea input-sm" minRows={2} maxRows={5} value={nIt.caption} placeholder="描述（可选）：外观、材质、颜色、姿态……"
            onChange={(e) => updateItem(nIt.id, { caption: e.target.value }, `cap-${nIt.id}`)} />
          {(() => {
            const g = sizeGuess(nIt.name || "", nIt.caption);
            const so = solidOf(nIt, L);
            return (
              <div className="namer-size">
                <div className="namer-dim num">
                  {fmt2(so.w / meter)} × {fmt2(so.h / meter)} × {fmt2(so.t / meter)} m<span className="muted">（宽 × 高 × 长）</span>
                </div>
                {g && (
                  <button type="button" className="btn btn-xs btn-warm" onClick={() => applySize(nIt.id, g)} title="按名称套用常见尺寸">
                    套用「{g.name}」{g.w}×{g.h}×{g.t} m
                  </button>
                )}
                <div className="namer-chips">
                  {QUICK_SIZES[nIt.label === "character" ? "character" : "object"].map((n) => (
                    <button key={n} type="button" className="chip-btn" onClick={() => applySize(nIt.id, presetByName(n))} title={`${presetByName(n).w}×${presetByName(n).h}×${presetByName(n).t} m`}>{n}</button>
                  ))}
                </div>
              </div>
            );
          })()}
          <div className="namer-foot">
            <button type="button" className="btn btn-ghost btn-xs btn-danger" onClick={() => { removeItems([nIt.id]); setNamer(null); }}><Trash2 size={12} />删除</button>
            <div className="spacer" />
            <span className="muted">↑ 高 → 宽 ↓ 长</span>
            <button type="button" className="btn btn-xs btn-primary" onClick={closeNamer}><Check size={12} />完成</button>
          </div>
        </div>
      )}
      <div className="scene-ui scene-hint">
        {creating ? (
          <>在<b className="warm-text">地面或桌面</b>上拖出占地范围（单击 = 默认大小，Shift 正方形）· 松开后起名字 · Esc 取消</>
        ) : edit && !edit.locked ? (
          <>拖手柄 拉伸（Alt 两边一起，Shift 吸附 5 cm）/ 旋转（Shift 15°）· {focused ? "" : "点一下场景后 "}键盘 <b>↑</b>高 <b>←→</b>宽 <b>↓</b>长（Shift 反向）<b>Q/E</b> 转向 <b>G</b> 落地 <b>F</b> 拉近 · 拖体块 移动（Shift 上下）</>
        ) : (
          <>拖空白 环绕 · 右键/Shift 拖 平移 · 滚轮 缩放 · 双击 复位 · 拖体块 地面移动（Shift 上下） · 拖<b className="warm-text">镜头</b>转机位（Shift 俯仰）{lgOn ? " · 拖灯 改方向" : ""} · <b>N</b> 新建体块 · 双击体块 拉近</>
        )}
      </div>
    </div>
  );
}
