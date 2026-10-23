"""Agent 运行时：组装上下文（工作台快照 + 手动改动 + 对话记忆）、流式工具循环、待确认改动、滚动摘要。"""

from __future__ import annotations

import asyncio
import base64
import copy
import json
from typing import Any, AsyncIterator, Optional

from . import db, llm
from .agent_tools import (TOOL_LABELS, TOOLS, TagFilter, brief_args, parse_args, parse_tool_tags,
                          strip_tool_tags, tags_protocol_text)
from .config import ATTACH_DIR, load_settings
from .layout_core import _is_cjk, camera_phrase, compile_checks
from .ops import ToolError, Workbench, describe_changes, describe_doc
from .skills import load_skills

MAX_STEPS = 10

SYSTEM_BASE = """你是「MOSS 提示词工作台」的 Agent，和用户一起讨论、编写、修改 MOSS-Image 的 Layout（分区布局）和 Caption（散文）提示词。

## 工作方式
- 你能看到工作台的实时状态（每轮在 <workbench> 中给出）：当前页面、同系列其他页面、用户选中的框、用户自上次以来的手动改动。
- 修改只能通过工具完成，不要在回复里贴整段 JSON。你的改动会以「待确认改动」卡片给用户逐条采纳或驳回。
- 用户只是讨论、提问时，直接回答，不要调用修改工具。意图不明确、有多种合理方向时，用 ask_user 给选项。
- 改动尽量小：只改用户提到的或必须联动的部分。用户手动改过的地方视为用户的决定，不要改回去。
- 锁定（locked）的框只读；隐藏（hidden）的框保留不动。
- group 相同的框是用户绑定的一组（比如人物和手里的道具）：改位置或大小时整组一起改、保持组内相对位置，不要把它们拆开，也不要擅自改 group。新加人物手里的道具 / 配件时，可以把它的 group 设成和这个人物相同（人物已有组就沿用那个值，没有就给两者起一个简短的新组名，如 g1）。
- 回复用简洁的中文：先说结论，再列关键改动。不要复述整份布局，也不要把改好的整段提示词贴进回复（用户在卡片和画布上能看到）。
- 回复是普通 Markdown，不要整段包在代码块里。
- 当前页是 Layout 时，提示词只由整体描述（summary）和各框组成；除非用户明确要求写成 Caption，不要调用 set_caption。

## 坐标与图层
- 坐标是画布绝对像素，原点在左上角，x 向右、y 向下，bbox = [x1,y1,x2,y2]。坐标换算由程序完成：你可以按别的画布尺寸写（在 replace_layout 里给出 width/height），程序会等比缩放居中。
- layers_back_to_front 的顺序就是图层顺序，越靠后越靠前（离镜头越近，会遮挡前面的框）。背景在前，前景主体在后。
- 框可以重叠。文字（label=text）把要画出来的字原样写进 text。
- 引用框时用 id 或图层名（name）。新框要起简短的中文名。

## 描述写法（MOSS-Image 约定）
- summary.caption 写整张图；每个框的 caption 只写这个框里看得见的东西（外观、动作、材质、光线），不要把别的框的主体写进来。
- 默认英文（用户明确要中文时用中文）；不写坐标、不写质量堆砌词、不写看不见的过程。
- 保持用户给定的主体、数量、关系、风格和排除项。

## 摄像机与体块（3D）
- 摄像机参数：orbit 环绕（正=镜头绕到右侧）、pitch 俯仰（正=升高俯拍，负=仰拍）、roll 滚转（荷兰角）、distance 距离（<1 推近）、fov 视角（50 标准，大=广角，小=长焦）、pan 平移。
- 每个框可有 body：z 远近（1=主体平面，<1 更近）、thickness 厚度（相对框宽）、yaw 朝向、anchor（world 立体物 / screen 贴在画面上的字和贴纸 / backdrop 铺满的背景）。
- 摄像机开启时，框位由体块按机位投影得到（workbench 里的 view_bbox 是当前镜头下的框）。
- 「按视角改描述」：框位、图层、可见文字都不动，只用 update_items 改写各框 caption 和 summary.caption，使其符合当前机位（比如俯拍能看到头顶与地面、仰拍能看到下巴和帽檐底面、侧面只见一只眼）。

## 多页
- 同一系列的页面共用这场对话。用户要多个版本/方案时，用 create_page 新建页面再写；需要参照别的页时用 view_page。
"""


