"""桌面壳：后台线程跑内嵌 FastAPI，前台用 pywebview（Windows 上是 WebView2）开原生窗口。

运行：  python -m desktop            （源码）
        MOSS-Prompt-Studio.exe       （PyInstaller 打包后）
参数：  --browser   不开原生窗口，改用系统浏览器
        --port N    固定端口（默认随机空闲端口）
        --debug     打开 WebView 开发者工具
"""

from __future__ import annotations

import argparse
import logging
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

def _log_dir() -> Path:
    """pythonw / 无控制台打包时没有 stdout，日志写到项目 data/，不要写到解释器目录。"""
    env = os.environ.get("MOSS_DATA_DIR")
    if env:
        return Path(env).expanduser()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "data"
    return Path(__file__).resolve().parent.parent / "data"


# 打包后 stdout/stderr 可能是 None（pythonw / --noconsole），uvicorn 写日志会崩
if sys.stdout is None or sys.stderr is None:
    _log_path = _log_dir()
    _log_path.mkdir(parents=True, exist_ok=True)
    _f = open(_log_path / "app.log", "a", encoding="utf-8", buffering=1)  # noqa: SIM115
    sys.stdout = sys.stdout or _f
    sys.stderr = sys.stderr or _f

TITLE = "MOSS 提示词工作台"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(port: int) -> threading.Thread:
    import uvicorn

    from server.main import app

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False,
                            log_config=None)
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, name="moss-server", daemon=True)
    t.start()
    return t


def wait_ready(url: str, timeout: float = 20.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url + "/api/health", timeout=1.5) as r:
                if r.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            time.sleep(0.15)
    return False


