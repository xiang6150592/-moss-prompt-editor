# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec：build_exe.bat 会调用它。产物为文件夹模式（启动快，WebView2 兼容性好）。
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

hidden = (
    collect_submodules("uvicorn")
    + collect_submodules("server")
    + collect_submodules("desktop")
    + collect_submodules("webview", filter=lambda n: not any(k in n for k in ("gtk", "qt", "cocoa", "android")))
    # vendor/compile_prompt.py 按文件路径动态加载，这里把它用到的标准库带上
    + ["argparse", "json", "math", "pathlib", "multipart", "python_multipart"]
)

a = Analysis(
    ["run_desktop.py"],
    pathex=["."],
    binaries=[],
    datas=[("dist", "dist"), ("vendor", "vendor"), ("server/lighting_data.json", "server")] + collect_data_files("webview"),
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "pandas", "PyQt5", "PyQt6", "PySide2", "PySide6", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="MOSS-Prompt-Studio",
    console=False,
    disable_windowed_traceback=False,
    icon=None,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="MOSS-Prompt-Studio")
