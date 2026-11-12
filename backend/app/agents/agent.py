"""智能体：状态、日程执行、移动与关系。认知（调用大模型）的部分在 cognition.py。"""
from __future__ import annotations

import math
import random
from typing import TYPE_CHECKING

from ..world.clock import hhmm, parse_hhmm
from ..world.personas import default_plan
from .memory import MemoryStream

if TYPE_CHECKING:
    from ..sim import World


def normalize_plan(blocks: list[dict], persona: dict, valid_locs: set[str]) -> list[dict]:
    """把模型/默认日程整理成覆盖 0-1440 分钟、按时间排序、地点合法的区块列表。"""
    home = persona["home"]
    out = []
    for b in blocks or []:
        if not isinstance(b, dict):
            continue
        s = parse_hhmm(b.get("start", ""))
        e = parse_hhmm(b.get("end", ""))
        loc = str(b.get("location", "")).strip()
        if s is None or e is None:
            continue
        if e <= s:
            e = 1440 if e == 0 or e < s else e
        if e <= s:
            continue
        if loc not in valid_locs:
            loc = home
        out.append({
            "s": s, "e": e, "location": loc,
            "activity": str(b.get("activity", "活动"))[:40],
            "emoji": str(b.get("emoji", "🙂"))[:4] or "🙂",
            "with": b.get("with") or [],
        })
    out.sort(key=lambda b: b["s"])
    # 去重叠
    clean: list[dict] = []
    for b in out:
        if clean and b["s"] < clean[-1]["e"]:
            if b["e"] <= clean[-1]["e"]:
                continue
            b["s"] = clean[-1]["e"]
        clean.append(b)
    # 补空档
    filled: list[dict] = []
    t = 0
    for b in clean:
        if b["s"] > t:
            prev_loc = filled[-1]["location"] if filled else home
            filled.append({"s": t, "e": b["s"], "location": prev_loc, "activity": "随意走走" if filled else "睡觉", "emoji": "🚶" if filled else "😴", "with": []})
        filled.append(b)
        t = b["e"]
    if t < 1440:
        filled.append({"s": t, "e": 1440, "location": home, "activity": "睡觉", "emoji": "😴", "with": []})
    return filled


