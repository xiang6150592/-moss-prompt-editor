import type { HistoryRecord } from "../types";

interface Props {
  items: HistoryRecord[];
  onRestore: (r: HistoryRecord) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onRefresh: () => void;
}

export default function HistoryPanel({
  items,
  onRestore,
  onDelete,
  onRename,
  onRefresh,
}: Props) {
  return (
    <div className="panel">
      <div className="panel-h">
        <span>历史记录</span>
        <button type="button" className="ghost small" onClick={onRefresh}>
          刷新
        </button>
      </div>
      <div className="panel-b">
        {items.length === 0 && (
          <p className="hint">暂无记录。编译或保存后会出现在这里（服务端 + 本地）。</p>
        )}
        {items.map((it) => (
          <div key={it.id} className="hist-item" onClick={() => onRestore(it)}>
            <div className="t">{it.title}</div>
            <div className="m">
              {it.mode === "layout" ? "Layout" : "Caption"} ·{" "}
              {it.updated_at || it.created_at || ""}
            </div>
            <div className="acts" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => {
                  const t = prompt("重命名", it.title);
                  if (t && t.trim()) onRename(it.id, t.trim());
                }}
              >
                重命名
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (confirm("删除这条记录？")) onDelete(it.id);
                }}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
