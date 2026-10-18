import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { AppSettings } from "../types";
import {
  getSettings,
  listUpstreamModels,
  putSettings,
  testSettings,
} from "../api";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (s: AppSettings) => void;
}

export default function SettingsModal({ open, onClose, onSaved }: Props) {
  const [form, setForm] = useState({
    base_url: "",
    api_key: "",
    model: "",
    vision_model: "",
    prompt_prefix: "",
    negative_prompt: "",
  });
  const [keySet, setKeySet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [err, setErr] = useState("");
  const [probeMsg, setProbeMsg] = useState("");
  const [probeOk, setProbeOk] = useState<boolean | null>(null);
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setErr("");
    setProbeMsg("");
    setProbeOk(null);
    setModels([]);
    getSettings()
      .then((s) => {
        setForm({
          base_url: s.base_url || "",
          api_key: "",
          model: s.model || "",
          vision_model: s.vision_model || "",
          prompt_prefix: s.prompt_prefix || "",
          negative_prompt: s.negative_prompt || "",
        });
        setKeySet(!!s.api_key_set);
      })
      .catch((e) => setErr(String(e.message || e)));
  }, [open]);

  const probeBody = useMemo(
    () => ({
      base_url: form.base_url.trim() || undefined,
      api_key: form.api_key.trim() || undefined,
      model: form.model.trim() || undefined,
    }),
    [form.base_url, form.api_key, form.model],
  );

  if (!open) return null;

  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const body: Record<string, string> = {
        base_url: form.base_url,
        model: form.model,
        vision_model: form.vision_model,
        prompt_prefix: form.prompt_prefix,
        negative_prompt: form.negative_prompt,
      };
      if (form.api_key.trim()) body.api_key = form.api_key.trim();
      const s = await putSettings(body);
      onSaved(s);
      onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setProbing(true);
    setErr("");
    setProbeMsg("");
    setProbeOk(null);
    try {
      const r = await testSettings(probeBody);
      setProbeOk(!!r.ok);
      setProbeMsg(r.message || (r.ok ? "连通正常" : "检测失败"));
      if (r.sample_models?.length) {
        setModels((prev) => Array.from(new Set([...prev, ...r.sample_models])));
      }
    } catch (e: unknown) {
      setProbeOk(false);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  const fetchModels = async () => {
    setProbing(true);
    setErr("");
    try {
      const r = await listUpstreamModels(probeBody);
      setModels(r.models || []);
      setProbeOk(true);
      setProbeMsg(`已拉取 ${r.count} 个上游模型`);
      if (r.models?.length) {
        if (!form.model) setForm((f) => ({ ...f, model: r.models[0] }));
        if (!form.vision_model) {
          const vision =
            r.models.find((m) => /gpt-4o|vision|vl|gemini|claude-3/i.test(m)) ||
            r.models[0];
          setForm((f) => ({ ...f, vision_model: f.vision_model || vision }));
        }
      }
    } catch (e: unknown) {
      setProbeOk(false);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>API 设置</h2>
        <p className="hint">
          OpenAI 兼容接口。密钥只保存在服务端本地文件，不会打进前端包。
          {keySet && (
            <>
              {" "}
              <span className="badge ok">已配置密钥</span>
            </>
          )}
        </p>
        <div className="field">
          <label>Base URL</label>
          <input
            value={form.base_url}
            onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </div>
        <div className="field">
          <label>API Key（留空则保持原值）</label>
          <input
            type="password"
            value={form.api_key}
            onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            placeholder={keySet ? "••••••••（已保存）" : "sk-..."}
          />
        </div>
        <div className="field row-actions">
          <button type="button" disabled={probing || busy} onClick={runTest}>
            {probing ? "检测中…" : "检测联通"}
          </button>
          <button type="button" disabled={probing || busy} onClick={fetchModels}>
            拉取上游模型
          </button>
        </div>
        {probeMsg && (
          <div className={probeOk ? "ok-msg" : "err"} style={{ marginBottom: 8 }}>
            {probeMsg}
          </div>
        )}
        <div className="field">
          <label>文本模型（增强 / 上下文）</label>
          <input
            list="moss-model-list"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            placeholder="可输入或从列表选择"
          />
        </div>
        <div className="field">
          <label>视觉模型（图像反推）</label>
          <input
            list="moss-model-list"
            value={form.vision_model}
            onChange={(e) => setForm({ ...form, vision_model: e.target.value })}
            placeholder="可输入或从列表选择"
          />
        </div>
        <datalist id="moss-model-list">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {models.length > 0 && (
          <div className="field">
            <label>上游模型（点击填入文本模型）</label>
            <div className="model-chips">
              {models.slice(0, 80).map((m) => (
                <button
                  key={m}
                  type="button"
                  className="chip"
                  title="左键→文本模型 · Shift+左键→视觉模型"
                  onClick={(e) => {
                    if (e.shiftKey) setForm({ ...form, vision_model: m });
                    else setForm({ ...form, model: m });
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
            <p className="hint">点击填入文本模型；按住 Shift 点击填入视觉模型。</p>
          </div>
        )}
        <div className="field">
          <label>Prompt 前缀</label>
          <input
            value={form.prompt_prefix}
            onChange={(e) => setForm({ ...form, prompt_prefix: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Negative Prompt</label>
          <textarea
            value={form.negative_prompt}
            onChange={(e) => setForm({ ...form, negative_prompt: e.target.value })}
          />
        </div>
        {err && <div className="err">{err}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy} onClick={save}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
