"""游戏时钟：以“绝对游戏分钟”计时，第 1 天 00:00 为 0。"""
from __future__ import annotations

WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def hhmm(minute_of_day: float) -> str:
    m = int(minute_of_day) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def parse_hhmm(s: str) -> int | None:
    try:
        s = str(s).strip().replace("：", ":")
        h, m = s.split(":")[:2]
        v = int(h) * 60 + int(m)
        if 0 <= v <= 1440:
            return v
    except Exception:  # noqa: BLE001
        return None
    return None


class Clock:
    def __init__(self, minutes: float = 6 * 60 + 30) -> None:
        self.minutes = float(minutes)
        self.speed = 1.0  # 倍率
        self.paused = False

    @property
    def day(self) -> int:
        return int(self.minutes // 1440) + 1

    @property
    def minute_of_day(self) -> int:
        return int(self.minutes % 1440)

    @property
    def hour(self) -> float:
        return (self.minutes % 1440) / 60

    def weekday(self) -> str:
        return WEEKDAYS[(self.day - 1) % 7]

    def label(self) -> str:
        return f"第{self.day}天 {self.weekday()} {hhmm(self.minute_of_day)}"

    def stamp(self, minutes: float | None = None) -> str:
        m = self.minutes if minutes is None else minutes
        return f"D{int(m // 1440) + 1} {hhmm(m % 1440)}"

    def period(self) -> str:
        h = self.hour
        if h < 5:
            return "深夜"
        if h < 8:
            return "清晨"
        if h < 11:
            return "上午"
        if h < 13:
            return "中午"
        if h < 17:
            return "下午"
        if h < 19:
            return "傍晚"
        if h < 23:
            return "晚上"
        return "深夜"

    def to_dict(self) -> dict:
        return {"minutes": self.minutes, "speed": self.speed, "paused": self.paused}

    def load(self, d: dict) -> None:
        self.minutes = float(d.get("minutes", self.minutes))
        self.speed = float(d.get("speed", 1.0))
        self.paused = bool(d.get("paused", False))
