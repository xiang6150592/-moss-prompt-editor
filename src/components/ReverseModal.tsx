import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { reverseImage } from "../api";
import {
  snap16,
  type EditorMode,
  type LayoutDraft,
  type ResolutionTemplate,
} from "../types";

type DetailLevel = "long" | "medium" | "short";
type ResSource = "image" | "custom";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Current editor mode — default reverse mode when modal opens */
  mode?: EditorMode;
  width?: number;
  height?: number;
  templates?: ResolutionTemplate[];
  skillId?: string;
  onApplyCaption: (text: string, kind: DetailLevel) => void;
  onApplyLayout: (draft: LayoutDraft, prompt?: string | null, file?: File | null) => void;
}

const DETAIL_LABELS: Record<DetailLevel, string> = {
  long: "长",
  medium: "中",
  short: "短",
};

/** Match server `_ensure_wh`: floor to multiple of 16, min 16. */
function ensureWh(w: number, h: number): [number, number] {
  return [
    Math.max(16, Math.floor(w / 16) * 16),
    Math.max(16, Math.floor(h / 16) * 16),
  ];
}

function readImageNaturalSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      URL.revokeObjectURL(url);
      if (!w || !h) {
        reject(new Error("无法读取图片宽高"));
        return;
      }
      resolve({ width: w, height: h });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法加载图片以读取尺寸"));
    };
    img.src = url;
  });
}

