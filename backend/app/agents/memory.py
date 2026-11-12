"""记忆流（参考 Generative Agents）：观察 / 对话 / 反思 / 社交 / 事件。

检索打分 = 时近性 + 重要性 + 相关性。相关性用中文字符二元组余弦相似度，零依赖、够用。
"""
from __future__ import annotations

import math
from collections import Counter
from dataclasses import asdict, dataclass

KIND_LABEL = {
    "observation": "观察",
    "conversation": "对话",
    "reflection": "感悟",
    "social": "小镇圈",
    "event": "事件",
    "chat": "与玩家",
    "plan": "计划",
    "thought": "想法",
}


def _grams(text: str) -> Counter:
    t = "".join(ch for ch in text.lower() if not ch.isspace())
    grams = Counter(t[i : i + 2] for i in range(len(t) - 1))
    grams.update(ch for ch in t if "一" <= ch <= "鿿")
    return grams


def similarity(a: str, b: str) -> float:
    ga, gb = _grams(a), _grams(b)
    if not ga or not gb:
        return 0.0
    dot = sum(v * gb.get(k, 0) for k, v in ga.items())
    na = math.sqrt(sum(v * v for v in ga.values()))
    nb = math.sqrt(sum(v * v for v in gb.values()))
    return dot / (na * nb) if na and nb else 0.0


@dataclass
class Memory:
    id: int
    t: float  # 绝对游戏分钟
    kind: str
    text: str
    importance: int = 3
    last_access: float = 0.0
    people: tuple = ()

    def to_dict(self) -> dict:
        d = asdict(self)
        d["people"] = list(self.people)
        return d


class MemoryStream:
    MAX = 600

    def __init__(self) -> None:
        self.items: list[Memory] = []
        self._next = 1

    def add(self, text: str, kind: str, t: float, importance: int = 3, people: list | tuple = ()) -> Memory:
        importance = max(1, min(10, int(importance or 3)))
        m = Memory(self._next, t, kind, text.strip(), importance, t, tuple(people))
        self._next += 1
        self.items.append(m)
        if len(self.items) > self.MAX:
            self._prune(t)
        return m

    def _prune(self, now: float) -> None:
        # 保留最近 200 条，其余按重要性淘汰
        recent = self.items[-200:]
        older = sorted(self.items[:-200], key=lambda m: m.importance + (1 if m.kind == "reflection" else 0), reverse=True)
        keep = older[: self.MAX - 250]
        keep.sort(key=lambda m: m.id)
        self.items = keep + recent

    def recent(self, n: int = 10, kinds: tuple | None = None) -> list[Memory]:
        out = [m for m in self.items if kinds is None or m.kind in kinds]
        return out[-n:]

    def retrieve(self, query: str, now: float, k: int = 8, person: str | None = None) -> list[Memory]:
        if not self.items:
            return []
        scored = []
        for m in self.items[-400:]:
            hours = max(0.0, (now - m.last_access) / 60)
            recency = 0.99 ** hours
            imp = m.importance / 10
            rel = similarity(query, m.text)
            bonus = 0.4 if person and person in m.people else 0.0
            scored.append((recency * 0.8 + imp * 1.0 + rel * 1.6 + bonus, m))
        scored.sort(key=lambda x: x[0], reverse=True)
        top = [m for _, m in scored[:k]]
        for m in top:
            m.last_access = now
        top.sort(key=lambda m: m.t)
        return top

    def importance_since(self, t: float) -> int:
        return sum(m.importance for m in self.items if m.t > t and m.kind != "reflection")

    def to_list(self) -> list[dict]:
        return [m.to_dict() for m in self.items]

    def load(self, data: list[dict]) -> None:
        self.items = []
        for d in data:
            d = dict(d)
            d["people"] = tuple(d.get("people") or ())
            self.items.append(Memory(**d))
        self._next = (self.items[-1].id + 1) if self.items else 1


def format_memories(mems: list[Memory], clock_stamp) -> str:
    if not mems:
        return "（暂无相关记忆）"
    return "\n".join(f"- [{clock_stamp(m.t)}][{KIND_LABEL.get(m.kind, m.kind)}] {m.text}" for m in mems)