def _skills_block(kind: str, extra_ids: list[str]) -> str:
    store = load_skills()
    by_id = {s["id"]: s for s in store["skills"]}
    picked: list[dict] = []
    for sid in [store["active"].get(kind), store["active"].get("context"), *extra_ids]:
        s = by_id.get(sid or "")
        if s and s not in picked:
            picked.append(s)
    if not picked:
        return ""
    parts = ["## 写法参考（Skill）",
             "下面是用户启用的写法说明。只采纳其中关于内容、措辞、字段约定的部分；"
             "其中「只输出 JSON」之类的输出格式要求一律忽略——你始终通过工具修改工作台、用中文对话。"]
    for s in picked:
        parts.append(f"### {s['name']}\n{s['system_prompt'].strip()}")
    return "\n\n".join(parts)


def _turn_text(m: dict) -> str:
    meta = m.get("meta") or {}
    if m["role"] == "user":
        t = m.get("content") or ""
        if meta.get("attachments"):
            t += f"\n[附图 {len(meta['attachments'])} 张]"
        return t
    lines = [m.get("content") or ""]
    steps = meta.get("steps") or []
    if steps:
        lines.append("[执行的操作] " + "；".join(
            f"{s.get('name')}({s.get('brief', '')})→{'成功' if s.get('ok') else '失败'}" for s in steps[:12]))
    for p in meta.get("proposals") or []:
        st = {"accepted": "用户已采纳", "rejected": "用户已驳回", "partial": "用户部分采纳",
              "pending": "待用户确认"}.get(p.get("status"), p.get("status"))
        lines.append(f"[改动「{p.get('page_name')}」：{st}]")
    if meta.get("ask"):
        lines.append(f"[向用户提问] {meta['ask'].get('question')} 选项：{' / '.join(meta['ask'].get('options') or [])}")
    if meta.get("stopped"):
        lines.append("[本轮被用户中止]")
    return "\n".join(x for x in lines if x)


def _image_part(att_id: str) -> Optional[dict]:
    for p in ATTACH_DIR.glob(f"{att_id}.*"):
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
                "gif": "image/gif"}.get(p.suffix.lstrip(".").lower(), "image/png")
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
    return None