export default function ReverseModal({
  open,
  onClose,
  mode: modeProp = "caption",
  width = 1024,
  height = 1024,
  templates = [],
  skillId,
  onApplyCaption,
  onApplyLayout,
}: Props) {
  const [revMode, setRevMode] = useState<EditorMode>(modeProp);
  const [detail, setDetail] = useState<DetailLevel>("medium");
  const [resSource, setResSource] = useState<ResSource>("image");
  const [customTplId, setCustomTplId] = useState<string>("");
  const [customW, setCustomW] = useState(width);
  const [customH, setCustomH] = useState(height);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [natSize, setNatSize] = useState<{ width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sizeNote, setSizeNote] = useState("");
  const [hasRun, setHasRun] = useState(false);
  const [captionResult, setCaptionResult] = useState<{
    long: string;
    medium: string;
    short: string;
  } | null>(null);
  const [layoutResult, setLayoutResult] = useState<{
    draft: LayoutDraft;
    prompt?: string | null;
    compile_error?: string;
    usedW: number;
    usedH: number;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setRevMode(modeProp);
      setErr("");
      setSizeNote("");
      setCaptionResult(null);
      setLayoutResult(null);
      setResSource("image");
      setCustomW(width);
      setCustomH(height);
      setFile(null);
      setNatSize(null);
      setHasRun(false);
      const match = templates.find((t) => t.width === width && t.height === height);
      setCustomTplId(match?.id || (templates[0]?.id ?? ""));
    }
  }, [open, modeProp, width, height, templates]);

  // Preview object URL lifecycle
  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const customEffective = useMemo(() => ensureWh(customW, customH), [customW, customH]);

  const layoutHint =
    resSource === "image"
      ? natSize
        ? (() => {
            const [ew, eh] = ensureWh(natSize.width, natSize.height);
            if (ew !== natSize.width || eh !== natSize.height) {
              return `按上传图片实际宽高生成 bbox（原图 ${natSize.width}×${natSize.height} → 有效 ${ew}×${eh}，向下取整为 16 的倍数）`;
            }
            return `按上传图片实际宽高生成 bbox（${ew}×${eh}）`;
          })()
        : "按上传图片实际宽高生成 bbox（自动对齐为 16 的倍数）"
      : `按所选分辨率生成 bbox（当前有效 ${customEffective[0]}×${customEffective[1]}）`;

  if (!open) return null;

  const onCustomTplChange = (id: string) => {
    if (id === "__custom_inputs__") {
      setCustomTplId(id);
      return;
    }
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setCustomTplId(id);
    setCustomW(t.width);
    setCustomH(t.height);
  };

  const onPickFile = async (f: File | null) => {
    setErr("");
    setSizeNote("");
    setCaptionResult(null);
    setLayoutResult(null);
    setHasRun(false);
    setNatSize(null);
    setFile(f);
    if (!f) return;
    try {
      const nat = await readImageNaturalSize(f);
      setNatSize(nat);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const runReverse = async () => {
    if (!file) {
      setErr("请先选择图片");
      return;
    }
    setBusy(true);
    setErr("");
    setSizeNote("");
    setCaptionResult(null);
    setLayoutResult(null);
    try {
      let reqW = width;
      let reqH = height;

      if (revMode === "layout") {
        if (resSource === "image") {
          const nat = natSize || (await readImageNaturalSize(file));
          if (!natSize) setNatSize(nat);
          const [ew, eh] = ensureWh(nat.width, nat.height);
          reqW = ew;
          reqH = eh;
          if (ew !== nat.width || eh !== nat.height) {
            setSizeNote(
              `原图 ${nat.width}×${nat.height} → 有效画布 ${ew}×${eh}（向下取整为 16 的倍数）`,
            );
          } else {
            setSizeNote(`按原图 ${ew}×${eh} 生成 bbox`);
          }
        } else {
          const [ew, eh] = ensureWh(customW, customH);
          reqW = ew;
          reqH = eh;
          if (ew !== customW || eh !== customH) {
            setSizeNote(
              `所选 ${customW}×${customH} → 有效画布 ${ew}×${eh}（向下取整为 16 的倍数）`,
            );
          } else {
            setSizeNote(`按所选分辨率 ${ew}×${eh} 生成 bbox`);
          }
        }
      }

      const r = await reverseImage(file, {
        mode: revMode,
        detail,
        width: revMode === "layout" ? reqW : undefined,
        height: revMode === "layout" ? reqH : undefined,
        skill_id: skillId,
      });
      setHasRun(true);
      if (r.mode === "layout" && r.draft) {
        setLayoutResult({
          draft: r.draft,
          prompt: r.prompt,
          compile_error: r.compile_error,
          usedW: r.draft.width || reqW,
          usedH: r.draft.height || reqH,
        });
      } else if (r.caption) {
        setCaptionResult(r.caption);
      } else {
        setErr("反推结果格式异常");
      }
    } catch (e: unknown) {
      setHasRun(true);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(680px, 100%)" }}
      >
        <h2>图像反推</h2>
        <p className="hint">
          先选图并确认分辨率/详细程度，再点「开始反推」。Caption 产出长/中/短描述；Layout
          生成框与描述。
        </p>

        <div className="field">
          <label>反推模式</label>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className={revMode === "caption" ? "primary" : ""}
              disabled={busy}
              onClick={() => {
                setRevMode("caption");
                setCaptionResult(null);
                setLayoutResult(null);
                setSizeNote("");
              }}
            >
              Caption 描述
            </button>
            <button
              type="button"
              className={revMode === "layout" ? "primary" : ""}
              disabled={busy}
              onClick={() => {
                setRevMode("layout");
                setCaptionResult(null);
                setLayoutResult(null);
                setSizeNote("");
              }}
            >
              Layout 结构
            </button>
          </div>
        </div>

        <div className="field">
          <label>详细程度</label>
          <div className="field-hint">
            {revMode === "layout"
              ? "控制全局与各框描述的详略；框位置仍按图生成"
              : "Caption 仍会一次返回长/中/短三段，此处仅作偏好记录"}
          </div>
          <div className="row" style={{ gap: 8 }}>
            {(["long", "medium", "short"] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={detail === k ? "primary" : ""}
                disabled={busy}
                onClick={() => setDetail(k)}
              >
                {DETAIL_LABELS[k]}
              </button>
            ))}
          </div>
        </div>

        {revMode === "layout" && (
          <div className="field">
            <label>分辨率</label>
            <div className="field-hint">{layoutHint}</div>
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <button
                type="button"
                className={resSource === "image" ? "primary" : ""}
                disabled={busy}
                onClick={() => setResSource("image")}
              >
                跟原图
              </button>
              <button
                type="button"
                className={resSource === "custom" ? "primary" : ""}
                disabled={busy}
                onClick={() => setResSource("custom")}
              >
                自定义
              </button>
            </div>
            {resSource === "custom" && (
              <>
                <select
                  value={customTplId}
                  disabled={busy}
                  onChange={(e) => onCustomTplChange(e.target.value)}
                  style={{ width: "100%", marginBottom: 8 }}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}（{t.width}×{t.height}）
                    </option>
                  ))}
                  <option value="__custom_inputs__">手动输入宽高…</option>
                </select>
                <div className="row" style={{ gap: 8 }}>
                  <label style={{ flex: 1 }}>
                    <span className="field-hint">宽</span>
                    <input
                      type="number"
                      min={16}
                      step={16}
                      value={customW}
                      disabled={busy}
                      onChange={(e) => {
                        setCustomTplId("__custom_inputs__");
                        setCustomW(Number(e.target.value) || 0);
                      }}
                      onBlur={() => setCustomW(snap16(customW) || 16)}
                    />
                  </label>
                  <label style={{ flex: 1 }}>
                    <span className="field-hint">高</span>
                    <input
                      type="number"
                      min={16}
                      step={16}
                      value={customH}
                      disabled={busy}
                      onChange={(e) => {
                        setCustomTplId("__custom_inputs__");
                        setCustomH(Number(e.target.value) || 0);
                      }}
                      onBlur={() => setCustomH(snap16(customH) || 16)}
                    />
                  </label>
                </div>
              </>
            )}
          </div>
        )}

        <div className="field">
          <label>选择图片</label>
          <input
            type="file"
            accept="image/*"
            disabled={busy}
            onChange={(e) => void onPickFile(e.target.files?.[0] || null)}
          />
        </div>

        {file && (
          <div
            className="field"
            style={{
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
              padding: "10px 12px",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--panel-2, rgba(255,255,255,0.03))",
            }}
          >
            {previewUrl && (
              <img
                src={previewUrl}
                alt="预览"
                style={{
                  width: 96,
                  height: 96,
                  objectFit: "contain",
                  borderRadius: 6,
                  background: "#111",
                  flexShrink: 0,
                }}
              />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, wordBreak: "break-all" }}>{file.name}</div>
              <div className="field-hint" style={{ marginTop: 4 }}>
                {(file.size / 1024).toFixed(1)} KB
                {natSize ? ` · 原图 ${natSize.width}×${natSize.height}` : ""}
                {revMode === "layout" && resSource === "image" && natSize
                  ? ` · 有效 ${ensureWh(natSize.width, natSize.height).join("×")}`
                  : ""}
                {revMode === "layout" && resSource === "custom"
                  ? ` · 将用 ${customEffective[0]}×${customEffective[1]}`
                  : ""}
              </div>
              <div className="row" style={{ gap: 8, marginTop: 10, flex: "none" }}>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !file}
                  onClick={() => void runReverse()}
                  style={{ flex: "none" }}
                >
                  {busy ? "反推中…" : hasRun ? "重试" : "开始反推"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onPickFile(null)}
                  style={{ flex: "none" }}
                >
                  清除
                </button>
              </div>
            </div>
          </div>
        )}

        {!file && (
          <p className="hint" style={{ marginTop: 0 }}>
            选图后会显示预览，确认选项后再点「开始反推」。
          </p>
        )}

        {busy && <div className="status">反推中，请稍候…</div>}
        {sizeNote && !err && <div className="status">{sizeNote}</div>}
        {err && <div className="err">{err}</div>}

        {captionResult && (
          <div>
            {(["long", "medium", "short"] as const).map((k) => (
              <div key={k} className="field">
                <label>
                  {DETAIL_LABELS[k]}（{k}）{" "}
                  <button
                    type="button"
                    className="small primary"
                    onClick={() => {
                      onApplyCaption(captionResult[k], k);
                      onClose();
                    }}
                  >
                    {modeProp === "layout" ? "填入全局画面描述" : "填入 Caption"}
                  </button>
                </label>
                <textarea
                  readOnly
                  value={captionResult[k]}
                  rows={k === "long" ? 6 : 3}
                />
              </div>
            ))}
          </div>
        )}

        {layoutResult && (
          <div>
            <div className="status">
              已生成 Layout：{layoutResult.draft.items.length} 个框 · 画布{" "}
              {layoutResult.usedW}×{layoutResult.usedH}
              {layoutResult.compile_error ? " · 编译有警告" : ""}
            </div>
            <div className="field">
              <label>全局画面描述预览</label>
              <textarea
                readOnly
                value={layoutResult.draft.summary.caption}
                rows={4}
              />
            </div>
            <div className="field">
              <label>框列表</label>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {layoutResult.draft.items.map((it, i) => (
                  <li key={i}>
                    #{i + 1} [{it.label}] {it.caption.slice(0, 80)}
                    {it.caption.length > 80 ? "…" : ""}
                  </li>
                ))}
              </ul>
            </div>
            {layoutResult.compile_error && (
              <div className="err">{layoutResult.compile_error}</div>
            )}
            <button
              type="button"
              className="primary"
              style={{ width: "100%", marginTop: 8 }}
              onClick={() => {
                onApplyLayout(layoutResult.draft, layoutResult.prompt, file);
                onClose();
              }}
            >
              填入画布
            </button>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
