"""灯光：前后端短语一致、预设、Agent 工具 set_lighting、编译写入灯光。"""
import json
from pathlib import Path

import pytest

from server import db, lighting
from server.layout_core import compile_safe
from server.ops import Workbench

CASES = json.loads((Path(__file__).parent / "fixtures" / "lighting_cases.json").read_text("utf-8"))


@pytest.mark.parametrize("case", CASES["cases"], ids=[c["name"] for c in CASES["cases"]])
def test_phrase_matches_frontend(case):
    assert lighting.lighting_phrase(case["lighting"], case["camera"], True) == case["zh"]
    assert lighting.lighting_phrase(case["lighting"], case["camera"], False) == case["en"]


def _strip(lg):
    return {**lg, "lights": [{k: v for k, v in l.items() if k != "id"} for l in lg["lights"]]}


@pytest.mark.parametrize("p", CASES["presets"], ids=[p["id"] for p in CASES["presets"]])
def test_preset_matches_frontend(p):
    got = lighting.preset_lighting(p["id"], p["camera"])
    assert _strip(got) == _strip(lighting.sanitize_lighting(p["lighting"]))
    assert lighting.preset_matches(got, p["camera"])


def test_sanitize_lighting_clamps_and_drops_junk():
    lg = lighting.sanitize_lighting({"enabled": True, "ambient": 9, "extras": ["haze", "nope", "haze"],
                                     "lights": [{"role": "key", "azimuth": 400, "elevation": 200, "intensity": -1},
                                                {"role": "bogus"}, "x"]})
    assert lg["ambient"] <= 1 and lg["extras"] == ["haze"]
    k = lg["lights"][0]
    assert -180 <= k["azimuth"] <= 180 and k["elevation"] <= 90 and k["intensity"] >= 0
    assert lighting.sanitize_lighting(None) is None


def _layout(cam=None):
    L = {"width": 1024, "height": 1024, "bbox_coord_space": "abs", "bbox_format": "xyxy",
         "summary": {"caption": "A woman in a cafe."},
         "items": [{"id": "a", "name": "女人", "label": "character", "caption": "a woman", "bbox": [300, 200, 700, 1000]}],
         "prompt_options": {"lighting": True}}
    if cam:
        L["camera"] = cam
    return L


@pytest.fixture(scope="module")
def series():
    db.init()
    return db.create_series("灯光测试")


def _ops(series, L):
    page = db.create_page(series["id"], "p", {"kind": "layout", "layout": L, "caption": {"caption": ""}})
    wb = Workbench(series["id"], page["id"])
    return wb


def test_set_lighting_tool_preset_and_relative_azimuth(series):
    cam = {"enabled": True, "orbit": -40, "pitch": 10, "roll": 0, "distance": 1, "fov": 50, "pan_x": 0, "pan_y": 0, "pan_z": 0}
    ops = _ops(series, _layout(cam))
    out = ops.run("set_lighting", {"preset": "rembrandt"})
    lg = ops.layout()["lighting"]
    assert lg["enabled"] and lg["preset"] == "rembrandt" and "伦勃朗" in out
    assert lighting.preset_matches(lg, cam)
    # 工具里的方位相对当前机位：0° = 镜头正面
    ops.run("set_lighting", {"update_lights": [{"role": "key", "azimuth": 0}]})
    key = next(l for l in ops.layout()["lighting"]["lights"] if l["role"] == "key")
    assert key["azimuth"] == pytest.approx(-40)
    assert not ops.layout()["lighting"]["preset"]
    # 加灯 / 关闭；页面本身在确认前不变
    ops.run("set_lighting", {"lights": [{"role": "practical", "azimuth": 90, "elevation": 0, "color": "#ff9500"}]})
    assert any(l["role"] == "practical" for l in ops.layout()["lighting"]["lights"])
    ops.run("set_lighting", {"enabled": False})
    assert ops.layout()["lighting"]["enabled"] is False
    assert "lighting" not in db.get_page(ops.target)["doc"]["layout"]


def test_compile_writes_lighting_phrase():
    L = _layout()
    L["lighting"] = lighting.preset_lighting("neon", None)
    zh = lighting.lighting_phrase(L["lighting"], None, True)
    en = lighting.lighting_phrase(L["lighting"], None, False)
    text, err = compile_safe(L)
    assert err is None and zh and (zh in text or en in text), text
    L["prompt_options"]["lighting"] = False
    text2, err = compile_safe(L)
    assert err is None and zh not in text2 and en not in text2
