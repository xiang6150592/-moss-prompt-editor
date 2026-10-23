"""Agent 可用的工具（OpenAI function calling 格式）与标签块协议说明。"""

from __future__ import annotations

import json
import re
from typing import Any

_BBOX = {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 4,
         "description": "[x1,y1,x2,y2] 画布左上角为原点的绝对像素"}
_BODY = {
    "type": "object",
    "description": "3D 体块，用于摄像机机位推导",
    "properties": {
        "z": {"type": "number", "description": "离镜头远近，1.0=主体所在平面，<1 更近，>1 更远（0.15–12）"},
        "thickness": {"type": "number", "description": "沿视线方向的厚度，相对框宽（0=薄片，0.5=人物躯干，1=立方体）"},
        "yaw": {"type": "number", "description": "朝向角（度），0=正对镜头，正值向右转"},
        "anchor": {"type": "string", "enum": ["world", "screen", "backdrop"],
                   "description": "world=场景中的立体物；screen=贴在画面上的字/贴纸/UI，不随镜头动；backdrop=铺满的背景"},
    },
}
_ITEM_PROPS = {
    "name": {"type": "string", "description": "图层名（简短中文，便于引用）"},
    "label": {"type": "string", "enum": ["object", "character", "text"]},
    "bbox": _BBOX,
    "caption": {"type": "string", "description": "该框内可见内容的描述"},
    "text": {"type": "string", "description": "label=text 时要画出来的文字原文"},
    "tags": {"type": "array", "items": {"type": "string"}},
    "palette": {"type": "array", "items": {"type": "string"}},
    "depth": {"type": "string", "enum": ["auto", "fg", "mg", "bg"], "description": "前景/中景/背景"},
    "body": _BODY,
}


def _fn(name: str, desc: str, props: dict, required: list[str] | None = None) -> dict:
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required or []}}}


TOOLS: list[dict] = [
    _fn("update_summary", "修改当前页的整体描述 summary（caption / meta 类型词 / canvas 画布类型 / palette）。", {
        "caption": {"type": "string"},
        "meta": {"type": "array", "items": {"type": "string"}},
        "canvas": {"type": "string", "enum": ["single", "multi_panel", "collage"]},
        "palette": {"type": "array", "items": {"type": "string"}},
    }),
    _fn("add_items", "在当前页新增一个或多个框。默认放到最前（数组末尾）；insert_at 为层号（1=最底）。", {
        "items": {"type": "array", "items": {"type": "object", "properties": {
            **_ITEM_PROPS, "insert_at": {"type": "integer"}}, "required": ["label", "bbox", "caption"]}},
    }, ["items"]),
    _fn("update_items", "修改已有框，只写要改的字段。ref 可用 id、图层名或 #层号。锁定的框不能改。", {
        "updates": {"type": "array", "items": {"type": "object", "properties": {
            "ref": {"type": "string"}, **_ITEM_PROPS, "hidden": {"type": "boolean"}}, "required": ["ref"]}},
    }, ["updates"]),
    _fn("remove_items", "删除框。", {"refs": {"type": "array", "items": {"type": "string"}}}, ["refs"]),
    _fn("reorder_items", "调整图层前后：按从后到前列出要重排的框，未列出的框位置不变。", {
        "order": {"type": "array", "items": {"type": "string"}},
    }, ["order"]),
    _fn("replace_layout", "整页重写布局（新构图 / 大改时用）。可按任意画布尺寸写坐标并给出 width/height，"
        "程序会等比缩放并居中到当前画布；resize_canvas=true 时改用你给的尺寸作为画布。名字相同的旧框会继承编辑器设置，锁定框自动保留。", {
        "summary": {"type": "object", "properties": {
            "caption": {"type": "string"}, "meta": {"type": "array", "items": {"type": "string"}},
            "canvas": {"type": "string", "enum": ["single", "multi_panel", "collage"]},
            "palette": {"type": "array", "items": {"type": "string"}}}, "required": ["caption"]},
        "items": {"type": "array", "items": {"type": "object", "properties": _ITEM_PROPS,
                                             "required": ["label", "bbox", "caption"]}},
        "width": {"type": "number"}, "height": {"type": "number"},
        "resize_canvas": {"type": "boolean"},
    }, ["summary", "items"]),
    _fn("set_canvas_size", "改画布尺寸（自动取 16 的倍数），scale_items 默认按比例缩放现有框。", {
        "width": {"type": "number"}, "height": {"type": "number"}, "scale_items": {"type": "boolean"},
    }, ["width", "height"]),
    _fn("set_camera", "设置摄像机机位（会开启 3D 镜头）。只写要改的参数。", {
        "enabled": {"type": "boolean"},
        "orbit": {"type": "number", "description": "环绕角（度，-180..180），正值=镜头绕到主体右侧"},
        "pitch": {"type": "number", "description": "俯仰（度，-85..85），正值=镜头升高向下俯拍，负值=仰拍"},
        "roll": {"type": "number", "description": "滚转（度），荷兰角"},
        "distance": {"type": "number", "description": "距离倍数，1=初始，<1 推近，>1 拉远"},
        "fov": {"type": "number", "description": "视角（度，10..120），50=标准，大=广角，小=长焦"},
        "pan_x": {"type": "number"}, "pan_y": {"type": "number"}, "pan_z": {"type": "number"},
    }),
    _fn("set_bodies", "给框设置 3D 体块（远近 z、厚度、朝向 yaw、锚定方式），框位与描述不变。", {
        "bodies": {"type": "array", "items": {"type": "object", "properties": {
            "ref": {"type": "string"}, **_BODY["properties"]}, "required": ["ref"]}},
    }, ["bodies"]),
    _fn("set_caption", "写入当前页的 Caption 散文（Caption 模式，无坐标）。activate 默认把页面切到 Caption。", {
        "caption": {"type": "string"}, "activate": {"type": "boolean"},
    }, ["caption"]),
    _fn("create_page", "在当前系列新建一页（多个版本 / 方案时用），之后的修改都写到新页。", {
        "name": {"type": "string"}, "kind": {"type": "string", "enum": ["layout", "caption"]},
        "width": {"type": "number"}, "height": {"type": "number"},
    }, ["name"]),
    _fn("switch_page", "切换要修改的页面（页面 id 或名称）。", {"page": {"type": "string"}}, ["page"]),
    _fn("view_page", "查看同系列另一页的完整内容。", {"page": {"type": "string"}}, ["page"]),
    _fn("ask_user", "需要用户做选择时提问（会结束本轮，等用户回答）。选项 2–6 个，简短。", {
        "question": {"type": "string"},
        "options": {"type": "array", "items": {"type": "string"}},
        "multi": {"type": "boolean", "description": "是否多选"},
    }, ["question", "options"]),
]

