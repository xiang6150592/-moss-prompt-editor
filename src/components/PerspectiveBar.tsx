import { useRef } from "react";
import type { PerspectiveSettings, PromptOptions } from "../types";
import { horizonLabel } from "../lib/perspective";

interface Props {
  p: PerspectiveSettings;
  opts: PromptOptions;
  width: number;
  height: number;
  hasRef: boolean;
  refOpacity: number;
  hasSegments: boolean;
  selCount: number;
  onChange: (p: PerspectiveSettings) => void;
  onChangeOpts: (o: PromptOptions) => void;
  onAutoBoxes: () => void;
  onDetectImage: () => void;
  onAlign: () => void;
  onLoadRef: (f: File) => void;
  onClearRef: () => void;
  onRefOpacity: (v: number) => void;
  onClearSegments: () => void;
}

export default function PerspectiveBar({
  p,
  opts,
  width,
  height,
  hasRef,
  refOpacity,
  hasSegments,
  selCount,
  onChange,
  onChangeOpts,
  onAutoBoxes,
  onDetectImage,
  onAlign,
  onLoadRef,
  onClearRef,
  onRefOpacity,
  onClearSegments,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<PerspectiveSettings>) => onChange({ ...p, ...patch });
  const pct = (v: number, base: number) => Math.round((v / base) * 100);

  return (
    <div className="persp-bar">
      <label className="chk" title="显示地平线、消失点与透视参考线">
        <input type="checkbox" checked={p.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        透视辅助
      </label>
      <div className="seg-toggle" title="透视类型">
        {([1, 2, 3] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={p.mode === m ? "active" : ""}
            onClick={() => {
              const patch: Partial<PerspectiveSettings> = { mode: m, enabled: true };
              if (m >= 2 && Math.abs(p.vp2_x - p.vp1_x) < width * 0.3) {
                patch.vp1_x = Math.round(width * -0.4);
                patch.vp2_x = Math.round(width * 1.4);
              }
              set(patch);
            }}
          >
            {m}点
          </button>
        ))}
      </div>
      <button type="button" className="small" title="把现有框当作立在地面上的物体，按近大远小估计地平线和消失点" onClick={onAutoBoxes}>
        按框自动
      </button>
      <button
        type="button"
        className="small"
        disabled={!hasRef}
        title={hasRef ? "在参考图里找直线并投票求消失点" : "先载入参考图"}
        onClick={onDetectImage}
      >
        从参考图检测
      </button>
      {hasSegments && (
        <button type="button" className="small ghost" title="隐藏检测到的线段" onClick={onClearSegments}>
          隐藏检测线
        </button>
      )}
      <span className="bar-sep" />
      <label className="chk" title="地平线以下显示地面网格">
        <input type="checkbox" checked={p.show_grid} onChange={(e) => set({ show_grid: e.target.checked, enabled: true })} />
        网格
      </label>
      <label className="chk" title="拖动框上下移动时，按到地平线的距离自动缩放（底边贴地）">
        <input type="checkbox" checked={p.auto_scale} onChange={(e) => set({ auto_scale: e.target.checked, enabled: e.target.checked || p.enabled })} />
        透视自动缩放
      </label>
      <button
        type="button"
        className="small"
        title="以选中框里最大的一个为基准，按透视统一其它选中框的大小（底边不动）；未选中时作用于全部框"
        onClick={onAlign}
      >
        对齐到透视{selCount > 1 ? `（${selCount}）` : ""}
      </button>
      <span className="bar-sep" />
      <label className="num" title="地平线高度（占画布高度的百分比，可超出 0–100）">
        地平线
        <input
          type="number"
          value={pct(p.horizon_y, height)}
          onChange={(e) => set({ horizon_y: Math.round((Number(e.target.value) / 100) * height), source: "manual" })}
        />
        %
      </label>
      <label className="num" title="消失点 1 的水平位置（占画布宽度百分比）">
        VP1
        <input
          type="number"
          value={pct(p.vp1_x, width)}
          onChange={(e) => set({ vp1_x: Math.round((Number(e.target.value) / 100) * width), source: "manual" })}
        />
        %
      </label>
      {p.mode >= 2 && (
        <label className="num" title="消失点 2 的水平位置（占画布宽度百分比）">
          VP2
          <input
            type="number"
            value={pct(p.vp2_x, width)}
            onChange={(e) => set({ vp2_x: Math.round((Number(e.target.value) / 100) * width), source: "manual" })}
          />
          %
        </label>
      )}
      {p.mode === 3 && (
        <label className="num" title="第三消失点的垂直位置（<0 在上方=仰视，>100 在下方=俯视）">
          VP3
          <input
            type="number"
            value={pct(p.vp3_y, height)}
            onChange={(e) => set({ vp3_y: Math.round((Number(e.target.value) / 100) * height), source: "manual" })}
          />
          %
        </label>
      )}
      <span className="hint">{horizonLabel(p, height)}</span>
      <span className="bar-sep" />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onLoadRef(f);
          e.target.value = "";
        }}
      />
      <button type="button" className="small" title="载入参考图（铺满画布，仅本地显示，不上传）" onClick={() => fileRef.current?.click()}>
        {hasRef ? "换参考图" : "参考图"}
      </button>
      {hasRef && (
        <>
          <input
            type="range"
            className="opacity-range"
            min={0.1}
            max={1}
            step={0.05}
            value={refOpacity}
            title="参考图透明度"
            onChange={(e) => onRefOpacity(Number(e.target.value))}
          />
          <button type="button" className="small ghost" onClick={onClearRef}>
            移除
          </button>
        </>
      )}
      <span className="bar-sep" />
      <label className="chk" title="把前景/中景/背景及遮挡关系写入各框描述">
        <input type="checkbox" checked={opts.depth} onChange={(e) => onChangeOpts({ ...opts, depth: e.target.checked })} />
        前后关系写入提示词
      </label>
      <label className="chk" title="把机位角度、地平线位置、透视类型写入全局描述">
        <input
          type="checkbox"
          checked={opts.perspective}
          onChange={(e) => onChangeOpts({ ...opts, perspective: e.target.checked })}
        />
        把透视写入提示词
      </label>
    </div>
  );
}
