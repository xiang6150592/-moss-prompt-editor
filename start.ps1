# MOSS 提示词编辑器 — Windows 启动
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$Port = if ($env:PORT) { $env:PORT } else { "8787" }

if (-not (Test-Path .\.venv)) {
  py -3 -m venv .venv
  if ($LASTEXITCODE -ne 0) { python -m venv .venv }
}
.\.venv\Scripts\python.exe -m pip install -q -r server\requirements.txt

# dist 已随包带上；若要热更新再 npm i && npm run build
if (-not (Test-Path .\dist\index.html)) {
  if (-not (Test-Path .\node_modules)) { npm install }
  npm run build
}

Write-Host "==> http://127.0.0.1:$Port"
& .\.venv\Scripts\uvicorn.exe server.main:app --host 127.0.0.1 --port $Port
