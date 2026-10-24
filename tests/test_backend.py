"""后端测试：数据库、编译、相机投影编译、Agent 流式工具循环（模拟上游）。"""

import json

import pytest
from fastapi.testclient import TestClient

from server import agent, db, llm
from server.agent_tools import TagFilter, parse_tool_tags
from server.config import save_settings, load_settings
from server.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _sample_layout():
    return {
        "width": 1024, "height": 1536, "bbox_coord_space": "abs", "bbox_format": "xyxy",
        "summary": {"caption": "A girl stands on a rooftop at dusk.", "canvas": "single"},
        "items": [
            {"id": "b1", "name": "女孩", "label": "character", "caption": "a girl in a red coat",
             "bbox": [300, 500, 700, 1400]},
            {"id": "b2", "name": "标题", "label": "text", "caption": "white title", "text": "黄昏",
             "bbox": [100, 80, 900, 260]},
        ],
    }


def test_workspace_and_pages(client):
    ws = client.get("/api/workspace").json()
    assert ws["series"], "应自动建默认系列"
    s = ws["series"][0]
    pid = s["pages"][0]["id"]
    doc = {"kind": "layout", "layout": _sample_layout(), "caption": {"caption": ""}}
    r = client.put(f"/api/pages/{pid}", json={"doc": doc, "revision": {"source": "manual", "summary": "测试"}})
    assert r.status_code == 200
    assert r.json()["doc"]["layout"]["items"][0]["name"] == "女孩"
    revs = client.get(f"/api/pages/{pid}/revisions").json()
    assert revs and revs[0]["summary"] == "测试"
    r2 = client.post(f"/api/revisions/{revs[0]['id']}/restore").json()
    assert r2["doc"]["layout"]["items"] == []
    client.put(f"/api/pages/{pid}", json={"doc": doc})
    np = client.post("/api/pages", json={"series_id": s["id"]}).json()
    assert np["name"].startswith("第")
    assert client.delete(f"/api/pages/{np['id']}").json()["ok"]


def test_compile_plain_and_camera(client):
    lay = _sample_layout()
    r = client.post("/api/compile", json={"draft": lay})
    assert r.status_code == 200, r.text
    assert "黄昏" in r.json()["prompt"]
    lay["camera"] = {"enabled": True, "orbit": 35, "pitch": -20, "roll": 0, "distance": 1.4, "fov": 50,
                     "pan_x": 0, "pan_y": 0, "pan_z": 0}
    view = {"items": {"b1": {"bbox": [350, 600, 650, 1300], "visible": True},
                      "b2": {"bbox": [100, 80, 900, 260], "visible": True}}, "order": ["b1", "b2"]}
    r = client.post("/api/compile", json={"draft": lay, "view": view})
    assert r.status_code == 200, r.text
    p = r.json()["prompt"]
    assert "350" in p or "0.34" in p or "low" in p.lower() or "仰" in p or "angle" in p.lower(), p


def test_group_kept_and_stripped(client):
    """成组：草稿 / Agent 继承里保留，编译时剥离；机位保留 4 位小数。"""
    from server.layout_core import sanitize_camera, sanitize_draft
    from server.ops import compact_item, inherit_meta
    lay = _sample_layout()
    lay["items"][0]["group"] = "g1"
    lay["items"].append({"id": "b3", "name": "步枪", "label": "object", "caption": "a rifle",
                         "bbox": [320, 900, 690, 980], "group": "g1"})
    clean = sanitize_draft(lay)
    assert [it.get("group") for it in clean["items"]] == ["g1", None, "g1"]
    r = client.post("/api/compile", json={"draft": lay})
    assert r.status_code == 200, r.text
    p = r.json()["prompt"]
    assert "g1" not in p and '"group"' not in p
    fresh = [{"name": "步枪", "label": "object", "caption": "a black rifle", "bbox": [330, 900, 700, 980]}]
    inherit_meta(lay["items"], fresh)
    assert fresh[0]["group"] == "g1" and fresh[0]["id"] == "b3"
    assert compact_item(lay["items"][2], 2)["group"] == "g1"
    assert sanitize_camera({"enabled": True, "pan_x": 0.123456})["pan_x"] == 0.1235


def test_settings_never_leak_key(client):
    client.put("/api/settings", json={"api_key": "sk-secret-123", "model": "m1"})
    pub = client.get("/api/settings").json()
    assert pub["api_key"] == "" and pub["api_key_set"] is True
    client.put("/api/settings", json={"clear_api_key": True})
    assert client.get("/api/settings").json()["api_key_set"] is False


