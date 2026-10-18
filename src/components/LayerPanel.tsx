import { useState } from "react";
import { BOX_COLORS, type DepthTier, type LayoutItem } from "../types";

interface Props {
  items: LayoutItem[]; // 数组顺序 = 从后到前（最后一个最靠前）
  selIds: string[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (ids: string[]) => void;
  onChangeItems: (items: LayoutItem[]) => void;
  onReorder: (op: "up" | "down" | "top" | "bottom") => void;
  onDelete: (ids: string[]) => void;
  onSortBy: (by: "depth" | "ground") => void;
}

const DEPTH_OPTS: { v: DepthTier; t: string }[] = [
  { v: "auto", t: "自动" },
  { v: "fg", t: "前景" },
  { v: "mg", t: "中景" },
  { v: "bg", t: "背景" },
];

const LABEL_ZH: Record<string, string> = { object: "物体", character: "人物", text: "文字" };

export default function LayerPanel({
  items,
  selIds,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onChangeItems,
  onReorder,
  onDelete,
  onSortBy,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; before: boolean } | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);

  if (collapsed) {
    return (
      <div className="layers collapsed">
        <button type="button" className="ghost layers-expand" title="展开图层面板" onClick={onToggleCollapsed}>
          图<br />层<br />
          <span className="badge">{items.length}</span>
        </button>
      </div>
    );
  }

  const rows = [...items].reverse(); // 显示：最上面 = 最靠前
  const patch = (id: string, p: Partial<LayoutItem>) =>
    onChangeItems(items.map((it) => (it.id === id ? { ...it, ...p } : it)));

  const clickRow = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor) {
      const ids = rows.map((r) => r.id as string);
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = ids.slice(lo, hi + 1);
        onSelect(e.ctrlKey || e.metaKey ? [...selIds.filter((x) => !range.includes(x)), ...range] : range);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      onSelect(selIds.includes(id) ? selIds.filter((x) => x !== id) : [...selIds, id]);
    } else {
      onSelect([id]);
    }
    setAnchor(id);
  };

  const commitRename = () => {
    if (editing) patch(editing, { name: editVal.trim() || undefined });
    setEditing(null);
  };

  const onDrop = () => {
    if (!dragId || !dropAt || dragId === dropAt.id) {
      setDragId(null);
      setDropAt(null);
      return;
    }
    // 拖动的若在多选里，就整组移动
    const moving = selIds.includes(dragId) ? selIds : [dragId];
    const disp = rows.map((r) => r.id as string);
    const movingOrdered = disp.filter((x) => moving.includes(x));
    const remain = disp.filter((x) => !moving.includes(x));
    let pos = remain.indexOf(dropAt.id);
    if (pos < 0) pos = remain.length;
    else if (!dropAt.before) pos += 1;
    remain.splice(pos, 0, ...movingOrdered);
    const byId = new Map(items.map((it) => [it.id as string, it]));
    onChangeItems(remain.reverse().map((id) => byId.get(id)!));
    setDragId(null);
    setDropAt(null);
  };

  const any = selIds.length > 0;

  return (
    <div className="layers">
      <div className="layers-h">
        <span>图层 · {items.length}</span>
        <span className="hint" title="列表顶部 = 画面最前（离镜头最近）">顶部=最前</span>
        <button type="button" className="ghost icon-btn" title="收起" onClick={onToggleCollapsed}>
          »
        </button>
      </div>
      <div className="layers-list" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        {rows.length === 0 && <p className="hint" style={{ padding: 8 }}>还没有框。点「新建框」在画布上拖拽。</p>}
        {rows.map((it, ri) => {
          const id = it.id as string;
          const z = items.length - ri;
          const sel = selIds.includes(id);
          const title = it.name || (it.label === "text" ? it.text || it.caption : it.caption) || LABEL_ZH[it.label];
          return (
            <div
              key={id}
              className={`layer-row${sel ? " sel" : ""}${it.hidden ? " is-hidden" : ""}${
                dropAt?.id === id ? (dropAt.before ? " drop-before" : " drop-after") : ""
              }`}
              draggable={editing !== id}
              onDragStart={(e) => {
                setDragId(id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const before = e.clientY < r.top + r.height / 2;
                if (dropAt?.id !== id || dropAt.before !== before) setDropAt({ id, before });
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropAt(null);
              }}
              onClick={(e) => clickRow(e, id)}
            >
              <button
                type="button"
                className="ghost icon-btn"
                title={it.hidden ? "显示（隐藏的框不参与编译）" : "隐藏（隐藏的框不参与编译）"}
                onClick={(e) => {
                  e.stopPropagation();
                  patch(id, { hidden: !it.hidden });
                }}
              >
                {it.hidden ? "◌" : "👁"}
              </button>
              <button
                type="button"
                className="ghost icon-btn"
                title={it.locked ? "解锁" : "锁定（画布上不可选中/拖动）"}
                onClick={(e) => {
                  e.stopPropagation();
                  patch(id, { locked: !it.locked });
                }}
              >
                {it.locked ? "🔒" : "🔓"}
              </button>
              <span
                className={`swatch color-${it.color ?? 0}`}
                title="点击换颜色"
                onClick={(e) => {
                  e.stopPropagation();
                  patch(id, { color: ((it.color ?? 0) + 1) % BOX_COLORS });
                }}
              />
              <span className="layer-z">{z}</span>
              {editing === id ? (
                <input
                  className="layer-name-input"
                  autoFocus
                  value={editVal}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setEditVal(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditing(null);
                    e.stopPropagation();
                  }}
                />
              ) : (
                <span
                  className="layer-name"
                  title={`${title}\n双击重命名（名称只用于编辑器和前后关系描述）`}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditing(id);
                    setEditVal(it.name || "");
                  }}
                >
                  <small>{LABEL_ZH[it.label]}</small> {title}
                </span>
              )}
              <select
                className="layer-depth"
                value={it.depth || "auto"}
                title="景深层：前景/中景/背景，会写入提示词"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => patch(id, { depth: e.target.value as DepthTier })}
              >
                {DEPTH_OPTS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.t}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ghost icon-btn danger-text"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete([id]);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
      <div className="layers-f">
        <div className="layers-btns">
          <button type="button" disabled={!any} title="置顶（最前） Shift+]" onClick={() => onReorder("top")}>
            置顶
          </button>
          <button type="button" disabled={!any} title="上移一层 ]" onClick={() => onReorder("up")}>
            上移
          </button>
          <button type="button" disabled={!any} title="下移一层 [" onClick={() => onReorder("down")}>
            下移
          </button>
          <button type="button" disabled={!any} title="置底（最后） Shift+[" onClick={() => onReorder("bottom")}>
            置底
          </button>
        </div>
        <div className="layers-btns">
          <button type="button" disabled={items.length < 2} title="按 背景→中景→前景 重排（自动 视为中景）" onClick={() => onSortBy("depth")}>
            按景深排序
          </button>
          <button type="button" disabled={items.length < 2} title="底边越靠下越靠前（站在地面上的近大远小）" onClick={() => onSortBy("ground")}>
            按落地点排序
          </button>
        </div>
        <div className="layers-btns">
          <button type="button" disabled={items.length === 0} onClick={() => onSelect(items.map((x) => x.id as string))}>
            全选
          </button>
          <button type="button" className="danger" disabled={!any} onClick={() => onDelete(selIds)}>
            删除选中
          </button>
        </div>
      </div>
    </div>
  );
}
