"""SQLite 存档：以键值方式保存世界快照，并保留多个手动存档槽位。"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        with self._conn() as c:
            c.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated REAL)")

    def _conn(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path)

    def save(self, key: str, value: dict) -> None:
        data = json.dumps(value, ensure_ascii=False)
        with self._conn() as c:
            c.execute("INSERT OR REPLACE INTO kv VALUES (?, ?, ?)", (key, data, time.time()))

    def load(self, key: str) -> dict | None:
        with self._conn() as c:
            row = c.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def delete(self, key: str) -> None:
        with self._conn() as c:
            c.execute("DELETE FROM kv WHERE key=?", (key,))

    def list(self, prefix: str = "") -> list[dict]:
        with self._conn() as c:
            rows = c.execute("SELECT key, updated, length(value) FROM kv WHERE key LIKE ? ORDER BY updated DESC", (prefix + "%",)).fetchall()
        return [{"key": k, "updated": u, "size": s} for k, u, s in rows]
