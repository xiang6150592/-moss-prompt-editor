"""MOSS-Image Prompt Editor backend."""

from __future__ import annotations

import base64
import importlib.util
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(parents=True, exist_ok=True)
SETTINGS_PATH = DATA / "settings.json"
HISTORY_PATH = DATA / "history.json"
SKILLS_PATH = DATA / "skills.json"
DIST = ROOT / "dist"
SKILL_COMPILE = ROOT / "vendor" / "moss-image-prompt-enhancer" / "scripts" / "compile_prompt.py"
CAPTION_PROMPT_PATH = ROOT / "vendor" / "docs" / "CAPTION_PROMPT_ZH.md"

# Load official compile_prompt module
_spec = importlib.util.spec_from_file_location("compile_prompt", SKILL_COMPILE)
_compile_mod = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_compile_mod)
compile_prompt = _compile_mod.compile_prompt


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_settings() -> dict:
    defaults = {
        "base_url": "https://api.openai.com/v1",
        "api_key": "",
        "model": "gpt-4o-mini",
        "vision_model": "gpt-4o",
        "prompt_prefix": "best quality, masterpiece",
        "negative_prompt": "nsfw, worst quality, bad anatomy, watermark, jpeg artifact",
    }
    stored = _load_json(SETTINGS_PATH, {})
    if not isinstance(stored, dict):
        stored = {}
    merged = {**defaults, **stored}
    return merged


def public_settings(s: dict) -> dict:
    out = dict(s)
    key = out.get("api_key") or ""
    out["api_key_set"] = bool(key.strip())
    out["api_key"] = ""  # never send raw key to frontend
    return out


app = FastAPI(title="MOSS Prompt Editor", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- models ----------
class CompileBody(BaseModel):
    draft: dict


class EnhanceBody(BaseModel):
    idea: str
    mode: str = "caption"  # caption | layout
    width: int = 1024
    height: int = 1024
    messages: Optional[list[dict]] = None
    skill_id: Optional[str] = None
    context_hint: Optional[str] = None  # 图层 / 透视说明；无 boxes 时的兼容文本
    boxes: Optional[list[dict]] = None  # 用户画框。bbox 为画布绝对像素 xyxy（左上角原点）
    perspective: Optional[dict] = None  # 透视辅助，坐标与框同一像素系（可在画布外）


class ContextBody(BaseModel):
    draft: dict
    message: str
    history: Optional[list[dict]] = None
    skill_id: Optional[str] = None


class HistoryItem(BaseModel):
    id: Optional[str] = None
    title: str = "未命名"
    mode: str = "caption"
    idea: str = ""
    draft: dict = Field(default_factory=dict)
    prompt: str = ""
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class SettingsBody(BaseModel):
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    vision_model: Optional[str] = None
    prompt_prefix: Optional[str] = None
    negative_prompt: Optional[str] = None


class ProbeBody(BaseModel):
    """Optional overrides for testing without saving first."""
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None


class SkillActiveBody(BaseModel):
    kind: str
    id: str


class SkillCreateBody(BaseModel):
    name: str
    kind: str
    description: Optional[str] = ""
    system_prompt: str


class SkillUpdateBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None


# ---------- helpers ----------
def _extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            return json.loads(m.group(0))
        raise


async def _chat(
    messages: list[dict],
    *,
    model: Optional[str] = None,
    max_tokens: int = 4096,
    temperature: float = 0.7,
) -> str:
    s = load_settings()
    api_key = (s.get("api_key") or "").strip()
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key。请在设置中填写 OpenAI 兼容接口密钥。")
    base = (s.get("base_url") or "https://api.openai.com/v1").rstrip("/")
    use_model = model or s.get("model") or "gpt-4o-mini"
    url = f"{base}/chat/completions"
    payload = {
        "model": use_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(url, headers=headers, json=payload)
        if r.status_code >= 400:
            raise HTTPException(
                status_code=502,
                detail=f"上游 API 错误 {r.status_code}: {r.text[:500]}",
            )
        data = r.json()
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise HTTPException(status_code=502, detail=f"上游返回格式异常: {e}") from e


LAYOUT_SYSTEM = """你是 MOSS-Image Layout 提示词助手。根据用户想法输出**严格合法**的 Layout 草稿 JSON（不要 Markdown）。
字段必须且仅能有:
width, height, bbox_coord_space:"abs", bbox_format:"xyxy",
summary:{caption, meta?, canvas?},
items:[{label:"object"|"character"|"text", caption, bbox:[x1,y1,x2,y2], text?(仅text), tags?, palette?}]
规则:
- width/height 为正整数且为 16 的倍数；使用用户给定尺寸。
- bbox 为画布左上角起的绝对像素 [x_min,y_min,x_max,y_max]，且在画布内。
- 禁止 children/parent/id 等未知字段。
- summary.caption 与各 item.caption 用英文描述可见外观（用户明确要求中文除外）；可见文字原文放 text 字段。
- items 至少 1 个；框可重叠。
只输出一个 JSON 对象。"""

CAPTION_SYSTEM = """你是 MOSS-Image Caption 提示词助手。把用户想法扩成一段连贯的图像描述。
只输出 UTF-8 JSON: {"caption":"..."}

遵循 OpenMOSS/MOSS-Image 官方 Caption 约定：
- 默认英文散文；用户明确要求中文则用中文。
- 用文字表达空间关系，不要坐标、不要 bbox、不要 Layout 字段。
- 可见文字原文引用（含标点与换行意图）；区分「要画出来的字」与参考/约束。
- 描述可见选择：主体与动作、外观、场景、构图/机位、媒介、光线、材质、色调与情绪。
- 避免堆砌质量标签、未请求的风格漂移、任意字数预算，以及不可见的过程说明。
- 保持用户主体、数量、关系、媒介、风格、排除项与拟可见文案。"""

CONTEXT_SYSTEM = """你是 MOSS-Image 草稿编辑助手。用户会给出当前 draft JSON 和修改指令。
你必须返回 JSON:
{"draft": <更新后的完整 draft>, "reply": "<简短中文说明做了什么>"}
Layout draft 字段约束同官方 schema（abs/xyxy，无 id/parent/children）。
Caption draft 为 {"caption":"..."}。
只输出 JSON，不要 Markdown。"""

OFFICIAL_SKILL_PROMPTS: dict[str, str] = {
    "official-caption": CAPTION_SYSTEM,
    "official-layout": LAYOUT_SYSTEM,
    "official-context": CONTEXT_SYSTEM,
}

OFFICIAL_SKILL_META: list[dict[str, Any]] = [
    {
        "id": "official-caption",
        "name": "MOSS 官方 Caption",
        "kind": "caption",
        "builtin": True,
        "description": "OpenMOSS/MOSS-Image 官方 Caption：连贯散文描述，无坐标。",
    },
    {
        "id": "official-layout",
        "name": "MOSS 官方 Layout",
        "kind": "layout",
        "builtin": True,
        "description": "OpenMOSS/MOSS-Image 官方 Layout：绝对像素 bbox 草稿 JSON。",
    },
    {
        "id": "official-context",
        "name": "MOSS 草稿上下文改写",
        "kind": "context",
        "builtin": True,
        "description": "根据指令改写当前 Caption/Layout 草稿并返回说明。",
    },
]

DEFAULT_ACTIVE = {
    "caption": "official-caption",
    "layout": "official-layout",
    "context": "official-context",
}


def _official_skills() -> list[dict[str, Any]]:
    now = _now_iso()
    out: list[dict[str, Any]] = []
    for meta in OFFICIAL_SKILL_META:
        sid = meta["id"]
        out.append(
            {
                **meta,
                "system_prompt": OFFICIAL_SKILL_PROMPTS[sid],
                "updated_at": now,
            }
        )
    return out


def _normalize_skills_store(raw: Any) -> dict[str, Any]:
    skills = _official_skills()
    by_id = {s["id"]: s for s in skills}
    active = dict(DEFAULT_ACTIVE)
    if isinstance(raw, dict):
        custom = raw.get("skills")
        if isinstance(custom, list):
            for item in custom:
                if not isinstance(item, dict):
                    continue
                sid = item.get("id")
                if not sid or not isinstance(sid, str):
                    continue
                if sid in by_id and by_id[sid].get("builtin"):
                    # system_prompt always from code; name/description may be customized lightly
                    if isinstance(item.get("name"), str) and item["name"].strip():
                        by_id[sid]["name"] = item["name"].strip()
                    if "description" in item:
                        by_id[sid]["description"] = str(item.get("description") or "")
                    if item.get("updated_at"):
                        by_id[sid]["updated_at"] = item["updated_at"]
                    continue
                kind = item.get("kind")
                if kind not in ("caption", "layout", "context"):
                    continue
                name = (item.get("name") or "").strip() or "未命名 Skill"
                prompt = item.get("system_prompt")
                if not isinstance(prompt, str) or not prompt.strip():
                    continue
                by_id[sid] = {
                    "id": sid,
                    "name": name,
                    "kind": kind,
                    "builtin": False,
                    "description": str(item.get("description") or ""),
                    "system_prompt": prompt,
                    "updated_at": item.get("updated_at") or _now_iso(),
                }
        act = raw.get("active")
        if isinstance(act, dict):
            for k in ("caption", "layout", "context"):
                aid = act.get(k)
                if isinstance(aid, str) and aid in by_id and by_id[aid]["kind"] == k:
                    active[k] = aid
    # ensure active points to existing skill of correct kind
    for k, oid in DEFAULT_ACTIVE.items():
        sid = active.get(k)
        if not sid or sid not in by_id or by_id[sid]["kind"] != k:
            active[k] = oid
    ordered = []
    for meta in OFFICIAL_SKILL_META:
        ordered.append(by_id[meta["id"]])
    for sid, s in by_id.items():
        if not s.get("builtin"):
            ordered.append(s)
    return {"skills": ordered, "active": active}


def load_skills() -> dict[str, Any]:
    raw = _load_json(SKILLS_PATH, None)
    store = _normalize_skills_store(raw)
    if raw is None or not SKILLS_PATH.exists():
        _save_json(SKILLS_PATH, store)
    return store


def save_skills(store: dict[str, Any]) -> dict[str, Any]:
    store = _normalize_skills_store(store)
    _save_json(SKILLS_PATH, store)
    return store


def get_skill(skill_id: str) -> dict[str, Any]:
    store = load_skills()
    for s in store["skills"]:
        if s["id"] == skill_id:
            return s
    raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_id}")


def resolve_skill(kind: str, skill_id: Optional[str] = None) -> dict[str, Any]:
    store = load_skills()
    if skill_id:
        for s in store["skills"]:
            if s["id"] == skill_id:
                if s["kind"] != kind:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Skill {skill_id} 类型为 {s['kind']}，需要 {kind}",
                    )
                return s
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_id}")
    active_id = store["active"].get(kind) or DEFAULT_ACTIVE[kind]
    for s in store["skills"]:
        if s["id"] == active_id:
            return s
    # fallback official
    for s in store["skills"]:
        if s["id"] == DEFAULT_ACTIVE[kind]:
            return s
    raise HTTPException(status_code=500, detail=f"缺少默认 skill: {kind}")


