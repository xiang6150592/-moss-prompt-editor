# MOSS 提示词编辑器 / MOSS Prompt Editor

本地可视化工具，用于编辑 **MOSS-Image** 的 Caption / Layout 提示词：画框摆位、图层面板、透视辅助、想法增强、图像反推，并调用官方 `compile_prompt.py` 编译成可直接粘贴的 prompt。

> English: A local web UI for MOSS-Image caption & layout prompts — bbox layers, perspective guides, enhance/reverse via OpenAI-compatible APIs. Double-click `start.bat` on Windows (Python 3.11–3.13), open http://127.0.0.1:8787, then fill your own API key in Settings.

## 简介

- 纯本地运行，设置与历史保存在 `data/`，不上传到第三方（除你自己配置的 LLM API）。
- 仓库已预构建 `dist/`，一般**无需**再执行 `npm install` / `npm run build`。
- **本仓库不包含任何 API Key**，请使用你自己的账号。

## 功能

1. **想法 Caption**：输入想法 → 增强 / 降级生成连贯描述（不必拉框）
2. **拉框 Layout**：画布跟目标分辨率走；拖拽新建 / 移动 / 缩放；框可重叠
3. **分辨率模板**：内置 1024²、1280×768、1536×1024、1024×1536、1920×1088 等（均为 16 倍数）；可自定义保存
4. **图层面板（类似 PS）**：右侧列表管理前后顺序、显隐、锁定、改名、景深（前景 / 中景 / 背景）；支持拖动调层级、多选、快捷键
5. **前后关系写入提示词**：按图层顺序与框重叠，在 caption 后追加「在 X 前面」「部分遮挡」等短语（坐标格式不变）
6. **透视辅助**：地平线 + 1 / 2 / 3 点消失点；可手动拖动，也可「按框自动」或「从参考图检测」；支持透视自动缩放与对齐
7. **上下文改稿**：对当前草稿发指令，由 LLM（或本地规则）改 draft JSON
8. **历史记录**：服务端 `data/history.json` + 浏览器 localStorage
9. **图像反推**：上传图 → 视觉模型 → long / medium / short，一键填入 Caption
10. **编译**：Layout 走官方坐标变换；Caption 输出散文

### 图层与快捷键（摘要）

| 操作 | 说明 |
|------|------|
| 点选 / Ctrl / Shift | 单选、加选、连选 |
| 拖动图层面板行 | 调整前后层级 |
| Alt+点击（或同位置再点） | 轮选叠在下面的框 |
| `[` / `]` | 下移 / 上移一层 |
| Shift+`[` / Shift+`]` | 置底 / 置顶 |
| Delete | 删除（跳过锁定） |
| 方向键 | 微调 1px（Shift = 10px） |

### 透视辅助（摘要）

- 勾选「透视辅助」显示地平线、消失点与放射参考线
- **手动**：拖消失点 / 地平线，或输入百分比（可超出画面）
- **按框自动**：用落地框的底边与高度估地平线与消失点
- **从参考图检测**：本地边缘 + Hough 找直线投票求消失点
- **透视自动缩放**：上下拖框时近大远小
- 「把透视写入提示词」默认关闭，需要时再勾选

## 快速开始

### Windows（推荐）

1. 克隆或下载本仓库并解压到任意目录
2. 确认已安装 **Python 3.11 / 3.12 / 3.13**（暂不支持 3.14）
3. 双击 **`start.bat`**
   - 首次会自动创建 `.venv` 并安装依赖（需能访问 PyPI）
4. 浏览器打开 **http://127.0.0.1:8787**（脚本通常会自动打开）

macOS / Linux：

```bash
chmod +x start.sh
./start.sh
```

### 手动启动（可选）

```bash
# 1. Python 依赖
python -m venv .venv
# Windows:
.venv\Scripts\pip install -r server/requirements.txt
# macOS / Linux:
.venv/bin/pip install -r server/requirements.txt

# 2. 前端（仅在改了 src/ 或没有 dist/ 时需要）
npm install
npm run build

# 3. 启动（托管 dist/）
# Windows:
.venv\Scripts\uvicorn server.main:app --host 127.0.0.1 --port 8787
# macOS / Linux:
.venv/bin/uvicorn server.main:app --host 127.0.0.1 --port 8787
```

开发热更新（可选）：后端 8787 + `npm run dev`（Vite 5173，`/api` 代理到后端）。

## API 设置

打开网页后进入 **设置**，或编辑 `data/settings.json`：

| 字段 | 说明 |
|------|------|
| `base_url` | OpenAI 兼容 Base URL，如 `https://api.openai.com/v1` |
| `api_key` | 你的密钥（**勿提交到 Git**） |
| `model` | 文本模型（enhance / context） |
| `vision_model` | 视觉模型（图像反推） |
| `prompt_prefix` | 默认前缀，如 `best quality, masterpiece` |
| `negative_prompt` | 负面词 |

无 API Key 时：编译与纯前端编辑仍可用；enhance / context 走本地规则降级；图像反推会提示错误。

### HTTP 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/compile` | 编译 draft → prompt |
| POST | `/api/enhance` | 想法增强 |
| POST | `/api/context` | 指令改稿 |
| POST | `/api/reverse` | 图像反推 |
| GET/POST | `/api/history` | 历史 |
| GET/PUT | `/api/settings` | 设置 |

## 目录结构

```
moss-prompt-editor/
  start.bat / start.ps1 / start.sh   # 一键启动
  index.html                         # Vite 入口
  package.json / vite.config.ts
  src/                               # React + TypeScript 前端
  dist/                              # 预构建静态资源（可直接运行）
  server/                            # FastAPI 后端
  data/
    settings.json                    # API 配置（仓库内 api_key 为空）
    history.json                     # 历史（仓库内为空数组）
    skills.json
  vendor/                            # 官方 compile_prompt 等只读依赖
  使用说明.txt
```

## 安全提示

- **永远不要**把真实 `api_key` 提交到 Git 或打进分享压缩包
- 分享前请确认：`data/settings.json` 里 `api_key` 为空字符串，`data/history.json` 为 `[]`
- `.gitignore` 已忽略 `.venv/`、`node_modules/`、`__pycache__/` 等；请勿强制添加这些目录
- 本工具仅把请求发往你在设置里填写的 Base URL；请自行保管密钥

## 已知限制

- enhance / context / reverse 依赖你配置的 API；仓库不内置密钥
- 透视「按框自动 / 参考图检测」只是辅助，复杂场景请手动调消失点
- Layout 编译失败时检查：框是否越界、caption 是否为空、宽高是否为 16 倍数
- 图像反推质量取决于所选 vision 模型

## License

内部分享工具；MOSS-Image skill / `compile_prompt.py` 版权归 OpenMOSS 上游。