class Agent:
    def __init__(self, persona: dict, world: "World") -> None:
        self.p = persona
        self.id: str = persona["id"]
        self.name: str = persona["name"]
        self.world = world
        self.rng = random.Random(hash(self.id) & 0xFFFF)
        home = persona["home"]
        sx, sy = world.map.random_spot(home, self.rng)
        self.x, self.y = sx + 0.5, sy + 0.5
        self.path: list[tuple[int, int]] = []
        self.target_loc: str | None = None
        self.location: str | None = home
        self.status = "acting"  # moving / acting / sleeping / chatting / talking
        self.activity = "刚刚醒来"
        self.emoji = "🙂"
        self.mood = "平静"
        self.thought = ""
        self.plan: list[dict] = normalize_plan(default_plan(persona), persona, set(world.map.locations))
        self.plan_day = 0
        self.plan_summary = "按平常的习惯过一天"
        self.planning = False
        self.busy = False  # 正在进行反思 / 社交等后台思考
        self.relations: dict[str, dict] = {}
        for oid, (aff, desc) in persona.get("relations", {}).items():
            self.relations[oid] = {"affinity": aff, "desc": desc}
        self.memory = MemoryStream()
        self.commitments: list[dict] = []
        self.chat_partner: str | None = None
        self.conv_cooldown: dict[str, float] = {}
        self.greet_cooldown: dict[str, float] = {}
        self.last_reflect_t = 0.0
        self.next_phone = world.clock.minutes + self.rng.randint(30, 150)
        self.last_phone = -999.0
        self.next_wander = 0.0
        self.next_perceive = 0.0
        self.last_seen_set: frozenset = frozenset()
        self.face: tuple[float, float] | None = None
        self.convs_today = 0
        self.block_key = None

    # ------------------------------------------------------------------ helpers
    def rel(self, uid: str) -> dict:
        if uid not in self.relations:
            self.relations[uid] = {"affinity": 30, "desc": "认识但不熟"}
        return self.relations[uid]

    def change_affinity(self, uid: str, delta: int) -> None:
        r = self.rel(uid)
        r["affinity"] = max(0, min(100, int(r["affinity"] + max(-10, min(10, int(delta or 0))))))

    def awake(self) -> bool:
        return self.status not in ("sleeping",)

    def available(self) -> bool:
        return self.status in ("acting", "moving") and not self.chat_partner and not self.planning

    def current_block(self) -> dict:
        m = self.world.clock.minute_of_day
        for b in self.plan:
            if b["s"] <= m < b["e"]:
                return b
        return self.plan[-1]

    def dist(self, x: float, y: float) -> float:
        return math.hypot(self.x - x, self.y - y)

    # ------------------------------------------------------------------ plan ops
    def insert_block(self, start: int, end: int, location: str, activity: str, emoji: str = "📌", with_: list | None = None) -> None:
        start, end = max(0, start), min(1440, end)
        if end <= start:
            return
        new = []
        for b in self.plan:
            if b["e"] <= start or b["s"] >= end:
                new.append(b)
                continue
            if b["s"] < start:
                new.append({**b, "e": start})
            if b["e"] > end:
                new.append({**b, "s": end})
        new.append({"s": start, "e": end, "location": location, "activity": activity[:40], "emoji": emoji or "📌", "with": with_ or []})
        new.sort(key=lambda b: b["s"])
        self.plan = new
        self.block_key = None

    def add_commitment(self, time_str: str, location: str, activity: str, with_: list, day_offset: int = 0) -> str | None:
        """把约定写入今天或明天的日程。返回描述文字。"""
        s = parse_hhmm(time_str)
        if s is None or location not in self.world.map.locations:
            return None
        day = self.world.clock.day + day_offset
        now_m = self.world.clock.minute_of_day
        if day_offset == 0 and s < now_m - 10:
            day += 1  # 时间已过，视为明天
        if day == self.world.clock.day:
            self.insert_block(s, s + 75, location, activity, "🤝", with_)
        else:
            self.commitments.append({"day": day, "start": hhmm(s), "location": location, "activity": activity, "with": with_})
        when = "今天" if day == self.world.clock.day else "明天"
        return f"{when}{hhmm(s)} 在{self.world.loc_name(location)}{activity}"

    def todays_commitments(self) -> list[dict]:
        d = self.world.clock.day
        out = [c for c in self.commitments if c["day"] == d]
        self.commitments = [c for c in self.commitments if c["day"] > d]
        return out

    # ------------------------------------------------------------------ movement
    def go_to(self, loc_id: str) -> None:
        avoid = {(int(a.x), int(a.y)) for a in self.world.agents.values() if a is not self}
        spot = self.world.map.random_spot(loc_id, self.rng, avoid)
        self.path = self.world.map.find_path((int(self.x), int(self.y)), spot)
        self.target_loc = loc_id
        if self.path:
            self.status = "moving"

    def walk_speed(self) -> float:
        sp = max(0.5, min(self.world.clock.speed, 8))
        return 2.2 * sp ** 0.6

    def step(self, dt: float) -> None:
        dist = self.walk_speed() * dt
        while dist > 0 and self.path:
            tx, ty = self.path[0][0] + 0.5, self.path[0][1] + 0.5
            dx, dy = tx - self.x, ty - self.y
            d = math.hypot(dx, dy)
            if d <= dist:
                self.x, self.y = tx, ty
                self.path.pop(0)
                dist -= d
            else:
                self.x += dx / d * dist
                self.y += dy / d * dist
                dist = 0
        loc = self.world.map.location_at(self.x, self.y)
        self.location = loc.id if loc else None

    # ------------------------------------------------------------------ tick
    def tick(self, dt: float) -> None:
        if self.status in ("chatting", "talking"):
            return
        clock = self.world.clock
        b = self.current_block()
        key = (b["s"], b["location"], b["activity"])
        if b["location"] != self.target_loc:
            if self.status == "sleeping":
                self.memory.add(f"醒了，准备去{self.world.loc_name(b['location'])}{b['activity']}", "observation", clock.minutes, 2)
            self.go_to(b["location"])
            self.activity = f"前往{self.world.loc_name(b['location'])}"
            self.emoji = "🚶"
        if self.path:
            self.status = "moving"
            self.step(dt)
            return
        # 已到达
        if self.block_key != key or self.status == "moving":
            self.block_key = key
            self.activity = b["activity"]
            self.emoji = b["emoji"]
            self.location = self.target_loc
            if "睡" in b["activity"] and b["location"] == self.p["home"]:
                if self.status != "sleeping":
                    self.memory.add("回家睡觉了", "observation", clock.minutes, 1)
                self.status = "sleeping"
                self.emoji = "😴"
            else:
                self.status = "acting"
            self.next_wander = clock.minutes + self.rng.randint(15, 45)
        # 在公共场所偶尔走动
        if self.status == "acting" and clock.minutes >= self.next_wander:
            loc = self.world.map.locations.get(self.target_loc or "")
            self.next_wander = clock.minutes + self.rng.randint(20, 60)
            if loc and loc.public and self.rng.random() < 0.6:
                spot = self.world.map.random_spot(loc.id, self.rng)
                self.path = self.world.map.find_path((int(self.x), int(self.y)), spot)
                self.path = self.path[:8]

    # ------------------------------------------------------------------ views
    def brief(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "x": round(self.x, 2),
            "y": round(self.y, 2),
            "status": self.status,
            "activity": self.activity,
            "emoji": self.emoji,
            "location": self.location,
            "mood": self.mood,
            "partner": self.chat_partner,
            "face": self.face,
        }

    def static_info(self) -> dict:
        p = self.p
        return {
            "id": self.id, "name": self.name, "age": p["age"], "occupation": p["occupation"],
            "colors": p["colors"], "home": p["home"], "work": p["work"], "bio": p.get("bio", ""),
        }

    def detail(self) -> dict:
        w = self.world
        return {
            **self.static_info(),
            **self.brief(),
            "personality": self.p["personality"],
            "background": self.p["background"],
            "thought": self.thought,
            "plan_summary": self.plan_summary,
            "plan": [{"start": hhmm(b["s"]), "end": hhmm(b["e"]) if b["e"] < 1440 else "24:00", "location": w.loc_name(b["location"]), "activity": b["activity"], "emoji": b["emoji"]} for b in self.plan],
            "commitments": self.commitments,
            "relations": sorted(
                [{"id": k, "name": w.name_of(k), **v} for k, v in self.relations.items()],
                key=lambda r: -r["affinity"],
            ),
            "memories": [
                {**m.to_dict(), "stamp": w.clock.stamp(m.t)} for m in self.memory.items[-60:][::-1]
            ],
        }

    def to_dict(self) -> dict:
        return {
            "id": self.id, "x": self.x, "y": self.y, "status": self.status if self.status != "talking" and self.status != "chatting" else "acting",
            "activity": self.activity, "emoji": self.emoji, "mood": self.mood, "thought": self.thought,
            "plan": self.plan, "plan_day": self.plan_day, "plan_summary": self.plan_summary,
            "relations": self.relations, "memory": self.memory.to_list(), "commitments": self.commitments,
            "last_reflect_t": self.last_reflect_t, "next_phone": self.next_phone, "location": self.location,
            "conv_cooldown": self.conv_cooldown, "convs_today": self.convs_today,
        }

    def load(self, d: dict) -> None:
        self.x, self.y = d.get("x", self.x), d.get("y", self.y)
        self.status = d.get("status", "acting")
        self.activity, self.emoji = d.get("activity", self.activity), d.get("emoji", self.emoji)
        self.mood, self.thought = d.get("mood", self.mood), d.get("thought", "")
        self.plan = d.get("plan") or self.plan
        self.plan_day = d.get("plan_day", 0)
        self.plan_summary = d.get("plan_summary", "")
        self.relations = d.get("relations", self.relations)
        self.memory.load(d.get("memory", []))
        self.commitments = d.get("commitments", [])
        self.last_reflect_t = d.get("last_reflect_t", 0.0)
        self.next_phone = d.get("next_phone", self.next_phone)
        self.location = d.get("location", self.location)
        self.conv_cooldown = d.get("conv_cooldown", {})
        self.convs_today = d.get("convs_today", 0)
        self.target_loc = None
        self.path = []