def test_tag_filter_hides_tool_blocks():
    f = TagFilter()
    out = ""
    for ch in ['好的，', '我来改。<to', 'ol name="update_items">{"updates":', '[]}</tool>', '完成']:
        out += f.feed(ch)
    out += f.flush()
    assert "<tool" not in out and "完成" in out
    calls = parse_tool_tags('前<tool name="remove_items">{"refs":["b1"]}</tool>后')
    assert calls and calls[0]["name"] == "remove_items"


def _fake_stream(script):
    """script: 每一步 (文本, [(name, args)])"""
    state = {"i": 0}

    async def fake(messages, *, tools=None, model=None, temperature=None, max_tokens=8192):
        i = state["i"]
        state["i"] += 1
        text, calls = script[min(i, len(script) - 1)]
        yield ("model", "fake-model")
        for ch in text:
            yield ("text", ch)
        tcs = []
        for k, (name, args) in enumerate(calls):
            yield ("tool_delta", {"index": k, "name": name})
            tcs.append({"id": f"c{i}_{k}", "name": name, "arguments": json.dumps(args, ensure_ascii=False)})
        yield ("done", {"content": text, "tool_calls": tcs, "finish_reason": "tool_calls" if tcs else "stop"})

    return fake


def _events(resp_text):
    out = []
    for block in resp_text.split("\n\n"):
        for line in block.splitlines():
            if line.startswith("data:"):
                out.append(json.loads(line[5:].strip()))
    return out


def test_agent_tool_loop_and_proposal(client, monkeypatch):
    s = load_settings()
    s["api_key"] = "sk-test"
    save_settings(s)
    monkeypatch.setattr(agent, "maybe_summarize", lambda sid: _noop())
    script = [
        ("我把女孩挪到左边，并加一只猫。", [
            ("update_items", {"updates": [{"ref": "女孩", "bbox": [100, 500, 500, 1400]}]}),
            ("add_items", {"items": [{"name": "猫", "label": "object", "caption": "a black cat",
                                      "bbox": [600, 1200, 900, 1450]}]}),
        ]),
        ("改好了：女孩左移，右下加了猫。", []),
    ]
    monkeypatch.setattr(llm, "stream_chat", _fake_stream(script))
    ws = client.get("/api/workspace").json()
    series = ws["series"][0]
    page = series["pages"][0]
    sess = client.post("/api/sessions", json={"series_id": series["id"]}).json()
    doc = {"kind": "layout", "layout": _sample_layout(), "caption": {"caption": ""}}
    r = client.post(f"/api/sessions/{sess['id']}/run", json={
        "page_id": page["id"], "doc": doc, "message": "女孩放左边，再加只猫"})
    assert r.status_code == 200
    evs = _events(r.text)
    types = [e["type"] for e in evs]
    assert "user_saved" in types and "tool" in types and "proposal" in types and types[-1] == "done", types
    text = "".join(e["delta"] for e in evs if e["type"] == "text")
    assert "改好了" in text
    prop = next(e for e in evs if e["type"] == "proposal")
    names = [it.get("name") for it in prop["proposed"]["layout"]["items"]]
    assert "猫" in names
    girl = next(it for it in prop["proposed"]["layout"]["items"] if it.get("name") == "女孩")
    assert girl["bbox"][0] == 100
    # 页面在确认之前不应被改
    assert db.get_page(page["id"])["doc"]["layout"]["items"][0]["bbox"][0] == 300
    # 确认
    rr = client.post(f"/api/messages/{prop['message_id']}/proposal",
                     json={"page_id": page["id"], "status": "accepted"}).json()
    assert rr["message"]["meta"]["proposals"][0]["status"] == "accepted"
    assert any(it.get("name") == "猫" for it in rr["page"]["doc"]["layout"]["items"])
    msgs = client.get(f"/api/sessions/{sess['id']}/messages").json()
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    # 第二轮：历史里应包含上一轮的操作记录
    captured = {}

    async def spy(messages, **kw):
        captured["messages"] = messages
        yield ("model", "fake-model")
        yield ("text", "收到")
        yield ("done", {"content": "收到", "tool_calls": [], "finish_reason": "stop"})

    monkeypatch.setattr(llm, "stream_chat", spy)
    r = client.post(f"/api/sessions/{sess['id']}/run", json={
        "page_id": page["id"], "doc": rr["page"]["doc"], "message": "猫再大一点？先别改，聊聊"})
    joined = json.dumps(captured["messages"], ensure_ascii=False)
    assert "女孩放左边" in joined and "猫" in joined

    # 清空对话：消息、摘要、已读快照都没了，标题复位，页面不受影响
    before_page = db.get_page(page["id"])["doc"]
    cleared = client.post(f"/api/sessions/{sess['id']}/clear").json()
    assert cleared["title"] == "新对话" and cleared["summary"] == ""
    assert client.get(f"/api/sessions/{sess['id']}/messages").json() == []
    assert "seen" not in (db.get_session(sess["id"])["meta"] or {})
    assert db.get_page(page["id"])["doc"] == before_page
    # 清空后下一轮不再带旧对话
    r = client.post(f"/api/sessions/{sess['id']}/run", json={
        "page_id": page["id"], "doc": before_page, "message": "重新开始", "quick": "补全提示词"})
    joined = json.dumps(captured["messages"], ensure_ascii=False)
    assert "女孩放左边" not in joined
    # 快捷操作开头的对话用快捷操作名当标题
    assert next(x for x in client.get(f"/api/series/{series['id']}/sessions").json() if x["id"] == sess["id"])["title"] == "补全提示词"
    assert client.post("/api/sessions/nope/clear").status_code == 404