def _fallback_caption(idea: str) -> dict:
    return {"caption": idea.strip() or "An image."}


def _fallback_layout(idea: str, width: int, height: int) -> dict:
    w, h = width, height
    # simple centered boxes as placeholders
    items = [
        {
            "label": "object",
            "caption": idea.strip() or "Main subject.",
            "bbox": [w // 8, h // 8, w * 7 // 8, h * 7 // 8],
        }
    ]
    return {
        "width": w,
        "height": h,
        "bbox_coord_space": "abs",
        "bbox_format": "xyxy",
        "summary": {
            "caption": idea.strip() or "A composed image.",
            "canvas": "single",
        },
        "items": items,
    }


def _ensure_wh(w: int, h: int) -> tuple[int, int]:
    w = max(16, (w // 16) * 16)
    h = max(16, (h // 16) * 16)
    return w, h


def _as_int(v: Any, default: int = 0) -> int:
    try:
        if isinstance(v, bool):
            return default
        return int(round(float(v)))
    except (TypeError, ValueError):
        return default


def _sanitize_caption_draft(draft: dict) -> dict:
    cap = draft.get("caption")
    if not isinstance(cap, str) or not cap.strip():
        # layout-shaped mistaken as caption: try summary
        summary = draft.get("summary") if isinstance(draft.get("summary"), dict) else {}
        cap = summary.get("caption") if isinstance(summary.get("caption"), str) else ""
    if not isinstance(cap, str) or not cap.strip():
        cap = "An image."
    return {"caption": cap.strip()}


def _sanitize_layout_draft(draft: dict, width: int | None = None, height: int | None = None) -> dict:
    """Strip LLM extras and coerce types so official compile_prompt accepts the draft."""
    w = _as_int(width if width is not None else draft.get("width"), 1024)
    h = _as_int(height if height is not None else draft.get("height"), 1024)
    w, h = _ensure_wh(w, h)

    raw_summary = draft.get("summary") if isinstance(draft.get("summary"), dict) else {}
    caption = raw_summary.get("caption")
    if not isinstance(caption, str) or not caption.strip():
        caption = draft.get("caption") if isinstance(draft.get("caption"), str) else ""
    if not isinstance(caption, str) or not caption.strip():
        caption = "A composed image."

    summary: dict[str, Any] = {"caption": caption.strip()}
    canvas = raw_summary.get("canvas")
    if canvas in ("single", "multi_panel", "collage"):
        summary["canvas"] = canvas
    else:
        summary["canvas"] = "single"
    for key in ("meta", "palette"):
        val = raw_summary.get(key)
        if isinstance(val, list):
            cleaned = [str(x).strip() for x in val if isinstance(x, str) and str(x).strip()]
            if cleaned:
                summary[key] = cleaned

    items_in = draft.get("items") if isinstance(draft.get("items"), list) else []
    items: list[dict[str, Any]] = []
    for idx, it in enumerate(items_in):
        if not isinstance(it, dict):
            continue
        label = it.get("label")
        if label not in ("object", "character", "text"):
            label = "object"
        cap = it.get("caption")
        if not isinstance(cap, str) or not cap.strip():
            cap = f"Region {idx + 1}"
        bbox_raw = it.get("bbox")
        if not (isinstance(bbox_raw, list) and len(bbox_raw) == 4):
            # default box covering most of canvas
            bbox = [w // 8, h // 8, w * 7 // 8, h * 7 // 8]
        else:
            x1, y1, x2, y2 = (_as_int(v) for v in bbox_raw)
            # order
            if x2 < x1:
                x1, x2 = x2, x1
            if y2 < y1:
                y1, y2 = y2, y1
            # clamp
            x1 = max(0, min(x1, w - 2))
            y1 = max(0, min(y1, h - 2))
            x2 = max(x1 + 1, min(x2, w))
            y2 = max(y1 + 1, min(y2, h))
            if x2 <= x1 or y2 <= y1:
                x1, y1, x2, y2 = w // 8, h // 8, w * 7 // 8, h * 7 // 8
            bbox = [x1, y1, x2, y2]
        out_item: dict[str, Any] = {
            "label": label,
            "caption": cap.strip(),
            "bbox": bbox,
        }
        if label == "text":
            t = it.get("text")
            if not isinstance(t, str) or not t.strip():
                t = cap.strip()
            out_item["text"] = t.strip()
        elif isinstance(it.get("text"), str) and it["text"].strip():
            out_item["text"] = it["text"].strip()
        for key in ("tags", "palette"):
            val = it.get(key)
            if isinstance(val, list):
                cleaned = [str(x).strip() for x in val if isinstance(x, str) and str(x).strip()]
                if cleaned:
                    out_item[key] = cleaned
        out_item.update(_sanitize_item_meta(it))
        items.append(out_item)

    if not items:
        items = [
            {
                "label": "object",
                "caption": caption.strip(),
                "bbox": [w // 8, h // 8, w * 7 // 8, h * 7 // 8],
            }
        ]

    out: dict[str, Any] = {
        "width": w,
        "height": h,
        "bbox_coord_space": "abs",
        "bbox_format": "xyxy",
        "summary": summary,
        "items": items,
    }
    persp = _sanitize_perspective(draft.get("perspective"))
    if persp is not None:
        out["perspective"] = persp
    opts = draft.get("prompt_options")
    if isinstance(opts, dict):
        out["prompt_options"] = {
            "depth": opts.get("depth") is not False,
            "perspective": bool(opts.get("perspective")),
        }
    return out


# ---------- 编辑器元数据（图层 / 景深 / 透视）----------
# 这些字段只给编辑器用：草稿与历史里保留，编译前剥离，不进入官方 schema。
EDITOR_ITEM_KEYS = ("id", "name", "hidden", "locked", "depth", "color")
EDITOR_ROOT_KEYS = ("perspective", "prompt_options")
DEPTH_TIERS = ("auto", "fg", "mg", "bg")


def _sanitize_item_meta(it: dict) -> dict:
    meta: dict[str, Any] = {}
    if isinstance(it.get("id"), str) and it["id"].strip():
        meta["id"] = it["id"].strip()[:64]
    if isinstance(it.get("name"), str) and it["name"].strip():
        meta["name"] = it["name"].strip()[:80]
    for key in ("hidden", "locked"):
        if isinstance(it.get(key), bool):
            meta[key] = it[key]
    if it.get("depth") in DEPTH_TIERS:
        meta["depth"] = it["depth"]
    if isinstance(it.get("color"), int) and not isinstance(it.get("color"), bool):
        meta["color"] = it["color"] % 6
    return meta


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if f == f and abs(f) < 1e7 else None


def _sanitize_perspective(p: Any) -> Optional[dict]:
    if not isinstance(p, dict):
        return None
    out: dict[str, Any] = {
        "enabled": bool(p.get("enabled")),
        "mode": p.get("mode") if p.get("mode") in (1, 2, 3) else 1,
        "show_grid": bool(p.get("show_grid")),
        "auto_scale": bool(p.get("auto_scale")),
        "source": p.get("source") if p.get("source") in ("manual", "boxes", "image") else "manual",
    }
    for key in ("horizon_y", "vp1_x", "vp2_x", "vp3_x", "vp3_y"):
        n = _num(p.get(key))
        if n is not None:
            out[key] = round(n, 2)
    if "horizon_y" not in out or "vp1_x" not in out:
        return None
    return out


_CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")


def _is_cjk(text: str) -> bool:
    return bool(_CJK.search(text or ""))


def _short_ref(it: dict, zh: bool) -> str:
    """生成「在 X 前面」里的 X。优先图层名，其次框内描述的第一小句。"""
    name = (it.get("name") or "").strip()
    if not name and it.get("label") == "text" and (it.get("text") or "").strip():
        t = it["text"].strip().splitlines()[0][:24]
        return f"文字「{t}」" if zh else f'the text "{t}"'
    src = name or (it.get("caption") or "").strip()
    src = re.split(r"[，。,.;；:：!?！？\n]", src, maxsplit=1)[0].strip() or src.strip()
    if zh or _is_cjk(src):
        return f"「{src[:16]}」"
    words = src.split()
    if words and words[0].lower() in ("a", "an", "the"):
        words = words[1:]
    ref = " ".join(words[:6]) or "object"
    if not name:
        ref = ref[0].lower() + ref[1:] if len(ref) > 1 and not ref[:2].isupper() else ref
        return f"the {ref}"
    # 小写开头的名字当普通名词（the girl），大写开头当专有名词（Alice）
    return f"the {ref}" if ref[:1].islower() else ref


def _area(b: list) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def _inter(a: list, b: list) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


TIER_EN = {"fg": "in the foreground", "mg": "in the middle ground", "bg": "in the background"}
TIER_ZH = {"fg": "位于前景", "mg": "位于中景", "bg": "位于背景"}


def depth_phrases(items: list[dict]) -> list[str]:
    """
    根据图层顺序（数组越靠后越靠前）+ 框重叠，为每个框生成前后关系短语。
    文字框不参与遮挡关系（通常是叠加在画面上的字）。返回与 items 等长的列表，空串表示无。
    """
    out: list[str] = []
    n = len(items)
    for i, it in enumerate(items):
        zh = _is_cjk(it.get("caption", ""))
        parts: list[str] = []
        tier_txt = ""
        tier = it.get("depth")
        if tier in TIER_EN:
            tier_txt = TIER_ZH[tier] if zh else TIER_EN[tier]
        if it.get("label") != "text":
            a = it["bbox"]
            fronts: list[tuple[float, str]] = []
            behinds: list[tuple[float, str]] = []
            for j in range(n):
                if j == i or items[j].get("label") == "text":
                    continue
                b = items[j]["bbox"]
                inter = _inter(a, b)
                if inter <= 0:
                    continue
                small = min(_area(a), _area(b)) or 1.0
                if inter / small < 0.05:
                    continue
                ref = _short_ref(items[j], zh)
                if j < i:  # j 在 i 后面 → i 在 j 前面
                    covers_all = inter / (_area(b) or 1.0) >= 0.95
                    if zh:
                        txt = f"在{ref}前方" + ("" if covers_all else "，部分遮挡它")
                    else:
                        txt = f"in front of {ref}" + ("" if covers_all else ", partially occluding it")
                    fronts.append((inter, txt))
                else:  # j 在 i 前面
                    inside = inter / (_area(a) or 1.0) >= 0.95
                    if zh:
                        txt = f"在{ref}后方" + ("" if inside else "，被它部分遮挡")
                    else:
                        txt = f"behind {ref}" + ("" if inside else ", partly hidden by it")
                    behinds.append((inter, txt))
            fronts.sort(key=lambda x: -x[0])
            behinds.sort(key=lambda x: -x[0])
            parts += [t for _, t in fronts[:2]] + [t for _, t in behinds[:2]]
        if not parts and not tier_txt:
            out.append("")
            continue
        sep = "；" if zh else "; "
        body = sep.join(parts)
        if tier_txt:
            body = tier_txt + (("，" if zh else ", ") + body if body else "")
        if zh:
            out.append(body + "。")
        else:
            out.append(body[0].upper() + body[1:] + ".")
    return out


def perspective_phrase(p: dict, width: int, height: int, zh: bool) -> str:
    y0 = p.get("horizon_y", height / 2)
    r = y0 / height if height else 0.5
    mode = p.get("mode", 1)
    if zh:
        if r < 0:
            view = "高角度鸟瞰俯视，地平线在画面上方之外"
        elif r < 0.2:
            view = "高角度俯视，地平线很高、靠近画面顶部"
        elif r < 0.4:
            view = "略微俯视，地平线位于画面上三分之一"
        elif r <= 0.6:
            view = "平视机位，地平线位于画面中部"
        elif r <= 0.8:
            view = "略微仰视，地平线位于画面下三分之一"
        elif r <= 1:
            view = "低机位仰视，地平线靠近画面底部"
        else:
            view = "极低机位虫视仰拍，地平线在画面下方之外"
    else:
        if r < 0:
            view = "high-angle bird's-eye view looking down, horizon above the frame"
        elif r < 0.2:
            view = "high-angle view looking down, high horizon near the top of the frame"
        elif r < 0.4:
            view = "slightly high-angle view, horizon in the upper third"
        elif r <= 0.6:
            view = "eye-level view, horizon near the middle of the frame"
        elif r <= 0.8:
            view = "slightly low-angle view, horizon in the lower third"
        elif r <= 1:
            view = "low-angle view looking up, low horizon near the bottom of the frame"
        else:
            view = "worm's-eye view looking up, horizon below the frame"

    def xpos(x: float) -> str:
        q = x / width if width else 0.5
        if zh:
            if q < 0:
                return "画面左侧之外"
            if q < 0.4:
                return "偏左"
            if q <= 0.6:
                return "画面中央"
            if q <= 1:
                return "偏右"
            return "画面右侧之外"
        if q < 0:
            return "off-frame to the left"
        if q < 0.4:
            return "left of center"
        if q <= 0.6:
            return "at the center"
        if q <= 1:
            return "right of center"
        return "off-frame to the right"

    vp1 = p.get("vp1_x", width / 2)
    vp2 = p.get("vp2_x", width * 1.4)
    if mode == 1:
        persp = (f"一点透视，消失点在地平线{xpos(vp1)}" if zh
                 else f"one-point perspective with the vanishing point {xpos(vp1)} on the horizon")
    else:
        a, b = sorted([vp1, vp2])
        persp = (f"两点透视，两个消失点分别在{xpos(a)}和{xpos(b)}" if zh
                 else f"two-point perspective with vanishing points {xpos(a)} and {xpos(b)}")
        if mode == 3:
            up = p.get("vp3_y", height * 2.5) < y0
            if zh:
                persp = "三点透视，" + persp[5:] + ("，竖直线向上汇聚" if up else "，竖直线向下汇聚")
            else:
                persp = "three-point perspective, " + persp[len("two-point perspective "):] + (
                    ", vertical lines converging upward" if up else ", vertical lines converging downward")
    if zh:
        return f"机位与透视：{view}；{persp}。"
    return f"Camera and perspective: {view}; {persp}."


def _append_sentence(base: str, extra: str) -> str:
    base = base.rstrip()
    if not extra:
        return base
    zh = _is_cjk(base)
    if base and base[-1] not in ".。!！?？;；":
        base += "。" if zh else "."
    if not base:
        return extra
    return f"{base}{extra}" if zh and base[-1] in "。！？；" else f"{base} {extra}"


def prepare_layout_for_compile(draft: dict) -> dict:
    """
    把带编辑器元数据的 Layout 草稿转成官方 schema：
    - 隐藏的框不参与编译
    - prompt_options.depth（默认开）→ 前后关系短语追加到各框 caption
    - prompt_options.perspective（默认关）→ 机位/透视短语追加到 summary.caption
    - 剥离 id/name/hidden/locked/depth/color、perspective、prompt_options
    坐标不做任何改动。
    """
    opts = draft.get("prompt_options") if isinstance(draft.get("prompt_options"), dict) else {}
    use_depth = opts.get("depth") is not False
    use_persp = bool(opts.get("perspective"))
    visible = [it for it in draft.get("items", []) if not it.get("hidden")]
    if not visible:
        raise ValueError("所有框都被隐藏了（隐藏的框不参与编译）")
    phrases = depth_phrases(visible) if use_depth else [""] * len(visible)
    items = []
    for it, ph in zip(visible, phrases):
        clean = {k: v for k, v in it.items() if k not in EDITOR_ITEM_KEYS}
        if ph:
            clean["caption"] = _append_sentence(clean["caption"], ph)
        items.append(clean)
    summary = dict(draft["summary"])
    persp = draft.get("perspective")
    if use_persp and isinstance(persp, dict):
        zh = _is_cjk(summary.get("caption", ""))
        summary["caption"] = _append_sentence(
            summary["caption"], perspective_phrase(persp, draft["width"], draft["height"], zh)
        )
    return {k: v for k, v in draft.items() if k not in EDITOR_ROOT_KEYS} | {
        "summary": summary,
        "items": items,
    }


LAYER_RULES_HINT = (
    "图层约定：items 数组顺序就是图层顺序，越靠后越靠前（离镜头越近、会遮挡前面的元素）。"
    "请把远景/背景元素放在数组前面，前景主体放在后面。"
)

# 有用户画框时追加在系统提示之后，覆盖「请自行摆框 / 可调整」的默认行为。
DRAWN_BOX_SYSTEM_ADDENDUM = (
    "用户已经在画布上画好了框，这些框是硬约束，必须严格遵守。"
    "坐标系：原点在画布左上角，x 向右、y 向下，单位为绝对像素，与图像/画布同尺寸；"
    "bbox 格式为 xyxy [x1,y1,x2,y2]（左、上、右、下）。"
    "禁止改用中心坐标、归一化 0–1、千分位或 yxyx。"
    "输出 items 的数量、顺序、label、bbox 必须与用户列表完全一致，禁止移动、缩放、增删、合并、拆分或重排。"
    "上面的「远景放前面」只解释当前顺序的含义，不要为了远近关系改已有框。"
    "只根据用户想法书写 summary.caption，并按每个框的位置、大小、名称、已有描述和可见文字书写该框的 caption；"
    "标注必须留在原框内，禁止把一个框的主体写进另一个框。"
    "隐藏框原样保留。用户已填写的可见文字（text）保持原文。"
)

CONTEXT_META_HINT = (
    LAYER_RULES_HINT
    + "draft 中的 id/name/hidden/locked/depth/color 以及根级 perspective/prompt_options 是编辑器字段，"
    "请原样保留（不要删除或改名）；depth 取值 auto|fg|mg|bg 表示前景/中景/背景。"
    "需要调整前后关系时，改 items 数组顺序或 depth。"
)


def _sanitize_draft(draft: Any, *, mode: str | None = None, width: int | None = None, height: int | None = None) -> dict:
    if not isinstance(draft, dict):
        if mode == "layout":
            return _sanitize_layout_draft({}, width, height)
        return {"caption": "An image."}
    looks_layout = "items" in draft or mode == "layout"
    looks_caption = mode == "caption" or (
        "caption" in draft and "items" not in draft and "summary" not in draft
    )
    if looks_layout and not (mode == "caption" and looks_caption):
        return _sanitize_layout_draft(draft, width, height)
    return _sanitize_caption_draft(draft)


def _compile_safe(draft: dict) -> tuple[str | None, str | None]:
    """Return (prompt, error)."""
    try:
        if "items" in draft:
            draft = prepare_layout_for_compile(draft)
        return compile_prompt(draft), None
    except (ValueError, TypeError, OverflowError) as e:
        return None, str(e)


# Ensure default skills file exists
load_skills()

# ---------- routes ----------
@app.get("/api/health")
def health():
    return {"ok": True, "compile": str(SKILL_COMPILE.exists())}


@app.get("/api/settings")
def get_settings():
    return public_settings(load_settings())


@app.put("/api/settings")
def put_settings(body: SettingsBody):
    s = load_settings()
    data = body.model_dump(exclude_none=True)
    # empty api_key means "keep existing"
    if "api_key" in data and data["api_key"] == "":
        del data["api_key"]
    s.update(data)
    _save_json(SETTINGS_PATH, s)
    return public_settings(s)


def _resolve_creds(body: Optional[ProbeBody] = None) -> tuple[str, str]:
    s = load_settings()
    base = (s.get("base_url") or "https://api.openai.com/v1").rstrip("/")
    key = (s.get("api_key") or "").strip()
    if body is not None:
        if body.base_url and body.base_url.strip():
            base = body.base_url.strip().rstrip("/")
        if body.api_key and body.api_key.strip():
            key = body.api_key.strip()
    return base, key


@app.post("/api/settings/test")
async def test_settings(body: ProbeBody = ProbeBody()):
    """Probe upstream: GET /models then a tiny chat/completions ping."""
    import time

    base, key = _resolve_creds(body)
    if not key:
        raise HTTPException(status_code=400, detail="未提供 API Key（表单留空且本地也未保存）。")
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    out: dict[str, Any] = {
        "ok": False,
        "base_url": base,
        "models_ok": False,
        "chat_ok": False,
        "latency_ms": None,
        "model_count": 0,
        "sample_models": [],
        "message": "",
    }
    t0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            mr = await client.get(f"{base}/models", headers=headers)
        except httpx.RequestError as e:
            out["message"] = f"无法连接上游: {e}"
            out["latency_ms"] = int((time.perf_counter() - t0) * 1000)
            return out
        if mr.status_code >= 400:
            out["message"] = f"GET /models 失败 {mr.status_code}: {mr.text[:300]}"
            out["latency_ms"] = int((time.perf_counter() - t0) * 1000)
            return out
        out["models_ok"] = True
        try:
            data = mr.json()
            ids = [m.get("id") for m in (data.get("data") or []) if isinstance(m, dict) and m.get("id")]
        except Exception:
            ids = []
        out["model_count"] = len(ids)
        out["sample_models"] = ids[:12]

        s = load_settings()
        use_model = (body.model or "").strip() or s.get("model") or (ids[0] if ids else "gpt-4o-mini")
        payload = {
            "model": use_model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 8,
            "temperature": 0,
        }
        try:
            cr = await client.post(f"{base}/chat/completions", headers=headers, json=payload)
        except httpx.RequestError as e:
            out["message"] = f"/models 成功，但 chat 连接失败: {e}"
            out["latency_ms"] = int((time.perf_counter() - t0) * 1000)
            return out
        out["latency_ms"] = int((time.perf_counter() - t0) * 1000)
        if cr.status_code >= 400:
            out["message"] = (
                f"/models 成功（{len(ids)} 个模型），但 chat 失败 {cr.status_code}: {cr.text[:300]}"
            )
            return out
        out["chat_ok"] = True
        out["ok"] = True
        out["tested_model"] = use_model
        out["message"] = f"连通正常 · {out['latency_ms']} ms · 模型数 {len(ids)} · 已测 chat: {use_model}"
        return out


@app.post("/api/settings/models")
async def list_upstream_models(body: ProbeBody = ProbeBody()):
    """List model ids from OpenAI-compatible GET /v1/models."""
    base, key = _resolve_creds(body)
    if not key:
        raise HTTPException(status_code=400, detail="未提供 API Key（表单留空且本地也未保存）。")
    headers = {"Authorization": f"Bearer {key}"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            r = await client.get(f"{base}/models", headers=headers)
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"无法连接上游: {e}") from e
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"GET /models 失败 {r.status_code}: {r.text[:400]}")
    try:
        data = r.json()
        ids = sorted(
            {m.get("id") for m in (data.get("data") or []) if isinstance(m, dict) and m.get("id")}
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"解析模型列表失败: {e}") from e
    return {"base_url": base, "models": ids, "count": len(ids)}



@app.get("/api/skills")
def api_list_skills():
    store = load_skills()
    return store


@app.put("/api/skills/active")
def api_set_active_skill(body: SkillActiveBody):
    kind = body.kind
    if kind not in ("caption", "layout", "context"):
        raise HTTPException(status_code=400, detail="kind 必须是 caption|layout|context")
    store = load_skills()
    skill = None
    for s in store["skills"]:
        if s["id"] == body.id:
            skill = s
            break
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {body.id}")
    if skill["kind"] != kind:
        raise HTTPException(status_code=400, detail=f"Skill 类型为 {skill['kind']}，不能设为 {kind}")
    store["active"][kind] = body.id
    store = save_skills(store)
    return store


@app.post("/api/skills")
def api_create_skill(body: SkillCreateBody):
    kind = body.kind
    if kind not in ("caption", "layout", "context"):
        raise HTTPException(status_code=400, detail="kind 必须是 caption|layout|context")
    name = (body.name or "").strip()
    prompt = (body.system_prompt or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name 必填")
    if not prompt:
        raise HTTPException(status_code=400, detail="system_prompt 必填")
    store = load_skills()
    sid = f"custom-{uuid.uuid4().hex[:10]}"
    skill = {
        "id": sid,
        "name": name,
        "kind": kind,
        "builtin": False,
        "description": (body.description or "").strip(),
        "system_prompt": prompt,
        "updated_at": _now_iso(),
    }
    store["skills"].append(skill)
    store = save_skills(store)
    return {"skill": skill, **{k: store[k] for k in ("skills", "active")}}


@app.put("/api/skills/{skill_id}")
def api_update_skill(skill_id: str, body: SkillUpdateBody):
    store = load_skills()
    idx = next((i for i, s in enumerate(store["skills"]) if s["id"] == skill_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_id}")
    skill = dict(store["skills"][idx])
    data = body.model_dump(exclude_none=True)
    if skill.get("builtin"):
        if "system_prompt" in data:
            raise HTTPException(
                status_code=400,
                detail="内置 Skill 不可直接改 system_prompt，请用「重置」或先复制为自定义。",
            )
    if "name" in data:
        name = str(data["name"]).strip()
        if not name:
            raise HTTPException(status_code=400, detail="name 不能为空")
        skill["name"] = name
    if "description" in data:
        skill["description"] = str(data["description"])
    if "system_prompt" in data:
        prompt = str(data["system_prompt"]).strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="system_prompt 不能为空")
        skill["system_prompt"] = prompt
    skill["updated_at"] = _now_iso()
    store["skills"][idx] = skill
    store = save_skills(store)
    return {"skill": skill, "skills": store["skills"], "active": store["active"]}


@app.post("/api/skills/{skill_id}/reset")
def api_reset_skill(skill_id: str):
    if skill_id not in OFFICIAL_SKILL_PROMPTS:
        raise HTTPException(status_code=400, detail="仅内置 Skill 可重置")
    store = load_skills()
    idx = next((i for i, s in enumerate(store["skills"]) if s["id"] == skill_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_id}")
    skill = dict(store["skills"][idx])
    if not skill.get("builtin"):
        raise HTTPException(status_code=400, detail="仅内置 Skill 可重置")
    meta = next(m for m in OFFICIAL_SKILL_META if m["id"] == skill_id)
    skill["name"] = meta["name"]
    skill["description"] = meta["description"]
    skill["system_prompt"] = OFFICIAL_SKILL_PROMPTS[skill_id]
    skill["updated_at"] = _now_iso()
    store["skills"][idx] = skill
    store = save_skills(store)
    return {"skill": skill, "skills": store["skills"], "active": store["active"]}


@app.post("/api/skills/{skill_id}/duplicate")
def api_duplicate_skill(skill_id: str):
    store = load_skills()
    src = next((s for s in store["skills"] if s["id"] == skill_id), None)
    if not src:
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_id}")
    sid = f"custom-{uuid.uuid4().hex[:10]}"
    skill = {
        "id": sid,
        "name": f"{src['name']} 副本",
        "kind": src["kind"],
        "builtin": False,
        "description": src.get("description") or "",
        "system_prompt": src["system_prompt"],
        "updated_at": _now_iso(),
    }
    store["skills"].append(skill)
    store = save_skills(store)
    return {"skill": skill, "skills": store["skills"], "active": store["active"]}


@app.delete("/api/skills/{skill_id}")
def api_delete_skill(skill_id: str):
    store = load_skills()
    skill = next((s for s in store["skills"] if s["id"] == skill_id), None)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_id}")
    if skill.get("builtin"):
        raise HTTPException(status_code=400, detail="内置 Skill 不可删除")
    kind = skill["kind"]
    store["skills"] = [s for s in store["skills"] if s["id"] != skill_id]
    if store["active"].get(kind) == skill_id:
        store["active"][kind] = DEFAULT_ACTIVE[kind]
    store = save_skills(store)
    return store


@app.post("/api/compile")
def api_compile(body: CompileBody):
    mode_hint = "caption" if "caption" in body.draft and "items" not in body.draft else "layout"
    draft = _sanitize_draft(body.draft, mode=mode_hint)
    prompt, err = _compile_safe(draft)
    if err or prompt is None:
        raise HTTPException(status_code=400, detail=err or "编译失败")
    mode = "caption" if "items" not in draft else "layout"
    return {"prompt": prompt, "mode": mode, "draft": draft}


def _clamp_user_bbox(bbox: list, w: int, h: int) -> Optional[list[int]]:
    """把用户框收进画布，尽量保持原位置和大小。无法形成正面积时返回 None。"""
    if not (isinstance(bbox, list) and len(bbox) == 4):
        return None
    x1, y1, x2, y2 = (_as_int(v) for v in bbox)
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    x1 = max(0, min(x1, w - 1))
    y1 = max(0, min(y1, h - 1))
    x2 = max(x1 + 1, min(x2, w))
    y2 = max(y1 + 1, min(y2, h))
    if x2 <= x1 or y2 <= y1:
        return None
    return [x1, y1, x2, y2]


def _coerce_drawn_boxes(raw: Any, width: int, height: int) -> list[dict]:
    """规范化前端传来的画框。坐标保持画布绝对像素 xyxy，不换成中心坐标。"""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for it in raw:
        if not isinstance(it, dict):
            continue
        bbox = _clamp_user_bbox(it.get("bbox"), width, height)
        if bbox is None:
            continue
        label = it.get("label") if it.get("label") in ("object", "character", "text") else "object"
        cap = it.get("caption") if isinstance(it.get("caption"), str) else ""
        item: dict[str, Any] = {"label": label, "caption": cap.strip(), "bbox": bbox}
        item.update(_sanitize_item_meta(it))
        if isinstance(it.get("text"), str) and it["text"].strip():
            item["text"] = it["text"].strip()
        for key in ("tags", "palette"):
            val = it.get(key)
            if isinstance(val, list):
                cleaned = [str(x).strip() for x in val if isinstance(x, str) and str(x).strip()]
                if cleaned:
                    item[key] = cleaned
        out.append(item)
    return out


def _perspective_constraint(p: Any, width: int, height: int) -> Optional[dict]:
    if not isinstance(p, dict) or not p.get("enabled"):
        return None
    mode = p.get("mode") if p.get("mode") in (1, 2, 3) else 1

    def n(key: str, default: float) -> int:
        try:
            if isinstance(p.get(key), bool):
                return int(round(default))
            return int(round(float(p.get(key))))
        except (TypeError, ValueError):
            return int(round(default))

    hy = n("horizon_y", height / 2)
    out: dict[str, Any] = {
        "mode": mode,
        "kind": {1: "一点透视", 2: "两点透视", 3: "三点透视"}[mode],
        "horizon_y": hy,
        "vp1": [n("vp1_x", width / 2), hy],
    }
    if mode >= 2:
        out["vp2"] = [n("vp2_x", width * 1.4), hy]
    if mode == 3:
        out["vp3"] = [n("vp3_x", width / 2), n("vp3_y", height * 2.5)]
    out["note"] = "与框同一像素坐标系（可在画布外）。只用于描写机位，禁止据此移动框。"
    return out


def format_drawn_box_prompt(boxes: list[dict], width: int, height: int, perspective: Any = None) -> str:
    """模型必须看到的画框清单。bbox 为画布左上角原点的绝对像素 xyxy。"""
    rows: list[dict] = []
    n = len(boxes)
    for i, it in enumerate(boxes):
        x1, y1, x2, y2 = it["bbox"]
        row: dict[str, Any] = {
            "index": i,
            "z_order": i,
            "z_note": "最前（遮挡更早的框）" if i == n - 1 else ("最底（最远）" if i == 0 else "中间层"),
            "id": it.get("id"),
            "label": it["label"],
            "bbox": [x1, y1, x2, y2],
            "bbox_format": "xyxy",
            "size": [x2 - x1, y2 - y1],
        }
        if it.get("name"):
            row["name"] = it["name"]
        if it.get("depth"):
            row["depth"] = it["depth"]
        if it.get("caption"):
            row["caption"] = it["caption"]
        if it.get("text"):
            row["text"] = it["text"]
        if it.get("tags"):
            row["tags"] = it["tags"]
        if it.get("hidden"):
            row["hidden"] = True
        if it.get("locked"):
            row["locked"] = True
        rows.append(row)
    spec: dict[str, Any] = {
        "coord_space": "abs",
        "origin": "top-left",
        "x_axis": "right",
        "y_axis": "down",
        "unit": "pixel",
        "bbox_format": "xyxy",
        "canvas_width": width,
        "canvas_height": height,
        "z_order": "index/z_order 越大越靠前，会遮挡更小的 index",
        "boxes": rows,
    }
    persp = _perspective_constraint(perspective, width, height)
    if persp:
        spec["perspective"] = persp
    return (
        "用户已在画布上绘制以下区域。生成布局时必须严格使用这些框，不得忽略或自行重摆。\n"
        "硬性约束：\n"
        "- 坐标系与图像一致：原点在画布左上角，x 向右、y 向下，绝对像素；"
        f"画布 {width}×{height}。\n"
        "- bbox 为 [x1, y1, x2, y2]（左、上、右、下）。不要换成中心坐标、归一化坐标或 yxyx。\n"
        "- 输出 items 与 boxes 逐条对应：数量、顺序、id（若输出）、label、bbox 数字必须原样复制。\n"
        "- 禁止新增、删除、合并、拆分、重排、移动或缩放任何框。\n"
        "- 只根据用户想法填写 summary.caption，并按该框的位置、大小和已有 name/caption/text/tags 书写 caption。\n"
        "- 已有标注是内容约束：主体必须留在原框，禁止串到其他框。隐藏框的 caption 与 bbox 原样保留。\n"
        "- 用户已给出的 text 必须原样保留。\n"
        "画框数据（JSON，以此为准）：\n"
        + json.dumps(spec, ensure_ascii=False, indent=2)
    )


def layout_enhance_system(base: str, width: int, height: int, has_boxes: bool) -> str:
    system = base + f"\n画布尺寸: {width}x{height}\n" + LAYER_RULES_HINT
    if has_boxes:
        system += "\n" + DRAWN_BOX_SYSTEM_ADDENDUM
    return system


def build_layout_enhance_user(
    idea: str,
    width: int,
    height: int,
    boxes: Any = None,
    perspective: Any = None,
    context_hint: str | None = None,
) -> tuple[str, list[dict]]:
    """返回 (user 消息, 规范化后的画框)。有画框时提示词含坐标且要求严格遵守。"""
    user = f"用户想法:\n{idea}\n\n请输出 Layout JSON，width={width}, height={height}。"
    drawn = _coerce_drawn_boxes(boxes, width, height)
    hint = (context_hint or "").strip()
    if drawn:
        user += "\n\n" + format_drawn_box_prompt(drawn, width, height, perspective)
        return user, drawn
    if hint and ("bbox=" in hint or "必须严格" in hint):
        # 兼容只通过文本带上坐标的客户端：不再标成「可调整」。
        user += "\n\n以下画框约束必须严格遵守（坐标为画布绝对像素 xyxy）：\n" + hint[:12000]
    elif hint:
        user += f"\n\n编辑器当前状态（供参考，可按想法调整）：\n{hint[:2000]}"
    return user, drawn


_PLACEHOLDER_CAP = re.compile(r"^(?:区域|region)\s*\d+$", re.IGNORECASE)


def _is_placeholder_caption(cap: str) -> bool:
    text = (cap or "").strip()
    return not text or bool(_PLACEHOLDER_CAP.match(text))


def _merge_box_caption(user_cap: str, model_cap: str, *, hidden: bool) -> str:
    """隐藏框保留用户原文。占位描述交给模型；用户写过的标注不能被模型丢掉。"""
    user_cap = (user_cap or "").strip()
    model_cap = (model_cap or "").strip()
    if hidden or not model_cap:
        return user_cap
    if _is_placeholder_caption(user_cap) or user_cap in model_cap:
        return model_cap
    joiner = "。" if _is_cjk(user_cap) else ". "
    return f"{user_cap}{joiner}{model_cap}"


def pin_drawn_boxes(draft: dict, boxes: Any, width: int, height: int) -> dict:
    """把模型结果的几何锁回用户画框。可见框可以改写 caption，但坐标与标注仍以用户框为准。"""
    drawn = _coerce_drawn_boxes(boxes, width, height)
    if not drawn or not isinstance(draft, dict):
        return draft
    model_items = draft.get("items") if isinstance(draft.get("items"), list) else []
    by_id: dict[str, dict] = {}
    for it in model_items:
        if isinstance(it, dict) and isinstance(it.get("id"), str) and it["id"].strip():
            by_id[it["id"].strip()] = it
    src_ids = [b["id"] for b in drawn if isinstance(b.get("id"), str) and b["id"]]
    use_id = (
        len(src_ids) == len(drawn)
        and len(set(src_ids)) == len(src_ids)
        and set(src_ids) <= set(by_id)
    )
    pinned: list[dict] = []
    for i, src in enumerate(drawn):
        model: Any = None
        if use_id:
            model = by_id.get(src.get("id"))
        elif i < len(model_items) and isinstance(model_items[i], dict):
            model = model_items[i]
        model_cap = ""
        if isinstance(model, dict) and isinstance(model.get("caption"), str):
            model_cap = model["caption"]
        caption = _merge_box_caption(src.get("caption") or "", model_cap, hidden=bool(src.get("hidden")))
        if not caption:
            caption = f"Region {i + 1}"
        item: dict[str, Any] = {
            "label": src["label"],
            "caption": caption,
            "bbox": list(src["bbox"]),
        }
        for key in ("id", "name", "hidden", "locked", "depth", "color"):
            if key in src:
                item[key] = src[key]
        if src.get("text"):
            item["text"] = src["text"]
        elif src["label"] == "text":
            model_text = model.get("text") if isinstance(model, dict) else None
            if isinstance(model_text, str) and model_text.strip():
                item["text"] = model_text.strip()
            else:
                item["text"] = caption
        for key in ("tags", "palette"):
            if src.get(key):
                item[key] = list(src[key])
            elif isinstance(model, dict) and isinstance(model.get(key), list):
                cleaned = [str(x).strip() for x in model[key] if isinstance(x, str) and str(x).strip()]
                if cleaned:
                    item[key] = cleaned
        pinned.append(item)
    out = dict(draft)
    out["width"] = width
    out["height"] = height
    out["bbox_coord_space"] = "abs"
    out["bbox_format"] = "xyxy"
    out["items"] = pinned
    return out


def _layout_from_drawn_boxes(idea: str, width: int, height: int, boxes: list[dict]) -> dict:
    """无 API Key 时保留用户画框，不再换成居中大框。"""
    items = []
    for i, src in enumerate(boxes):
        cap = (src.get("caption") or "").strip() or (src.get("name") or "").strip() or f"Region {i + 1}"
        item = {"label": src["label"], "caption": cap, "bbox": list(src["bbox"])}
        for key in ("id", "name", "hidden", "locked", "depth", "color", "text", "tags", "palette"):
            if key in src and src[key] not in (None, "", []):
                item[key] = src[key]
        if item["label"] == "text" and "text" not in item:
            item["text"] = cap
        items.append(item)
    return {
        "width": width,
        "height": height,
        "bbox_coord_space": "abs",
        "bbox_format": "xyxy",
        "summary": {"caption": idea.strip() or "A composed image.", "canvas": "single"},
        "items": items,
    }


@app.post("/api/enhance")
async def api_enhance(body: EnhanceBody):
    idea = (body.idea or "").strip()
    if not idea:
        raise HTTPException(status_code=400, detail="想法不能为空")
    w, h = _ensure_wh(body.width, body.height)
    s = load_settings()
    has_key = bool((s.get("api_key") or "").strip())
    drawn = _coerce_drawn_boxes(body.boxes, w, h) if body.mode == "layout" else []

    if not has_key:
        if body.mode == "layout":
            draft = _layout_from_drawn_boxes(idea, w, h, drawn) if drawn else _fallback_layout(idea, w, h)
        else:
            draft = _fallback_caption(idea)
        draft = _sanitize_draft(draft, mode=body.mode, width=w, height=h)
        if drawn:
            draft = pin_drawn_boxes(draft, drawn, w, h)
        prompt, _cerr = _compile_safe(draft)
        return {
            "draft": draft,
            "mode": body.mode,
            "degraded": True,
            "message": "未配置 API Key，已使用本地规则降级（原文包装）。请在设置中填写密钥以启用 LLM 增强。",
            "prompt": prompt,
        }

    kind = "layout" if body.mode == "layout" else "caption"
    skill = resolve_skill(kind, body.skill_id)
    if body.mode == "layout":
        system = layout_enhance_system(skill["system_prompt"], w, h, bool(drawn))
        user, drawn = build_layout_enhance_user(
            idea, w, h, body.boxes, body.perspective, body.context_hint
        )
    else:
        system = skill["system_prompt"]
        user = f"用户想法:\n{idea}"

    messages = [{"role": "system", "content": system}]
    if body.messages:
        messages.extend(body.messages)
    messages.append({"role": "user", "content": user})

    raw = await _chat(messages)
    try:
        draft = _extract_json(raw)
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"模型返回无法解析为 JSON: {e}\n原文: {raw[:800]}") from e

    draft = _sanitize_draft(draft, mode=body.mode, width=w, height=h)
    if drawn:
        draft = pin_drawn_boxes(draft, drawn, w, h)
    prompt, cerr = _compile_safe(draft)
    out = {"draft": draft, "mode": body.mode, "degraded": False, "raw": raw[:2000], "prompt": prompt}
    if cerr:
        out["compile_error"] = cerr
    return out


@app.post("/api/context")
async def api_context(body: ContextBody):
    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="消息不能为空")
    s = load_settings()
    has_key = bool((s.get("api_key") or "").strip())

    if not has_key:
        # local keyword fallbacks
        draft = json.loads(json.dumps(body.draft))  # deep copy
        reply = _local_context_edit(draft, msg)
        mode_hint = "layout" if "items" in draft else "caption"
        draft = _sanitize_draft(draft, mode=mode_hint)
        prompt, _ = _compile_safe(draft)
        return {"draft": draft, "reply": reply, "degraded": True, "prompt": prompt}

    skill = resolve_skill("context", body.skill_id)
    payload: dict[str, Any] = {"draft": body.draft, "instruction": msg, "history": body.history or []}
    if isinstance(body.draft, dict) and "items" in body.draft:
        payload["layer_notes"] = CONTEXT_META_HINT
        payload["layer_order_front_to_back"] = _layer_order_summary(body.draft)
    messages = [
        {"role": "system", "content": skill["system_prompt"]},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    raw = await _chat(messages)
    try:
        parsed = _extract_json(raw)
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"模型返回无法解析: {e}\n{raw[:800]}") from e

    draft = parsed.get("draft", body.draft)
    reply = parsed.get("reply", "已更新草稿。")
    mode_hint = "layout" if isinstance(draft, dict) and "items" in draft else "caption"
    draft = _sanitize_draft(draft, mode=mode_hint)
    prompt, cerr = _compile_safe(draft)
    out = {"draft": draft, "reply": reply, "degraded": False, "prompt": prompt}
    if cerr:
        out["compile_error"] = cerr
    return out


def _layer_order_summary(draft: dict) -> list[str]:
    items = draft.get("items") if isinstance(draft.get("items"), list) else []
    zh = {"fg": "前景", "mg": "中景", "bg": "背景"}
    out = []
    for it in reversed(items):
        if not isinstance(it, dict):
            continue
        nm = (it.get("name") or it.get("caption") or it.get("label") or "")[:60]
        extra = []
        if it.get("depth") in zh:
            extra.append(zh[it["depth"]])
        if it.get("hidden"):
            extra.append("隐藏")
        out.append(nm + (f"（{'，'.join(extra)}）" if extra else ""))
    return out


def _local_context_edit(draft: dict, msg: str) -> str:
    """Very small rule-based edits when no API key."""
    lower = msg.lower()
    # caption-only
    if "caption" in draft and "items" not in draft:
        if "改" in msg or "改成" in msg or "改为" in msg:
            # try extract quoted text
            m = re.search(r"[「\"'](.+?)[」\"']", msg)
            if m:
                draft["caption"] = m.group(1)
                return f"已将 caption 改为：{m.group(1)}"
        draft["caption"] = (draft.get("caption") or "") + " " + msg
        return "未配置 API Key：已把指令文本追加到 caption。配置密钥后可智能改稿。"

    # layout
    items = draft.get("items") or []
    if "放大" in msg and items:
        idx = 0
        for i, it in enumerate(items):
            cap = (it.get("caption") or "") + (it.get("text") or "")
            if any(k in cap for k in re.findall(r"[\u4e00-\u9fff]+|[A-Za-z]+", msg)):
                idx = i
                break
        # try match Chinese keywords like 恐龙
        for i, it in enumerate(items):
            blob = json.dumps(it, ensure_ascii=False)
            for token in re.findall(r"[\u4e00-\u9fff]{1,8}", msg):
                if token in ("放大", "缩小", "改", "把", "的", "框") or len(token) < 2:
                    continue
                if token in blob:
                    idx = i
                    break
        it = items[idx]
        x1, y1, x2, y2 = it["bbox"]
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        nw, nh = (x2 - x1) * 1.2, (y2 - y1) * 1.2
        w, h = draft["width"], draft["height"]
        nx1 = max(0, cx - nw / 2)
        ny1 = max(0, cy - nh / 2)
        nx2 = min(w, cx + nw / 2)
        ny2 = min(h, cy + nh / 2)
        it["bbox"] = [int(nx1), int(ny1), int(nx2), int(ny2)]
        return f"未配置 API Key：已将第 {idx+1} 个框放大约 20%。"

    if "缩小" in msg and items:
        it = items[0]
        x1, y1, x2, y2 = it["bbox"]
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        nw, nh = (x2 - x1) * 0.8, (y2 - y1) * 0.8
        it["bbox"] = [int(cx - nw / 2), int(cy - nh / 2), int(cx + nw / 2), int(cy + nh / 2)]
        return "未配置 API Key：已将第一个框缩小约 20%。"

    if ("总结" in msg or "summary" in lower) and "summary" in draft:
        m = re.search(r"[「\"'](.+?)[」\"']", msg)
        if m:
            draft["summary"]["caption"] = m.group(1)
            return "已更新 summary.caption。"
        return "未配置 API Key：请用「把总结改成『…』」或在右侧直接编辑。配置密钥后可智能改稿。"

    return "未配置 API Key：无法智能解析该指令。可直接在属性面板改框/文案，或在设置中填写密钥。"


def _load_caption_prompt() -> str:
    if CAPTION_PROMPT_PATH.exists():
        text = CAPTION_PROMPT_PATH.read_text(encoding="utf-8")
        # extract the prompt block between ```text and ```
        m = re.search(r"```text\n([\s\S]*?)```", text)
        if m:
            return m.group(1).replace("{{reference}}", "(none)")
    return (
        'You are an image recaptioner. Return exactly one JSON object with schema '
        '{"caption":{"long":"...","medium":"...","short":"..."},"watermark":[],"borders":["none"]}'
    )


LAYOUT_REVERSE_DETAIL = {
    "long": (
        "Detail level: LONG. Write rich, vivid English captions for summary.caption and every "
        "item.caption — appearance, materials, lighting, pose, spatial relations. Keep visible "
        "text exact in the text field when label is text."
    ),
    "medium": (
        "Detail level: MEDIUM. Balanced English captions — clear subject, scene, and key traits "
        "without excessive flourish. Keep visible text exact in the text field when label is text."
    ),
    "short": (
        "Detail level: SHORT. Concise English captions — only essentials for summary and each "
        "item. Keep visible text exact in the text field when label is text."
    ),
}


@app.post("/api/reverse")
async def api_reverse(
    file: UploadFile = File(...),
    mode: str = Form("caption"),
    detail: str = Form("medium"),
    width: Optional[int] = Form(None),
    height: Optional[int] = Form(None),
    skill_id: Optional[str] = Form(None),
):
    s = load_settings()
    if not (s.get("api_key") or "").strip():
        raise HTTPException(status_code=400, detail="未配置 API Key，无法调用视觉模型做图像反推。")

    mode = (mode or "caption").strip().lower()
    if mode not in ("caption", "layout"):
        raise HTTPException(status_code=400, detail="mode 必须是 caption 或 layout")
    detail = (detail or "medium").strip().lower()
    if detail not in ("long", "medium", "short"):
        raise HTTPException(status_code=400, detail="detail 必须是 long|medium|short")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="空文件")
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="图片过大（上限 15MB）")

    mime = file.content_type or "image/jpeg"
    b64 = base64.b64encode(raw).decode("ascii")
    data_url = f"data:{mime};base64,{b64}"
    vision_model = s.get("vision_model") or s.get("model") or "gpt-4o"

    if mode == "caption":
        prompt_text = _load_caption_prompt()
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt_text},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ]
        content = await _chat(messages, model=vision_model, max_tokens=8192, temperature=0.7)
        try:
            result = _extract_json(content)
        except (json.JSONDecodeError, ValueError) as e:
            raise HTTPException(status_code=502, detail=f"反推结果无法解析: {e}\n{content[:800]}") from e
        # Keep returning all three caption lengths for caption mode (compat).
        if "caption" not in result or not isinstance(result.get("caption"), dict):
            # tolerate flat {long,medium,short}
            if all(k in result for k in ("long", "medium", "short")):
                result = {
                    "caption": {
                        "long": str(result.get("long") or ""),
                        "medium": str(result.get("medium") or ""),
                        "short": str(result.get("short") or ""),
                    },
                    "watermark": result.get("watermark") or [],
                    "borders": result.get("borders") or ["none"],
                }
            else:
                raise HTTPException(status_code=502, detail=f"反推缺少 caption 字段: {str(result)[:400]}")
        result["mode"] = "caption"
        result["detail"] = detail
        return result

    # layout mode
    if width is None or height is None:
        raise HTTPException(status_code=400, detail="Layout 反推需要 width 与 height（画布像素）")
    w, h = _ensure_wh(int(width), int(height))
    skill = resolve_skill("layout", skill_id)
    system = skill["system_prompt"]
    # Append reverse-specific instructions even for custom skills
    system = (
        system
        + f"\n画布尺寸固定为 width={w}, height={h}。\n"
        + "你正在看一张参考图：根据画面中真实可见的内容写 Layout 草稿，"
        "不要编造看不见的物体。框要尽量贴合可见主体，bbox 必须落在画布内。\n"
        + LAYOUT_REVERSE_DETAIL.get(detail, LAYOUT_REVERSE_DETAIL["medium"])
        + "\n只输出一个 Layout JSON 对象。"
    )
    user_text = (
        f"请根据这张图输出 Layout JSON。width={w}, height={h}, detail={detail}。"
        "描述你看到的内容并放置 bbox。"
    )
    messages = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        },
    ]
    content = await _chat(messages, model=vision_model, max_tokens=8192, temperature=0.5)
    try:
        draft_raw = _extract_json(content)
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"Layout 反推无法解析: {e}\n{content[:800]}") from e

    draft = _sanitize_layout_draft(draft_raw, w, h)
    prompt, cerr = _compile_safe(draft)
    out: dict[str, Any] = {
        "mode": "layout",
        "detail": detail,
        "draft": draft,
        "prompt": prompt,
        "raw": content[:2000],
    }
    if cerr:
        out["compile_error"] = cerr
    return out


