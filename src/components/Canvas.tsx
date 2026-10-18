import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutDraft, LayoutItem, PerspectiveSettings } from "../types";
import { moveOnGround, translateClamped, type BBox, type Segment } from "../lib/perspective";

type Handle = "nw" | "ne" | "sw" | "se";
type VPHandle = "vp1" | "vp2" | "vp3" | "horizon";

interface Props {
  draft: LayoutDraft;
  selIds: string[];
  drawing: boolean;
  refImage: { url: string; opacity: number } | null;
  segments: Segment[] | null;
  onSelect: (ids: string[]) => void;
  onChangeItems: (items: LayoutItem[]) => void;
  onChangePerspective: (p: PerspectiveSettings) => void;
  onDrawingChange: (v: boolean) => void;
  onCreateItem: (bbox: BBox) => void;
  /** 任意弹窗打开时为 true：禁用画布指针，避免透视手柄穿透弹窗 */
  modalLocked?: boolean;
}

type DragState =
  | { kind: "draw"; sx: number; sy: number }
  | { kind: "marquee"; sx: number; sy: number; additive: boolean; base: string[] }
  | {
      kind: "move";
      sx: number;
      sy: number;
      orig: Map<string, BBox>;
      moved: boolean;
      cycle: { stack: string[]; current: string } | null;
    }
  | { kind: "resize"; id: string; handle: Handle; sx: number; sy: number; orig: BBox }
  | { kind: "vp"; which: VPHandle; sx: number; sy: number; orig: PerspectiveSettings };

const DEPTH_TAG: Record<string, string> = { fg: "前", mg: "中", bg: "后" };
const GROUP_COLORS = ["#ff9f43", "#4ecdc4", "#a78bfa", "rgba(255,255,255,.35)"];

function clampBox(x1: number, y1: number, x2: number, y2: number, w: number, h: number): BBox {
  let a = Math.max(0, Math.min(x1, x2));
  let b = Math.max(0, Math.min(y1, y2));
  let c = Math.min(w, Math.max(x1, x2));
  let d = Math.min(h, Math.max(y1, y2));
  if (c - a < 4) c = Math.min(w, a + 4);
  if (d - b < 4) d = Math.min(h, b + 4);
  return [Math.round(a), Math.round(b), Math.round(c), Math.round(d)];
}

const inside = (x: number, y: number, b: BBox) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

