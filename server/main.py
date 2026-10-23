"""FastAPI 应用：API + 前端静态文件。桌面壳（desktop/app.py）与 `uvicorn server.main:app` 共用。"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import db
from .api import router as api_router
from .config import APP_VERSION, DIST
from .skills import load_skills, router as skills_router

@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init()
    load_skills()
    yield


app = FastAPI(title="MOSS Prompt Studio", version=APP_VERSION, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(skills_router)
app.include_router(api_router)


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    if full_path.startswith("api/"):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    index = DIST / "index.html"
    if not index.exists():
        return JSONResponse({"detail": "前端未构建：请先运行 npm run build"}, status_code=503)
    if full_path:
        cand = (DIST / full_path).resolve()
        if cand.is_file() and DIST.resolve() in cand.parents:
            return FileResponse(cand)
    return FileResponse(index)
