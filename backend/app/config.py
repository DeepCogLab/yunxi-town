"""读取根目录 .env 配置（无需 python-dotenv）。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
DATA_DIR = BACKEND / "data"
FRONTEND_DIST = ROOT / "frontend" / "dist"


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env_file(ROOT / ".env")


@dataclass
class Settings:
    llm_base_url: str = os.getenv("LLM_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    llm_model: str = os.getenv("LLM_MODEL", "qwen3.5-122b-a10b")
    llm_api_key: str = os.getenv("LLM_API_KEY", "")
    llm_concurrency: int = int(os.getenv("LLM_CONCURRENCY", "4"))
    llm_timeout: float = float(os.getenv("LLM_TIMEOUT", "45"))
    minutes_per_second: float = float(os.getenv("SIM_MINUTES_PER_SECOND", "1.0"))
    port: int = int(os.getenv("PORT", "8000"))
    db_path: Path = DATA_DIR / "town.db"


settings = Settings()
DATA_DIR.mkdir(parents=True, exist_ok=True)
