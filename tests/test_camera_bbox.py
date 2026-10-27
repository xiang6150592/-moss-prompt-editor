"""摄像机 / 3D 实体：bbox 是初始机位下的前脸，超出画布不算错；Agent 不能把投影框抄回 bbox。"""
import copy

import pytest

from server import db
from server.layout_core import compile_checks, compile_safe
from server.ops import Workbench

CAM = {"enabled": True, "orbit": 0, "pitch": 78, "roll": 0, "distance": 1.15, "fov": 50, "pan_x": 0, "pan_y": 0, "pan_z": 0}


def _layout():
    return {
        "width": 1024, "height": 1536, "bbox_coord_space": "abs", "bbox_format": "xyxy",
        "summary": {"caption": "黄昏的街道，俯视"}, "camera": dict(CAM),
        "items": [
            {"id": "road", "label": "object", "name": "马路", "caption": "asphalt road", "bbox": [0, 0, 1024, 1536],
             "body": {"z": 1, "thickness": 0, "yaw": 0, "anchor": "backdrop"}},
            {"id": "girl", "label": "character", "name": "荧", "caption": "a girl", "bbox": [-120, 900, 300, 1700],
             "body": {"z": 1.3, "thickness": 0.4, "yaw": 0, "anchor": "world", "exact": True}},
        ],
    }


VIEW = {"items": {"road": {"bbox": [0, 0, 1024, 1536], "visible": True},
                  "girl": {"bbox": [380, 610, 560, 820], "visible": True}},
        "order": ["road", "girl"]}


def test_out_of_canvas_front_face_is_not_an_error():
    L = _layout()
    assert not [p for p in compile_checks(L) if "编译报错" in p]
    assert not [p for p in compile_checks(L, VIEW) if "编译报错" in p]
    prompt, err = compile_safe(L)
    assert err is None and prompt
    # 完全在画布外的框（没视图时）不编译，也不报错
    L2 = _layout()
    L2["items"][1]["bbox"] = [-900, -900, -500, -400]
    assert compile_safe(L2)[1] is None


@pytest.fixture(scope="module")
def series():
    db.init()
    return db.create_series("体块坐标测试")


def _wb(series):
    page = db.create_page(series["id"], "p", {"kind": "layout", "layout": _layout(), "caption": {"caption": ""}})
    wb = Workbench(series["id"], page["id"])
    wb.views[page["id"]] = copy.deepcopy(VIEW["items"])
    return wb


def test_agent_cannot_copy_view_bbox_into_3d_body(series):
    wb = _wb(series)
    out = wb.run("update_items", {"updates": [{"ref": "girl", "bbox": [380, 610, 560, 820], "caption": "a girl, top view"}]})
    girl = next(it for it in wb.layout()["items"] if it["id"] == "girl")
    assert girl["bbox"] == [-120, 900, 300, 1700]
    assert girl["caption"] == "a girl, top view"
    assert "位置未改" in out


def test_agent_move_keeps_out_of_canvas_coords(series):
    wb = _wb(series)
    wb.run("update_items", {"updates": [{"ref": "girl", "bbox": [-80, 900, 340, 1700]}]})
    girl = next(it for it in wb.layout()["items"] if it["id"] == "girl")
    assert girl["bbox"] == [-80, 900, 340, 1700]  # 3D 体块允许在画布外，不再被裁成画布内的框
    # 普通 2D 框（摄像机关）照旧裁到画布内
    wb.layout()["camera"]["enabled"] = False
    wb.layout()["items"][1]["body"].pop("exact")
    wb.run("update_items", {"updates": [{"ref": "girl", "bbox": [-80, 900, 340, 1700]}]})
    girl = next(it for it in wb.layout()["items"] if it["id"] == "girl")
    assert girl["bbox"][0] == 0 and girl["bbox"][3] == 1536