@app.get("/api/history")
def get_history():
    items = _load_json(HISTORY_PATH, [])
    if not isinstance(items, list):
        items = []
    # newest first
    items = sorted(items, key=lambda x: x.get("updated_at") or x.get("created_at") or "", reverse=True)
    return {"items": items}


@app.post("/api/history")
def post_history(item: HistoryItem):
    items = _load_json(HISTORY_PATH, [])
    if not isinstance(items, list):
        items = []
    now = _now_iso()
    data = item.model_dump()
    if data.get("id"):
        found = False
        for i, old in enumerate(items):
            if old.get("id") == data["id"]:
                data["created_at"] = old.get("created_at") or now
                data["updated_at"] = now
                items[i] = data
                found = True
                break
        if not found:
            data["created_at"] = now
            data["updated_at"] = now
            items.append(data)
    else:
        data["id"] = uuid.uuid4().hex[:12]
        data["created_at"] = now
        data["updated_at"] = now
        items.append(data)
    _save_json(HISTORY_PATH, items)
    return data


@app.delete("/api/history/{item_id}")
def delete_history(item_id: str):
    items = _load_json(HISTORY_PATH, [])
    if not isinstance(items, list):
        items = []
    items = [x for x in items if x.get("id") != item_id]
    _save_json(HISTORY_PATH, items)
    return {"ok": True}


@app.patch("/api/history/{item_id}")
def rename_history(item_id: str, body: dict):
    items = _load_json(HISTORY_PATH, [])
    title = body.get("title")
    if not title:
        raise HTTPException(status_code=400, detail="title 必填")
    for i, old in enumerate(items):
        if old.get("id") == item_id:
            old["title"] = title
            old["updated_at"] = _now_iso()
            items[i] = old
            _save_json(HISTORY_PATH, items)
            return old
    raise HTTPException(status_code=404, detail="记录不存在")


# Serve frontend build if present
if DIST.exists():
    assets = DIST / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = DIST / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8787, reload=True)