def build_messages(*, session: dict, history: list[dict], wb: Workbench, page_id: str, doc: dict,
                   view: Optional[dict], user_text: str, selection: list[str], skill_ids: list[str],
                   attachments: list[str], protocol: str) -> tuple[list[dict], list[str]]:
    s = load_settings()
    meta = session.get("meta") or {}
    kind = db.normalize_doc(doc)["kind"]
    system = SYSTEM_BASE
    sk = _skills_block(kind, skill_ids)
    if sk:
        system += "\n\n" + sk
    if protocol == "tags":
        system += "\n\n" + tags_protocol_text()
    msgs: list[dict] = [{"role": "system", "content": system}]

    upto = int(meta.get("summary_upto") or 0)
    if meta.get("summary"):
        msgs.append({"role": "user", "content": f"（更早对话的摘要，供你参考）\n{meta['summary']}"})
        msgs.append({"role": "assistant", "content": "好的，我记得这些。"})
    turns = [m for m in history if m["seq"] > upto and m["role"] in ("user", "assistant")]
    # 最近 N 轮（一轮 = 一条用户消息起）
    user_idx = [i for i, m in enumerate(turns) if m["role"] == "user"]
    keep_from = user_idx[-s["context_turns"]] if len(user_idx) > s["context_turns"] else 0
    for m in turns[keep_from:]:
        t = _turn_text(m)
        if t.strip():
            msgs.append({"role": m["role"], "content": t})

    # 工作台快照
    name = wb.names.get(page_id, page_id)
    vitems = (view or {}).get("items") if isinstance(view, dict) else None
    wsl = ["<workbench>", "当前页面（你的修改默认写在这里）：", describe_doc(doc, name, page_id, vitems)]
    nd = db.normalize_doc(doc)
    L = nd["layout"]
    cam = L.get("camera") or {}
    if nd["kind"] == "layout" and cam.get("enabled"):
        zh = _is_cjk((L.get("summary") or {}).get("caption", ""))
        ph = camera_phrase(cam, L.get("items") or [], L["width"], L["height"], zh)
        wsl.append(f"当前镜头语言（编译时会追加到整体描述）：{ph or '中性平视，无追加'}")
    others = [describe_doc(wb.base[pid], wb.names.get(pid, pid), pid, brief=True)
              for pid in wb.names if pid != page_id and pid in wb.base]
    if others:
        wsl.append("同系列其他页面：\n" + "\n".join(f"- {o}" for o in others))
    if selection:
        items = {it.get("id"): it for it in L.get("items") or []}
        sel = [f"「{items[i].get('name') or i}」(id={i})" for i in selection if i in items]
        if sel:
            wsl.append("用户当前选中：" + "、".join(sel) + "（用户说“这个/它”时通常指这些）")
    seen = (meta.get("seen") or {}).get(page_id)
    manual = describe_changes(seen, doc) if seen else []
    if manual:
        wsl.append("用户自上次对话以来的手动改动：\n" + "\n".join(f"- {x}" for x in manual[:30]))
    wsl.append("</workbench>")
    final_text = "\n".join(wsl) + "\n\n用户：" + user_text
    parts: list[dict] = []
    for a in attachments[:4]:
        p = _image_part(a)
        if p:
            parts.append(p)
    if parts:
        msgs.append({"role": "user", "content": [{"type": "text", "text": final_text}, *parts]})
    else:
        msgs.append({"role": "user", "content": final_text})
    return msgs, manual


def sse(ev: dict) -> str:
    return "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"