def test_agent_tags_fallback(client, monkeypatch):
    calls = {"n": 0}

    async def fake(messages, *, tools=None, **kw):
        calls["n"] += 1
        if tools:
            raise llm.ToolsUnsupported(400, "tools not supported")
        yield ("model", "fake")
        txt = '好的<tool name="update_summary">{"caption": "A quiet street."}</tool>'
        last = messages[-1].get("content")
        if isinstance(last, str) and last.startswith("<tool_results>"):
            txt = "已更新整体描述。"
        for ch in txt:
            yield ("text", ch)
        yield ("done", {"content": txt, "tool_calls": [], "finish_reason": "stop"})

    monkeypatch.setattr(llm, "stream_chat", fake)
    monkeypatch.setattr(agent, "maybe_summarize", lambda sid: _noop())
    ws = client.get("/api/workspace").json()
    series = ws["series"][0]
    page = series["pages"][0]
    sess = client.post("/api/sessions", json={"series_id": series["id"]}).json()
    doc = {"kind": "layout", "layout": _sample_layout(), "caption": {"caption": ""}}
    r = client.post(f"/api/sessions/{sess['id']}/run", json={"page_id": page["id"], "doc": doc, "message": "改成安静街道"})
    evs = _events(r.text)
    text = "".join(e["delta"] for e in evs if e["type"] == "text")
    assert "<tool" not in text
    assert any(e["type"] == "notice" for e in evs)
    prop = next(e for e in evs if e["type"] == "proposal")
    assert prop["proposed"]["layout"]["summary"]["caption"] == "A quiet street."


async def _noop():
    return None


def test_agent_draft_mode(client, monkeypatch):
    """AI 起稿：mode=draft 时系统提示带起稿指南，一轮写入布局 + 机位 + 灯光，生成一个待确认改动。"""
    s = load_settings()
    s["api_key"] = "sk-test"
    save_settings(s)
    monkeypatch.setattr(agent, "maybe_summarize", lambda sid: _noop())
    captured = {}
    script = [
        ("", [
            ("replace_layout", {"summary": {"caption": "A detective on a rainy neon street."}, "items": [
                {"name": "街道", "label": "object", "caption": "rainy street", "bbox": [0, 0, 1536, 1024]},
                {"name": "侦探", "label": "character", "caption": "a detective", "bbox": [200, 200, 640, 1000]}],
                "width": 1536, "height": 1024, "resize_canvas": True}),
            ("set_camera", {"pitch": -12}),
            ("set_lighting", {"preset": "neon"}),
        ]),
        ("起稿完成。", []),
    ]
    inner = _fake_stream(script)

    async def spy(messages, **kw):
        captured.setdefault("system", messages[0]["content"])
        async for x in inner(messages, **kw):
            yield x

    monkeypatch.setattr(llm, "stream_chat", spy)
    series = client.post("/api/series", json={"name": "起稿"}).json()
    page = client.get("/api/workspace").json()["series"][-1]["pages"][0]
    sess = client.post("/api/sessions", json={"series_id": series["id"]}).json()
    doc = {"kind": "layout", "layout": _sample_layout(), "caption": {"caption": ""}}
    r = client.post(f"/api/sessions/{sess['id']}/run", json={
        "page_id": page["id"], "doc": doc, "message": "【AI 起稿】雨夜侦探", "quick": "AI 起稿", "mode": "draft"})
    evs = _events(r.text)
    assert "AI 起稿" in captured["system"]
    props = [e for e in evs if e["type"] == "proposal"]
    assert len(props) == 1
    L = props[0]["proposed"]["layout"]
    assert (L["width"], L["height"]) == (1536, 1024)
    assert [it["name"] for it in L["items"]] == ["街道", "侦探"]
    assert L["camera"]["enabled"] and L["camera"]["pitch"] == -12
    assert L["lighting"]["preset"] == "neon" and L["lighting"]["enabled"]