SPLASH_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#E7E3DC;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#5b5247}
.c{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
.m{width:46px;height:46px;border-radius:12px;background:linear-gradient(#5b8def,#3d6fd6);color:#fff;font:700 22px/46px sans-serif;text-align:center;
box-shadow:0 2px 0 rgba(255,255,255,.4) inset,0 6px 16px rgba(40,60,120,.25)}
.b{width:160px;height:4px;border-radius:2px;background:rgba(0,0,0,.08);overflow:hidden}
.b i{display:block;width:40%;height:100%;background:#d9822b;border-radius:2px;animation:a 1.1s ease-in-out infinite}
@keyframes a{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
</style></head><body><div class="c"><div class="m">M</div><div>正在启动 MOSS Prompt Studio…</div><div class="b"><i></i></div></div></body></html>"""

ERROR_HTML = """<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:'Microsoft YaHei',sans-serif;background:#E7E3DC;color:#5b5247;padding:40px">
<h3>本地服务没有启动成功</h3><p>请关闭窗口，用 start-debug.bat 启动查看报错；日志在 data\\app.log。</p></body></html>"""


class JsApi:
    """暴露给前端的少量原生能力（window.pywebview.api.*）。"""

    def __init__(self) -> None:
        # 必须是私有属性。pywebview 启动时会递归扫描 js_api 的每个公开属性；
        # 把 Window 挂在 self.window 上会钻进 WinForms 的
        # native.AccessibilityObject.Bounds.Empty，递归爆栈并把界面卡死。
        self._window = None
        self._dirty = False      # 前端是否有还没写进数据库的改动
        self._quit_ok = False    # 已经存完，允许真正关闭
        self._closing = False    # 正在“先保存再关闭”

    # ---- 前端调用 ----
    def set_dirty(self, dirty: bool) -> bool:
        self._dirty = bool(dirty)
        return True

    def open_external(self, url: str) -> bool:
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            webbrowser.open(url)
            return True
        return False

    def data_dir(self) -> str:
        from server.config import DATA

        return str(DATA)

    def open_data_dir(self) -> bool:
        from server.config import DATA

        try:
            if sys.platform.startswith("win"):
                os.startfile(str(DATA))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                os.system(f'open "{DATA}"')
            else:
                os.system(f'xdg-open "{DATA}" >/dev/null 2>&1 &')
            return True
        except Exception:  # noqa: BLE001
            return False

    def toggle_fullscreen(self) -> bool:
        if self._window is None:
            return False
        self._window.toggle_fullscreen()
        return True

    def _save_dialog(self, filename: str) -> str:
        import webview

        if self._window is None:
            return ""
        kind = webview.FileDialog.SAVE if hasattr(webview, "FileDialog") else webview.SAVE_DIALOG
        res = self._window.create_file_dialog(kind, save_filename=filename)
        if not res:
            return ""
        return res if isinstance(res, str) else res[0]

    def save_text(self, filename: str, content: str) -> str:
        """原生“另存为”对话框，返回保存路径（取消则为空）。"""
        path = self._save_dialog(filename or "prompt.txt")
        if path:
            Path(path).write_text(content, encoding="utf-8")
        return path

    def save_png(self, filename: str, data_url: str) -> str:
        """保存前端画好的 PNG（data URL）。"""
        import base64

        if not isinstance(data_url, str) or "," not in data_url:
            return ""
        path = self._save_dialog(filename or "annotated.png")
        if path:
            Path(path).write_bytes(base64.b64decode(data_url.split(",", 1)[1]))
        return path

    # ---- 关闭流程 ----
    def on_closing(self):
        """WinForms 在 UI 线程上同步调用它。这里绝不能 evaluate_js（会等 UI 线程 → 死锁）。

        没有未保存改动：直接放行。有：先取消这次关闭，后台线程让前端存完再销毁窗口。
        """
        if self._quit_ok or not self._dirty:
            return True
        if not self._closing:
            self._closing = True
            threading.Thread(target=self._flush_then_close, name="moss-close", daemon=True).start()
        return False

    def _flush_then_close(self) -> None:
        win = self._window

        def flush() -> None:
            try:
                win.evaluate_js("window.__mossFlush && window.__mossFlush()")
                for _ in range(30):
                    if win.evaluate_js("window.__mossSaved !== false"):
                        return
                    time.sleep(0.1)
            except Exception:  # noqa: BLE001
                pass

        t = threading.Thread(target=flush, daemon=True)
        t.start()
        t.join(4.0)  # 前端卡住也最多等 4 秒
        self._quit_ok = True
        try:
            win.destroy()
        except Exception:  # noqa: BLE001
            os._exit(0)


def _hard_exit(code: int = 0) -> None:
    """窗口关掉后直接结束进程：避免 pythonnet / 后台服务线程在解释器收尾时卡住。"""
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass
    os._exit(code)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="moss-studio")
    ap.add_argument("--browser", action="store_true")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.WARNING)
    port = args.port or free_port()
    url = f"http://127.0.0.1:{port}"
    th = start_server(port)

    webview = None
    if not args.browser:
        try:
            import webview  # type: ignore[no-redef]  # pywebview
        except Exception as e:  # noqa: BLE001
            print(f"pywebview 不可用（{e}），改用浏览器打开 {url}", file=sys.stderr)
            webview = None

    if webview is not None:
        api = JsApi()
        # 先开一个启动页，服务就绪后再跳转：窗口立刻出现，不会“点了没反应”
        win = webview.create_window(TITLE, html=SPLASH_HTML, js_api=api, width=1600, height=1000,
                                    min_size=(1200, 760), background_color="#E7E3DC", text_select=True)
        api._window = win
        win.events.closing += api.on_closing

        def boot() -> None:
            if wait_ready(url, timeout=30.0):
                win.load_url(url)
            else:
                win.load_html(ERROR_HTML)

        try:
            from server.config import DATA

            webview.start(boot, debug=args.debug, private_mode=False, storage_path=str(DATA / "webview"))
            _hard_exit(0)
        except Exception as e:  # noqa: BLE001
            print(f"原生窗口启动失败（{e}），改用浏览器打开 {url}", file=sys.stderr)

    if not wait_ready(url):
        print("本地服务启动失败，请用 start-debug.bat 查看错误。", file=sys.stderr)
        return 1
    webbrowser.open(url)
    print(f"{TITLE} 已启动：{url}  （关闭此窗口即退出）")
    try:
        while th.is_alive():
            th.join(1.0)
    except KeyboardInterrupt:
        pass
    _hard_exit(0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