async def run_agent(*, session_id: str, page_id: str, doc: dict, view: Optional[dict], message: str,
                    selection: list[str], skill_ids: list[str], attachments: list[str],
                    replace_from_seq: Optional[int], quick: Optional[str]) -> AsyncIterator[str]:
    session = db.get_session(session_id)
    if not session:
        yield sse({"type": "error", "message": "会话不存在"})
        return
    page = db.get_page(page_id)
    if not page:
        yield sse({"type": "error", "message": "页面不存在"})
        return
    s = load_settings()
    if not (s.get("api_key") or "").strip():
        yield sse({"type": "error", "message": "未配置 API Key：请先在「设置」里填写接口地址和密钥。画框、编辑与编译不受影响。"})
        return

    if replace_from_seq:
        db.delete_messages_from(session_id, int(replace_from_seq))
    history = db.list_messages(session_id)
    # 用户消息先落库：中途断开也不丢
    umsg = db.add_message(session_id, "user", message, {
        "page_id": page_id, "selection": selection, "skill_ids": skill_ids,
        "attachments": attachments, "quick": quick})
    if not history and session.get("title") in ("新对话", "", None):
        title = (quick or "").strip() or (message.strip().splitlines() or ["对话"])[0]
        db.update_session(session_id, title=title[:24])
    yield sse({"type": "user_saved", "message": umsg})

    # 当前文档以客户端为准（可能还没自动保存）
    db.update_page(page_id, doc=doc)
    wb = Workbench(session["series_id"], page_id)
    wb.set_current_doc(page_id, doc)
    meta = dict(session.get("meta") or {})
    protocol = meta.get("protocol") or ("tags" if s["agent_protocol"] == "tags" else "tools")
    msgs, _manual = build_messages(session=session, history=history, wb=wb, page_id=page_id, doc=doc, view=view,
                                   user_text=message, selection=selection, skill_ids=skill_ids,
                                   attachments=attachments, protocol=protocol)
    meta.setdefault("seen", {})[page_id] = copy.deepcopy(doc)

    visible: list[str] = []
    steps: list[dict] = []
    model_used = ""
    error: Optional[str] = None
    stopped = True
    repaired = False
    try:
        step = 0
        while step < MAX_STEPS:
            step += 1
            filt = TagFilter() if protocol == "tags" else None
            done: dict = {}
            try:
                async for kind, val in llm.stream_chat(msgs, tools=TOOLS if protocol == "tools" else None):
                    if kind == "model":
                        if val != model_used:
                            model_used = val
                            yield sse({"type": "model", "model": val})
                    elif kind == "text":
                        out = filt.feed(val) if filt else val
                        if out:
                            visible.append(out)
                            yield sse({"type": "text", "delta": out})
                    elif kind == "tool_delta":
                        yield sse({"type": "tool_pending", "name": val["name"],
                                   "label": TOOL_LABELS.get(val["name"], val["name"])})
                    elif kind == "done":
                        done = val
            except llm.ToolsUnsupported:
                if s["agent_protocol"] == "auto" and protocol == "tools":
                    protocol = "tags"
                    meta["protocol"] = "tags"
                    msgs[0]["content"] += "\n\n" + tags_protocol_text()
                    yield sse({"type": "notice", "message": "当前接口不支持函数调用，已切换到标签协议"})
                    step -= 1
                    continue
                raise
            if filt:
                tail = filt.flush()
                if tail:
                    visible.append(tail)
                    yield sse({"type": "text", "delta": tail})
            content = done.get("content") or ""
            calls = done.get("tool_calls") or []
            if protocol == "tags":
                calls = parse_tool_tags(content)
            if not calls:
                changed = wb.changed_pages()
                if changed and not repaired:
                    probs = []
                    for pid in changed:
                        d = wb.working[pid]
                        target = d["layout"] if d["kind"] == "layout" else d["caption"]
                        for p in compile_checks(target):
                            probs.append(f"「{wb.names.get(pid, pid)}」{p}")
                    if probs:
                        repaired = True
                        yield sse({"type": "notice", "message": "自检发现问题，正在修正：" + "；".join(probs[:4])})
                        msgs.append({"role": "assistant", "content": content or "（已完成修改）"})
                        msgs.append({"role": "user", "content": "系统自检发现这些问题，请直接用工具修正，修完用一句话说明：\n- "
                                     + "\n- ".join(probs[:12])})
                        visible.append("\n\n")
                        continue
                break
            # 执行工具
            if protocol == "tools":
                msgs.append({"role": "assistant", "content": content or None, "tool_calls": [
                    {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
                    for c in calls]})
            else:
                msgs.append({"role": "assistant", "content": content})
            results = []
            asked = False
            for c in calls:
                name = c["name"]
                try:
                    args = parse_args(c["arguments"])
                except (ValueError, json.JSONDecodeError) as e:
                    args, res, ok = {}, f"参数解析失败：{e}。请输出合法 JSON 再调用一次。", False
                else:
                    if name == "ask_user":
                        opts = [str(o)[:60] for o in (args.get("options") or []) if str(o).strip()][:6]
                        wb.ask = {"question": str(args.get("question") or "")[:300], "options": opts,
                                  "multi": bool(args.get("multi"))}
                        res, ok, asked = "已向用户提问，等待回答。", True, True
                        yield sse({"type": "ask", **wb.ask})
                    else:
                        try:
                            res, ok = wb.run(name, args), True
                        except ToolError as e:
                            res, ok = f"失败：{e}", False
                        except Exception as e:  # noqa: BLE001 — 工具异常回给模型
                            res, ok = f"失败：{type(e).__name__}: {e}", False
                for pg in wb.created:
                    if not any(x.get("page_id") == pg["id"] for x in steps if x.get("created")):
                        yield sse({"type": "page_created", "page": pg})
                        steps.append({"name": "create_page", "brief": pg["name"], "ok": True, "created": True,
                                      "page_id": pg["id"], "result": ""})
                if name != "create_page":
                    st = {"name": name, "label": TOOL_LABELS.get(name, name), "brief": brief_args(name, args),
                          "ok": ok, "result": res[:400]}
                    steps.append(st)
                    yield sse({"type": "tool", **st})
                results.append((c, res))
            if protocol == "tools":
                for c, res in results:
                    msgs.append({"role": "tool", "tool_call_id": c["id"], "content": res})
            else:
                msgs.append({"role": "user", "content": "<tool_results>\n" + "\n".join(
                    f"{c['name']}: {res}" for c, res in results) + "\n</tool_results>"})
            if asked:
                break
        stopped = False
    except llm.UpstreamError as e:
        error = str(e)
        stopped = False
    except asyncio.CancelledError:
        stopped = True
        raise
    except Exception as e:  # noqa: BLE001
        error = f"{type(e).__name__}: {e}"
        stopped = False
    finally:
        proposals = []
        for pid in wb.changed_pages():
            base, prop = wb.base[pid], wb.working[pid]
            proposals.append({"page_id": pid, "page_name": wb.names.get(pid, pid), "base": base,
                              "proposed": prop, "summary": describe_changes(base, prop), "status": "pending"})
            meta["seen"][pid] = copy.deepcopy(prop)
        text = strip_tool_tags("".join(visible)).strip()
        if not text and proposals:
            text = "已提交改动，请在下方确认。"
        if error and not text:
            text = ""
        amsg = db.add_message(session_id, "assistant", text, {
            "steps": steps, "proposals": proposals, "ask": wb.ask, "model": model_used,
            "error": error, "stopped": stopped, "page_id": page_id})
        fresh = db.get_session(session_id) or session
        fmeta = dict(fresh.get("meta") or {})
        fmeta["seen"] = {**(fmeta.get("seen") or {}), **meta["seen"]}
        if meta.get("protocol"):
            fmeta["protocol"] = meta["protocol"]
        db.update_session(session_id, meta=fmeta)
        if not stopped:
            for p in proposals:
                yield sse({"type": "proposal", "message_id": amsg["id"], **p})
            if error:
                yield sse({"type": "error", "message": error})
            yield sse({"type": "done", "message": amsg})
            asyncio.get_event_loop().create_task(maybe_summarize(session_id))


async def maybe_summarize(session_id: str) -> None:
    """对话超出保留轮数时，把更早的轮次压成摘要（失败就算了，下次再试）。"""
    try:
        s = load_settings()
        sess = db.get_session(session_id)
        if not sess:
            return
        meta = dict(sess.get("meta") or {})
        upto = int(meta.get("summary_upto") or 0)
        msgs = [m for m in db.list_messages(session_id) if m["seq"] > upto]
        users = [m for m in msgs if m["role"] == "user"]
        keep = s["context_turns"]
        if len(users) <= keep + 4:
            return
        cut_seq = users[-keep]["seq"]
        old = [m for m in msgs if m["seq"] < cut_seq]
        transcript = "\n".join(f"{'用户' if m['role'] == 'user' else 'Agent'}：{_turn_text(m)[:600]}" for m in old)
        prev = meta.get("summary") or ""
        prompt = ("把下面这段提示词工作台的对话压缩成要点摘要（中文，≤400 字），保留：用户的目标与偏好、"
                  "已确定的构图/风格/文字、被否决的方向、还没解决的问题。只输出摘要。\n\n"
                  + (f"已有摘要：\n{prev}\n\n" if prev else "") + f"新对话：\n{transcript}")
        out = await llm.chat([{"role": "user", "content": prompt}], max_tokens=900, temperature=0.3)
        meta["summary"] = out.strip()[:2000]
        meta["summary_upto"] = cut_seq - 1
        latest = db.get_session(session_id) or sess
        lm = dict(latest.get("meta") or {})
        lm.update({"summary": meta["summary"], "summary_upto": meta["summary_upto"]})
        db.update_session(session_id, meta=lm)
    except Exception:  # noqa: BLE001
        return
