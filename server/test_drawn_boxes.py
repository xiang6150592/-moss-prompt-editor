"""画框必须进入增强请求，并且生成结果锁回用户坐标。"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main as m  # noqa: E402


W, H = 1536, 1024

BOXES = [
    {
        "id": "b1",
        "label": "character",
        "name": "主角",
        "caption": "区域 1",
        "depth": "fg",
        "bbox": [100, 80, 400, 500],
        "color": 0,
    },
    {
        "id": "b2",
        "label": "object",
        "name": "猫",
        "caption": "一只橘猫",
        "depth": "mg",
        "bbox": [900, 200, 1400, 900],
        "tags": ["特写"],
    },
    {
        "id": "b3",
        "label": "text",
        "name": "标语",
        "caption": "店招",
        "text": "MOSS",
        "hidden": True,
        "bbox": [200, 20, 600, 80],
    },
]

PERSPECTIVE = {
    "enabled": True,
    "mode": 2,
    "horizon_y": 420,
    "vp1_x": 400,
    "vp2_x": 1800,
    "vp3_x": 768,
    "vp3_y": 2400,
    "show_grid": False,
    "auto_scale": False,
    "source": "manual",
}


class DrawnBoxPromptTests(unittest.TestCase):
    def test_llm_user_prompt_contains_absolute_boxes(self):
        user, drawn = m.build_layout_enhance_user(
            "左边是人物，右边是橘猫",
            W,
            H,
            BOXES,
            PERSPECTIVE,
            "当前图层从前到后：主角；猫",
        )
        self.assertEqual(len(drawn), 3)
        self.assertIn("必须严格", user)
        self.assertIn("左上角", user)
        self.assertIn("xyxy", user)
        self.assertIn("不要换成中心坐标、归一化坐标或 yxyx", user)
        self.assertIn("一只橘猫", user)
        self.assertIn("MOSS", user)
        self.assertIn("主角", user)
        self.assertIn('"label": "character"', user)
        self.assertIn('"label": "text"', user)
        self.assertIn("两点透视", user)
        self.assertIn("420", user)
        self.assertIn("1800", user)
        self.assertNotIn("供参考，可按想法调整", user)
        self.assertNotIn("abs_centralized", user)
        spec = json.loads(user.split("画框数据（JSON，以此为准）：\n", 1)[1])
        self.assertEqual(spec["coord_space"], "abs")
        self.assertEqual(spec["origin"], "top-left")
        self.assertEqual(spec["bbox_format"], "xyxy")
        self.assertEqual(spec["canvas_width"], W)
        self.assertEqual(spec["canvas_height"], H)
        self.assertEqual(spec["boxes"][0]["bbox"], [100, 80, 400, 500])
        self.assertEqual(spec["boxes"][1]["z_order"], 1)
        self.assertEqual(spec["boxes"][2]["z_note"], "最前（遮挡更早的框）")
        self.assertEqual(spec["perspective"]["vp2"], [1800, 420])

    def test_system_prompt_locks_boxes(self):
        system = m.layout_enhance_system("BASE", W, H, True)
        self.assertIn("硬约束", system)
        self.assertIn("左上角", system)
        self.assertIn("xyxy", system)
        self.assertIn(f"{W}x{H}", system)
        soft = m.layout_enhance_system("BASE", W, H, False)
        self.assertNotIn("硬约束", soft)

    def test_hint_with_coords_is_not_optional(self):
        hint = "1. id=b1 label=object bbox=[10, 20, 30, 40] 必须严格保持"
        user, drawn = m.build_layout_enhance_user("想法", W, H, None, None, hint)
        self.assertEqual(drawn, [])
        self.assertIn("bbox=[10, 20, 30, 40]", user)
        self.assertIn("必须严格遵守", user)
        self.assertNotIn("供参考，可按想法调整", user)

    def test_without_boxes_hint_stays_advisory(self):
        user, drawn = m.build_layout_enhance_user("想法", W, H, [], None, "透视：一点透视")
        self.assertEqual(drawn, [])
        self.assertIn("供参考，可按想法调整", user)
        self.assertIn("一点透视", user)

    def test_pin_restores_geometry_labels_and_notes(self):
        draft = {
            "width": 512,
            "height": 512,
            "bbox_coord_space": "abs",
            "bbox_format": "xyxy",
            "summary": {"caption": "A sunny street."},
            "items": [
                {"label": "object", "caption": "A mountain covering everything", "bbox": [0, 0, 10, 10]},
                {"label": "object", "caption": "An orange cat on the right", "bbox": [1, 1, 2, 2]},
            ],
        }
        pinned = m.pin_drawn_boxes(draft, BOXES, W, H)
        self.assertEqual([it["bbox"] for it in pinned["items"]], [
            [100, 80, 400, 500],
            [900, 200, 1400, 900],
            [200, 20, 600, 80],
        ])
        self.assertEqual(pinned["items"][0]["label"], "character")
        self.assertEqual(pinned["items"][0]["name"], "主角")
        self.assertEqual(pinned["items"][0]["caption"], "A mountain covering everything")
        self.assertEqual(pinned["items"][1]["label"], "object")
        self.assertIn("一只橘猫", pinned["items"][1]["caption"])
        self.assertIn("An orange cat on the right", pinned["items"][1]["caption"])
        self.assertEqual(pinned["items"][1]["tags"], ["特写"])
        self.assertEqual(pinned["items"][2]["caption"], "店招")
        self.assertEqual(pinned["items"][2]["text"], "MOSS")
        self.assertTrue(pinned["items"][2]["hidden"])
        self.assertEqual(pinned["width"], W)
        self.assertEqual(pinned["bbox_format"], "xyxy")

    def test_pin_matches_reordered_ids(self):
        draft = {
            "summary": {"caption": "scene"},
            "items": [
                {"id": "b2", "label": "object", "caption": "cat caption", "bbox": [0, 0, 8, 8]},
                {"id": "b1", "label": "object", "caption": "hero caption", "bbox": [9, 9, 12, 12]},
            ],
        }
        boxes = [BOXES[0], BOXES[1]]
        pinned = m.pin_drawn_boxes(draft, boxes, W, H)
        self.assertEqual(pinned["items"][0]["id"], "b1")
        self.assertEqual(pinned["items"][0]["bbox"], [100, 80, 400, 500])
        self.assertEqual(pinned["items"][0]["caption"], "hero caption")
        self.assertEqual(pinned["items"][1]["id"], "b2")
        self.assertEqual(pinned["items"][1]["bbox"], [900, 200, 1400, 900])
        self.assertIn("一只橘猫", pinned["items"][1]["caption"])
        self.assertIn("cat caption", pinned["items"][1]["caption"])

    def test_clamp_keeps_edge_box_inside_canvas(self):
        raw = [{"label": "object", "caption": "边", "bbox": [-20, -10, 9999, 40]}]
        drawn = m._coerce_drawn_boxes(raw, W, H)
        self.assertEqual(drawn[0]["bbox"], [0, 0, W, 40])

    def test_fallback_keeps_user_boxes(self):
        draft = m._layout_from_drawn_boxes("夏日街道", W, H, m._coerce_drawn_boxes(BOXES, W, H))
        self.assertEqual(draft["items"][0]["bbox"], [100, 80, 400, 500])
        self.assertEqual(draft["items"][1]["bbox"], [900, 200, 1400, 900])
        self.assertNotEqual(draft["items"][0]["bbox"], [W // 8, H // 8, W * 7 // 8, H * 7 // 8])
        self.assertEqual(draft["summary"]["caption"], "夏日街道")
        self.assertEqual(draft["items"][2]["text"], "MOSS")


class EnhanceApiTests(unittest.TestCase):
    def setUp(self):
        self._settings = m.load_settings
        self._chat = m._chat
        self.captured: list = []

    def tearDown(self):
        m.load_settings = self._settings
        m._chat = self._chat

    def test_enhance_sends_boxes_and_pins_model_output(self):
        def settings():
            return {"api_key": "sk-test", "base_url": "http://127.0.0.1:9", "model": "test-model"}

        async def chat(messages, **kwargs):
            self.captured.append(messages)
            return json.dumps(
                {
                    "summary": {"caption": "A sunny street with a hero and a cat."},
                    "items": [
                        {
                            "label": "object",
                            "caption": "A mountain covering everything",
                            "bbox": [0, 0, 10, 10],
                        },
                        {
                            "label": "text",
                            "caption": "Some other sign",
                            "text": "NO",
                            "bbox": [1, 1, 2, 2],
                        },
                    ],
                },
                ensure_ascii=False,
            )

        m.load_settings = settings
        m._chat = chat
        from fastapi.testclient import TestClient

        client = TestClient(m.app)
        res = client.post(
            "/api/enhance",
            json={
                "idea": "左边人物，右边橘猫",
                "mode": "layout",
                "width": W,
                "height": H,
                "boxes": BOXES,
                "perspective": PERSPECTIVE,
                "context_hint": "旧提示：供参考，可按想法调整",
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertFalse(body["degraded"])
        items = body["draft"]["items"]
        self.assertEqual([it["bbox"] for it in items], [
            [100, 80, 400, 500],
            [900, 200, 1400, 900],
            [200, 20, 600, 80],
        ])
        self.assertEqual(items[0]["label"], "character")
        self.assertEqual(items[2]["text"], "MOSS")
        self.assertEqual(len(self.captured), 1)
        system = self.captured[0][0]["content"]
        user = self.captured[0][-1]["content"]
        self.assertIn("硬约束", system)
        self.assertIn("一只橘猫", user)
        self.assertIn("MOSS", user)
        self.assertNotIn("供参考，可按想法调整", user)
        spec = json.loads(user.split("画框数据（JSON，以此为准）：\n", 1)[1])
        self.assertEqual(spec["boxes"][0]["bbox"], [100, 80, 400, 500])
        self.assertEqual(spec["boxes"][1]["bbox"], [900, 200, 1400, 900])
        self.assertEqual(spec["origin"], "top-left")
        self.assertEqual(spec["bbox_format"], "xyxy")
        compiled = json.loads(body["prompt"])
        self.assertEqual(compiled["bbox_coord_space"], "abs_centralized")
        self.assertEqual(compiled["bbox_format"], "yxyx")
        # 隐藏框不进编译结果；可见框必须是用户坐标经官方变换后的值，而不是模型乱给的小框。
        self.assertEqual(compiled["items"][0]["bbox"], [-432, -668, -12, -368])
        self.assertEqual(compiled["items"][1]["bbox"], [-312, 132, 388, 632])
        self.assertNotIn([1, 1, 2, 2], [it["bbox"] for it in compiled["items"]])

    def test_enhance_without_key_keeps_drawn_boxes(self):
        m.load_settings = lambda: {"api_key": "", "base_url": "http://127.0.0.1:9", "model": "test-model"}

        async def chat(messages, **kwargs):
            raise AssertionError("无 Key 时不应请求 LLM")

        m._chat = chat
        from fastapi.testclient import TestClient

        client = TestClient(m.app)
        res = client.post(
            "/api/enhance",
            json={
                "idea": "夏日街道",
                "mode": "layout",
                "width": W,
                "height": H,
                "boxes": BOXES,
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertTrue(body["degraded"])
        self.assertEqual([it["bbox"] for it in body["draft"]["items"]], [
            [100, 80, 400, 500],
            [900, 200, 1400, 900],
            [200, 20, 600, 80],
        ])
        compiled = json.loads(body["prompt"])
        self.assertEqual(compiled["items"][0]["bbox"], [-432, -668, -12, -368])
        self.assertEqual(compiled["items"][1]["bbox"], [-312, 132, 388, 632])


if __name__ == "__main__":
    unittest.main()