TOOL_NAMES = {t["function"]["name"] for t in TOOLS}


def tags_protocol_text() -> str:
    lines = [
        "## 工具调用（标签协议）",
        "当前接口不支持原生函数调用。需要修改工作台时，在回复里写工具标签，每个标签一行开头，参数是严格 JSON：",
        '<tool name="update_items">{"updates":[{"ref":"主体","caption":"..."}]}</tool>',
        "可以连续写多个标签；写完标签就停止输出，等待 <tool_results>，再继续。标签内容用户看不到，所以标签外要用中文说明你做了什么。",
        "可用工具：",
    ]
    for t in TOOLS:
        f = t["function"]
        props = ", ".join(f["parameters"]["properties"].keys())
        lines.append(f"- {f['name']}({props})：{f['description']}")
    return "\n".join(lines)


_TAG_RE = re.compile(r'<tool\s+name\s*=\s*"([a-z_]+)"\s*>([\s\S]*?)</tool>')


def parse_tool_tags(text: str) -> list[dict]:
    out = []
    for i, m in enumerate(_TAG_RE.finditer(text or "")):
        out.append({"id": f"tag_{i}", "name": m.group(1), "arguments": m.group(2).strip()})
    return out


def strip_tool_tags(text: str) -> str:
    return _TAG_RE.sub("", text or "").strip()


class TagFilter:
    """流式隐藏 <tool ...>...</tool>：可能是标签开头的部分先扣住。"""

    def __init__(self) -> None:
        self.buf = ""
        self.inside = False

    def feed(self, s: str) -> str:
        self.buf += s
        out = []
        while self.buf:
            if self.inside:
                j = self.buf.find("</tool>")
                if j < 0:
                    self.buf = self.buf[-7:] if len(self.buf) > 7 else self.buf
                    # 扣住末尾，等结束标签
                    return "".join(out)
                self.buf = self.buf[j + 7:]
                self.inside = False
                continue
            i = self.buf.find("<tool")
            if i >= 0:
                out.append(self.buf[:i])
                self.buf = self.buf[i:]
                self.inside = True
                continue
            k = self.buf.rfind("<")
            if k >= 0 and "<tool".startswith(self.buf[k:k + 5]) and len(self.buf) - k < 5:
                out.append(self.buf[:k])
                self.buf = self.buf[k:]
                return "".join(out)
            out.append(self.buf)
            self.buf = ""
        return "".join(out)

    def flush(self) -> str:
        rest = "" if self.inside else self.buf
        self.buf = ""
        return rest


def parse_args(raw: str) -> dict:
    raw = (raw or "").strip() or "{}"
    try:
        v = json.loads(raw)
    except json.JSONDecodeError:
        s = raw
        if s.startswith("```"):
            s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s)
        s = re.sub(r",\s*([}\]])", r"\1", s)  # 尾逗号
        try:
            v = json.loads(s)
        except json.JSONDecodeError:
            m = re.search(r"\{[\s\S]*\}", s)
            if not m:
                raise
            v = json.loads(m.group(0))
    if not isinstance(v, dict):
        raise ValueError("参数不是 JSON 对象")
    return v


def brief_args(name: str, args: dict) -> str:
    def nm(x: Any) -> str:
        return str((x or {}).get("name") or (x or {}).get("ref") or "")[:20] if isinstance(x, dict) else str(x)[:20]
    if name in ("add_items", "replace_layout"):
        its = args.get("items") or []
        return f"{len(its)} 个框：" + "、".join(nm(x) for x in its[:6])
    if name == "update_items":
        return "、".join(nm(x) for x in (args.get("updates") or [])[:6])
    if name == "remove_items":
        return "、".join(str(x)[:20] for x in (args.get("refs") or [])[:6])
    if name == "set_bodies":
        return "、".join(nm(x) for x in (args.get("bodies") or [])[:6])
    if name == "set_camera":
        return " ".join(f"{k}={v}" for k, v in args.items())[:80]
    if name in ("create_page", "switch_page", "view_page"):
        return str(args.get("name") or args.get("page") or "")[:30]
    if name == "ask_user":
        return str(args.get("question") or "")[:40]
    return ""


TOOL_LABELS = {
    "update_summary": "改整体描述", "add_items": "新增框", "update_items": "修改框", "remove_items": "删除框",
    "reorder_items": "调整图层", "replace_layout": "写入布局", "set_canvas_size": "改画布尺寸",
    "set_camera": "调整机位", "set_bodies": "估算体块", "set_caption": "写 Caption", "create_page": "新建页面",
    "switch_page": "切换页面", "view_page": "查看页面", "ask_user": "提问",
}