/** 透视参考线（画布坐标） */
function guideLines(p: PerspectiveSettings, W: number, H: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const y0 = p.horizon_y;
  const far = 4 * Math.max(W, H);
  const rays = (vx: number, vy: number, n: number) => {
    // 朝画布四周均匀取点，延长到足够远
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([t * W, 0], [t * W, H]);
      pts.push([0, t * H], [W, t * H]);
    }
    const seen = new Set<string>();
    for (const [tx, ty] of pts) {
      const dx = tx - vx;
      const dy = ty - vy;
      const L = Math.hypot(dx, dy) || 1;
      const key = `${Math.round((Math.atan2(dy, dx) * 180) / Math.PI / 3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([vx, vy, vx + (dx / L) * far, vy + (dy / L) * far]);
    }
  };
  rays(p.vp1_x, y0, 10);
  if (p.mode >= 2) rays(p.vp2_x, y0, 10);
  if (p.mode === 3) {
    for (let i = -6; i <= 6; i++) {
      const tx = W / 2 + (i * W) / 6;
      const dx = tx - p.vp3_x;
      const dy = y0 - p.vp3_y;
      const L = Math.hypot(dx, dy) || 1;
      out.push([p.vp3_x, p.vp3_y, p.vp3_x + (dx / L) * far, p.vp3_y + (dy / L) * far]);
    }
  }
  return out;
}

/** 地面网格（仅地平线以下） */
function groundGrid(p: PerspectiveSettings, W: number, H: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const y0 = p.horizon_y;
  if (y0 >= H - 2) return out;
  const far = 4 * Math.max(W, H);
  const fan = (vx: number) => {
    const step = W / 8;
    for (let k = -24; k <= 24; k++) {
      const tx = vx + k * step;
      const dx = tx - vx;
      const dy = H - y0;
      const L = Math.hypot(dx, dy) || 1;
      out.push([vx, y0, vx + (dx / L) * far, y0 + (dy / L) * far]);
    }
  };
  fan(p.vp1_x);
  if (p.mode >= 2) {
    fan(p.vp2_x);
  } else {
    // 1 点透视：横向等距（透视递减）
    const base = H - y0;
    for (let j = 0; j < 14; j++) {
      const y = y0 + base / (1 + j * 0.45);
      out.push([-far, y, far, y]);
    }
  }
  return out;
}

export default function Canvas({
  draft,
  selIds,
  drawing,
  refImage,
  segments,
  onSelect,
  onChangeItems,
  onChangePerspective,
  onDrawingChange,
  onCreateItem,
  modalLocked = false,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const drag = useRef<DragState | null>(null);
  const [rect, setRectState] = useState<BBox | null>(null); // 拉框 / 框选预览
  const rectRef = useRef<BBox | null>(null);
  const setRect = (r: BBox | null) => {
    rectRef.current = r;
    setRectState(r);
  };
  const [hoverId, setHoverId] = useState<string | null>(null);
  const W = draft.width;
  const H = draft.height;
  const persp = draft.perspective;
  const primary = selIds.length ? selIds[selIds.length - 1] : null;

  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const pad = 64;
    const sx = (wrap.clientWidth - pad) / W;
    const sy = (wrap.clientHeight - pad) / H;
    setScale(Math.max(0.08, Math.min(1.5, Math.min(sx, sy))));
  }, [W, H]);

  useEffect(() => {
    fit();
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [fit]);

  const toLocal = (clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  };

  /** 鼠标下可点的框（可见、未锁定），最上层在前 */
  const stackAt = (x: number, y: number): string[] => {
    const out: string[] = [];
    for (let i = draft.items.length - 1; i >= 0; i--) {
      const it = draft.items[i];
      if (it.hidden || it.locked || !it.id) continue;
      if (inside(x, y, it.bbox)) out.push(it.id);
    }
    return out;
  };

  const startMove = (ids: string[], x: number, y: number, cycle: { stack: string[]; current: string } | null) => {
    const orig = new Map<string, BBox>();
    for (const it of draft.items) {
      if (it.id && ids.includes(it.id) && !it.locked && !it.hidden) orig.set(it.id, [...it.bbox] as BBox);
    }
    drag.current = { kind: "move", sx: x, sy: y, orig, moved: false, cycle };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (modalLocked) return;
    if (e.button !== 0) return;
    e.preventDefault();
    stageRef.current?.setPointerCapture?.(e.pointerId);
    const p = toLocal(e.clientX, e.clientY);
    if (drawing) {
      drag.current = { kind: "draw", sx: p.x, sy: p.y };
      setRect([p.x, p.y, p.x, p.y]);
      return;
    }
    const stack = stackAt(p.x, p.y);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!stack.length) {
      drag.current = { kind: "marquee", sx: p.x, sy: p.y, additive, base: additive ? selIds : [] };
      if (!additive) onSelect([]);
      return;
    }
    if (e.altKey) {
      // Alt+点击：在叠放的框中向下轮换
      const cur = primary && stack.includes(primary) ? stack.indexOf(primary) : -1;
      const next = stack[(cur + 1) % stack.length];
      onSelect([next]);
      startMove([next], p.x, p.y, null);
      return;
    }
    if (additive) {
      const target = stack[0];
      const has = selIds.includes(target);
      const nextSel = has ? selIds.filter((x) => x !== target) : [...selIds, target];
      onSelect(nextSel);
      if (!has) startMove(nextSel, p.x, p.y, null);
      return;
    }
    // 已选中的框在鼠标下：保持（方便拖动）；松开且没移动则轮换到下一层
    const keep = selIds.find((id) => stack.includes(id));
    if (keep) {
      startMove(selIds, p.x, p.y, stack.length > 1 && selIds.length === 1 ? { stack, current: keep } : null);
      return;
    }
    onSelect([stack[0]]);
    startMove([stack[0]], p.x, p.y, null);
  };

  const onHandleDown = (e: React.PointerEvent, id: string, handle: Handle) => {
    if (modalLocked) return;
    e.stopPropagation();
    e.preventDefault();
    const it = draft.items.find((x) => x.id === id);
    if (!it || it.locked) return;
    stageRef.current?.setPointerCapture?.(e.pointerId);
    const p = toLocal(e.clientX, e.clientY);
    drag.current = { kind: "resize", id, handle, sx: p.x, sy: p.y, orig: [...it.bbox] as BBox };
  };

  const onVPDown = (e: React.PointerEvent, which: VPHandle) => {
    if (modalLocked || !persp) return;
    e.stopPropagation();
    e.preventDefault();
    stageRef.current?.setPointerCapture?.(e.pointerId);
    const p = toLocal(e.clientX, e.clientY);
    drag.current = { kind: "vp", which, sx: p.x, sy: p.y, orig: { ...persp } };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const p = toLocal(e.clientX, e.clientY);
    if (!d) {
      if (!drawing) {
        const s = stackAt(p.x, p.y);
        const h = s[0] || null;
        if (h !== hoverId) setHoverId(h);
      }
      return;
    }
    const dx = p.x - d.sx;
    const dy = p.y - d.sy;
    if (d.kind === "draw") {
      setRect(clampBox(d.sx, d.sy, p.x, p.y, W, H));
      return;
    }
    if (d.kind === "marquee") {
      const r = clampBox(d.sx, d.sy, p.x, p.y, W, H);
      setRect(r);
      const hit = draft.items
        .filter(
          (it) =>
            it.id && !it.hidden && !it.locked &&
            it.bbox[0] < r[2] && it.bbox[2] > r[0] && it.bbox[1] < r[3] && it.bbox[3] > r[1],
        )
        .map((it) => it.id as string);
      onSelect([...d.base.filter((x) => !hit.includes(x)), ...hit]);
      return;
    }
    if (d.kind === "vp") {
      const o = d.orig;
      let next: PerspectiveSettings = { ...o, source: "manual" };
      if (d.which === "horizon") next.horizon_y = Math.round(o.horizon_y + dy);
      if (d.which === "vp1") next = { ...next, vp1_x: Math.round(o.vp1_x + dx), horizon_y: Math.round(o.horizon_y + dy) };
      if (d.which === "vp2") next = { ...next, vp2_x: Math.round(o.vp2_x + dx), horizon_y: Math.round(o.horizon_y + dy) };
      if (d.which === "vp3") next = { ...next, vp3_x: Math.round(o.vp3_x + dx), vp3_y: Math.round(o.vp3_y + dy) };
      onChangePerspective(next);
      return;
    }
    if (d.kind === "resize") {
      let [x1, y1, x2, y2] = d.orig;
      if (d.handle.includes("w")) x1 += dx;
      if (d.handle.includes("e")) x2 += dx;
      if (d.handle.includes("n")) y1 += dy;
      if (d.handle.includes("s")) y2 += dy;
      const nb = clampBox(x1, y1, x2, y2, W, H);
      onChangeItems(draft.items.map((it) => (it.id === d.id ? { ...it, bbox: nb } : it)));
      return;
    }
    // move
    if (!d.moved && Math.hypot(dx, dy) * scale < 3) return;
    d.moved = true;
    const useGround = !!(persp?.enabled && persp.auto_scale);
    let gdx = dx;
    let gdy = dy;
    if (!useGround) {
      // 多选整体平移：统一限制在画布内
      for (const b of d.orig.values()) {
        gdx = Math.max(gdx, -b[0]);
        gdx = Math.min(gdx, W - b[2]);
        gdy = Math.max(gdy, -b[1]);
        gdy = Math.min(gdy, H - b[3]);
      }
    }
    onChangeItems(
      draft.items.map((it) => {
        const o = it.id ? d.orig.get(it.id) : undefined;
        if (!o) return it;
        const nb = useGround
          ? moveOnGround(o, dx, dy, persp!.horizon_y, W, H)
          : translateClamped(o, gdx, gdy, W, H);
        return { ...it, bbox: nb };
      }),
    );
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "draw") {
      const r = rectRef.current;
      if (r && r[2] - r[0] >= 8 && r[3] - r[1] >= 8) onCreateItem(r);
      setRect(null);
      onDrawingChange(false);
      return;
    }
    if (d.kind === "marquee") {
      setRect(null);
      return;
    }
    if (d.kind === "move" && !d.moved && d.cycle) {
      const { stack, current } = d.cycle;
      const next = stack[(stack.indexOf(current) + 1) % stack.length];
      onSelect([next]);
    }
  };

  const stageStyle = useMemo(() => ({ width: W * scale, height: H * scale }), [W, H, scale]);

  const primaryItem = primary ? draft.items.find((x) => x.id === primary) : undefined;
  const showPersp = !!persp?.enabled;
  const guides = useMemo(() => (persp && showPersp ? guideLines(persp, W, H) : []), [persp, showPersp, W, H]);
  const grid = useMemo(
    () => (persp && showPersp && persp.show_grid ? groundGrid(persp, W, H) : []),
    [persp, showPersp, W, H],
  );

  /** 句柄位置：画布外的消失点贴边显示（虚线圈），拖动按相对位移 */
  const handlePos = (x: number, y: number) => {
    const m = 14 / scale;
    const cx = Math.max(-m, Math.min(W + m, x));
    const cy = Math.max(-m, Math.min(H + m, y));
    return { cx, cy, off: cx !== x || cy !== y };
  };

  return (
    <div className={`canvas-wrap${modalLocked ? " modal-locked" : ""}`} ref={wrapRef}>
      <div
        ref={stageRef}
        className={`canvas-stage${drawing ? " drawing" : ""}${hoverId && !drawing ? " hovering" : ""}`}
        style={stageStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => !drag.current && setHoverId(null)}
      >
        {refImage && (
          <img
            className="ref-image"
            src={refImage.url}
            alt=""
            draggable={false}
            style={{ opacity: refImage.opacity }}
          />
        )}
        {draft.items.map((it, i) => {
          if (it.hidden) return null;
          const [x1, y1, x2, y2] = it.bbox;
          const label = it.name || (it.label === "text" ? it.text || it.caption : it.caption || it.label);
          const tag = it.depth && it.depth !== "auto" ? DEPTH_TAG[it.depth] : "";
          const isSel = !!it.id && selIds.includes(it.id);
          return (
            <div
              key={it.id || i}
              className={`bbox color-${it.color ?? i % 6}${isSel ? " selected" : ""}${
                it.id === hoverId ? " hover" : ""
              }${it.locked ? " locked" : ""}`}
              style={{
                left: x1 * scale,
                top: y1 * scale,
                width: (x2 - x1) * scale,
                height: (y2 - y1) * scale,
                zIndex: i + 1,
              }}
            >
              <div className="bbox-label">
                <span className="bbox-z">{i + 1}</span>
                {tag && <span className="bbox-depth">{tag}</span>}
                {it.locked && "🔒"}
                {label}
              </div>
            </div>
          );
        })}

        {showPersp && persp && (
          <svg
            className="persp-svg"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            width={W * scale}
            height={H * scale}
          >
            <defs>
              <clipPath id="stage-clip">
                <rect x={0} y={0} width={W} height={H} />
              </clipPath>
            </defs>
            <g clipPath="url(#stage-clip)">
              {grid.map((l, i) => (
                <line key={`g${i}`} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} className="persp-grid" />
              ))}
              {guides.map((l, i) => (
                <line key={`r${i}`} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} className="persp-ray" />
              ))}
              {segments?.map((s, i) => (
                <line
                  key={`s${i}`}
                  x1={s.x1}
                  y1={s.y1}
                  x2={s.x2}
                  y2={s.y2}
                  stroke={GROUP_COLORS[s.group < 0 ? 3 : s.group]}
                  className="persp-seg"
                />
              ))}
              <line x1={0} y1={persp.horizon_y} x2={W} y2={persp.horizon_y} className="persp-horizon" />
            </g>
          </svg>
        )}

        {showPersp && persp && (
          <div className="persp-handles">
            {(() => {
              const hy = Math.max(0, Math.min(H, persp.horizon_y));
              return (
                <div
                  className={`horizon-grip${hy !== persp.horizon_y ? " off" : ""}`}
                  style={{ top: hy * scale }}
                  title="拖动调整地平线高度"
                  onPointerDown={(e) => onVPDown(e, "horizon")}
                >
                  <span>地平线 {Math.round((persp.horizon_y / H) * 100)}%</span>
                </div>
              );
            })()}
            {(
              [
                ["vp1", persp.vp1_x, persp.horizon_y, true],
                ["vp2", persp.vp2_x, persp.horizon_y, persp.mode >= 2],
                ["vp3", persp.vp3_x, persp.vp3_y, persp.mode === 3],
              ] as [VPHandle, number, number, boolean][]
            )
              .filter((x) => x[3])
              .map(([k, x, y]) => {
                const hp = handlePos(x, y);
                return (
                  <div
                    key={k}
                    className={`vp-handle ${k}${hp.off ? " off" : ""}`}
                    style={{ left: hp.cx * scale, top: hp.cy * scale }}
                    title={`${k.toUpperCase()}（${Math.round(x)}, ${Math.round(y)}）${
                      hp.off ? " · 在画布外，拖动按相对位移" : ""
                    }`}
                    onPointerDown={(e) => onVPDown(e, k)}
                  >
                    {k.slice(2)}
                  </div>
                );
              })}
          </div>
        )}

        {primaryItem && !primaryItem.hidden && !primaryItem.locked && !drawing && (
          <div
            className="sel-frame"
            style={{
              left: primaryItem.bbox[0] * scale,
              top: primaryItem.bbox[1] * scale,
              width: (primaryItem.bbox[2] - primaryItem.bbox[0]) * scale,
              height: (primaryItem.bbox[3] - primaryItem.bbox[1]) * scale,
            }}
          >
            {(["nw", "ne", "sw", "se"] as const).map((h) => (
              <div key={h} className={`handle ${h}`} onPointerDown={(e) => onHandleDown(e, primaryItem.id!, h)} />
            ))}
          </div>
        )}

        {rect && (
          <div
            className={drawing ? "bbox color-0 draft-rect" : "marquee-rect"}
            style={{
              left: rect[0] * scale,
              top: rect[1] * scale,
              width: (rect[2] - rect[0]) * scale,
              height: (rect[3] - rect[1]) * scale,
            }}
          />
        )}
      </div>
      <div className="canvas-zoom">
        <span className="badge">
          {W}×{H} · {Math.round(scale * 100)}%
        </span>
        <button type="button" className="small" onClick={fit}>
          适应
        </button>
        <button type="button" className="small" onClick={() => setScale((s) => Math.min(2, s * 1.15))}>
          +
        </button>
        <button type="button" className="small" onClick={() => setScale((s) => Math.max(0.08, s / 1.15))}>
          −
        </button>
      </div>
      <div className="canvas-tip">
        点选取最上层 · 再点一次/Alt+点 选下面一层 · Shift/Ctrl 多选 · 空白处拖动框选 · 方向键微调 · [ ] 调层级
      </div>
    </div>
  );
}
