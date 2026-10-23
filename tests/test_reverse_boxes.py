from server.reverse_boxes import box_format_for, items_to_draft, normalize_reverse, parse_box


def approx(a, b, tol=1e-3):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def test_box_2d_is_yx_order():
    assert approx(parse_box({"box_2d": [100, 200, 500, 800]}, 1000, 800), [0.2, 0.1, 0.8, 0.5])


def test_box_1000_xy_and_swapped_corners():
    assert approx(parse_box({"box_1000": [800, 500, 200, 100]}, None, None), [0.2, 0.1, 0.8, 0.5])


def test_unit_and_pixel_coordinates():
    assert approx(parse_box({"bbox": [0.1, 0.2, 0.3, 0.4]}, 640, 480), [0.1, 0.2, 0.3, 0.4])
    # 超过 1000 → 按原图像素换算
    assert approx(parse_box({"bbox": [192, 108, 1920, 1080]}, 1920, 1080), [0.1, 0.1, 1.0, 1.0])
    # dict 形式
    assert approx(parse_box({"box": {"xmin": 100, "ymin": 100, "xmax": 600, "ymax": 900}}, None, None), [0.1, 0.1, 0.6, 0.9])


def test_invalid_boxes_dropped():
    assert parse_box({"box_2d": [1, 2, 3]}, 100, 100) is None
    assert parse_box({"box_2d": ["a", 0, 10, 10]}, 100, 100) is None
    assert parse_box({"box_1000": [500, 500, 501, 501]}, 100, 100) is None
    assert parse_box({"caption": "x"}, 100, 100) is None


def test_normalize_and_draft():
    r = normalize_reverse({
        "summary": {"caption": "A girl and a cat.", "canvas": "weird"},
        "items": [
            {"label": "character", "name": "女孩", "caption": "a girl", "box_2d": [100, 250, 950, 650]},
            {"label": "text", "caption": "sign", "text": "OPEN", "box_1000": [50, 50, 300, 150]},
            {"label": "robot", "caption": "?", "box_2d": [0, 0, 10]},
        ],
    }, 1000, 1500)
    assert r["dropped"] == 1
    assert r["summary"]["canvas"] == "single"
    assert [i["label"] for i in r["items"]] == ["character", "text"]
    assert r["items"][1]["text"] == "OPEN"
    d = items_to_draft(r, 1024, 1536)
    assert d["items"][0]["bbox"] == [256, 154, 666, 1459]
    assert d["items"][0]["name"] == "女孩"


def test_format_by_model():
    assert box_format_for("gemini-2.5-pro") == "box_2d"
    assert box_format_for("gpt-4o") == "box_1000"
