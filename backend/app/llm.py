"""OpenAI 兼容的大模型客户端：并发控制、JSON 解析、统计与离线降级。"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

from .config import settings

log = logging.getLogger("llm")


class LLM:
    def __init__(self) -> None:
        self.enabled = bool(settings.llm_api_key)
        self.model = settings.llm_model
        self.sem = asyncio.Semaphore(max(1, settings.llm_concurrency))
        self.stats = {"calls": 0, "ok": 0, "fail": 0, "tokens": 0, "inflight": 0, "avg_ms": 0}
        self.client = None
        if self.enabled:
            from openai import AsyncOpenAI

            self.client = AsyncOpenAI(
                base_url=settings.llm_base_url,
                api_key=settings.llm_api_key,
                timeout=settings.llm_timeout,
                max_retries=1,
            )

    def status(self) -> dict:
        return {"enabled": self.enabled, "model": self.model if self.enabled else "离线规则模式", **self.stats}

    async def chat(
        self,
        messages: list[dict],
        max_tokens: int = 600,
        temperature: float = 0.85,
    ) -> str | None:
        if not self.enabled or self.client is None:
            return None
        async with self.sem:
            self.stats["calls"] += 1
            self.stats["inflight"] += 1
            t0 = time.time()
            try:
                resp = await self.client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    extra_body={"enable_thinking": False},
                )
                text = (resp.choices[0].message.content or "").strip()
                text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
                self.stats["ok"] += 1
                if resp.usage:
                    self.stats["tokens"] += resp.usage.total_tokens or 0
                ms = (time.time() - t0) * 1000
                n = self.stats["ok"]
                self.stats["avg_ms"] = int(self.stats["avg_ms"] + (ms - self.stats["avg_ms"]) / n)
                return text
            except Exception as e:  # noqa: BLE001
                self.stats["fail"] += 1
                log.warning("LLM 调用失败: %s", e)
                return None
            finally:
                self.stats["inflight"] -= 1

    async def json(
        self,
        system: str,
        user: str,
        max_tokens: int = 800,
        temperature: float = 0.85,
    ) -> dict | None:
        text = await self.chat(
            [
                {"role": "system", "content": system + "\n只输出一个合法 JSON 对象，不要输出任何解释或 markdown 代码块。"},
                {"role": "user", "content": user},
            ],
            max_tokens=max_tokens,
            temperature=temperature,
        )
        if not text:
            return None
        return extract_json(text)


def extract_json(text: str) -> dict | None:
    text = text.strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except Exception:  # noqa: BLE001
        pass
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(text[start : i + 1])
                    return obj if isinstance(obj, dict) else None
                except Exception:  # noqa: BLE001
                    return None
    return None


def as_list(v: Any) -> list:
    return v if isinstance(v, list) else []


llm = LLM()
