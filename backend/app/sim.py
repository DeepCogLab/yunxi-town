"""世界模拟主循环：时间推进、智能体调度、偶遇对话、玩家交互、社交网络联动、存档与广播。"""
from __future__ import annotations

import asyncio
import logging
import math
import random
import time
import uuid
from collections import deque
from typing import Any

from .agents import cognition as cog
from .agents.agent import Agent
from .config import settings
from .db import Store
from .llm import as_list, llm
from .social.network import MENTION_RE, Social
from .world.clock import Clock
from .world.personas import PERSONAS, TOWN_NAME
from .world.town_map import TownMap

log = logging.getLogger("sim")

WEATHERS = [("晴", 5), ("多云", 3), ("小雨", 2), ("雷阵雨", 1), ("雾", 1)]


class Player:
    def __init__(self, pid: str, name: str, bio: str = "", color: str = "#4f9dff") -> None:
        self.id = pid
        self.name = name
        self.bio = bio
        self.color = color
        self.x, self.y = 37.5, 37.5
        self.dir = 0.0
        self.location: str | None = None
        self.talking_to: str | None = None
        self.history: list[dict] = []
        self.waiting = False
        self.last_chat = 0.0
        self.online = False

    def brief(self) -> dict:
        return {"id": self.id, "name": self.name, "x": round(self.x, 2), "y": round(self.y, 2), "dir": round(self.dir, 2), "color": self.color, "talking_to": self.talking_to, "online": self.online}

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "bio": self.bio, "color": self.color, "x": self.x, "y": self.y}


class World:
    def __init__(self) -> None:
        self.store = Store(settings.db_path)
        self.outbox: list[dict] = []
        self.clients: dict[Any, str | None] = {}
        self.tasks: set[asyncio.Task] = set()
        self._init_state()
        saved = self.store.load("world")
        if saved:
            try:
                self.load(saved)
                log.info("已加载存档：%s", self.clock.label())
            except Exception as e:  # noqa: BLE001
                log.exception("存档加载失败，使用新世界：%s", e)
                self._init_state()

    # ------------------------------------------------------------------ setup
    def _init_state(self) -> None:
        self.rng = random.Random()
        self.clock = Clock()
        self.clock.speed = 1.0
        self.map = TownMap()
        self.social = Social()
        self.weather = "晴"
        self.logs: deque = deque(maxlen=400)
        self.conv_log: deque = deque(maxlen=150)
        self.active_convs: dict[str, dict] = {}
        self.players: dict[str, Player] = {}
        self.agents: dict[str, Agent] = {}
        for p in PERSONAS:
            self.agents[p["id"]] = Agent(p, self)
        for a in self.agents.values():
            self.social.add_user(a.id, a.name, a.p.get("bio", ""), a.p["colors"]["shirt"], True)
        for a in self.agents.values():
            for oid, r in a.relations.items():
                if r["affinity"] >= 50 and oid in self.agents:
                    self.social.follows[a.id].add(oid)
        self.last_weather_day = self.clock.day
        self.next_second = 0.0
        self.last_save = time.time()
        self._seed_posts()

    def _seed_posts(self) -> None:
        seeds = [
            ("li", "家人们！云溪镇的清晨也太出片了吧 📸 #云溪日常# 蹲一个一起拍日出的搭子"),
            ("wang", "同志们，咱们云溪镇首届旅游节正在筹备中！欢迎大家建言献策 #云溪旅游节#"),
            ("wu", "周五晚上老地方，老吴酒馆不见不散 🎸 唱点老歌给你们听。"),
            ("lin", "新到的云南咖啡豆，有一点点柑橘的香味呢 ☕ 欢迎来尝尝～"),
            ("xiaoman", "暑假回家第 N 天，被我爸拉去菜市场吆喝，无语 #云溪日常#"),
        ]
        t = self.clock.minutes - 600
        for uid, text in seeds:
            p = self.social.create_post(uid, text, t)
            t += 90
            for o in self.agents:
                if o != uid and self.rng.random() < 0.3:
                    p["likes"].append(o)
        p = self.social.posts[1]
        self.social.comment("wu", p["id"], "旅游节可以，别把咱这小镇搞成网红景区就行。", t)
        self.social.comment("li", p["id"], "@王大山 宣传片我来拍！", t + 5)

    # ------------------------------------------------------------------ utils
    def spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(self._guard(coro))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    @staticmethod
    async def _guard(coro) -> None:
        try:
            await coro
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("后台任务出错")

    def llm_free(self, slack: int = 2) -> bool:
        return llm.stats["inflight"] < settings.llm_concurrency + slack and len(self.tasks) < 16

    def loc_name(self, lid: str | None) -> str:
        if not lid:
            return "路上"
        loc = self.map.locations.get(lid)
        return loc.name if loc else lid

    def name_of(self, uid: str) -> str:
        if uid in self.agents:
            return self.agents[uid].name
        if uid in self.players:
            return self.players[uid].name
        u = self.social.users.get(uid)
        return u["name"] if u else uid

    def emit(self, typ: str, data: dict, to: str | None = None) -> None:
        self.outbox.append({"t": typ, **data, "_to": to})

    def notify_player(self, pid: str, text: str) -> None:
        self.emit("toast", {"text": text}, to=pid)

    def log(self, text: str, kind: str = "info", who: list | None = None) -> None:
        item = {"t": self.clock.minutes, "stamp": self.clock.stamp(), "text": text, "kind": kind, "who": who or []}
        self.logs.append(item)
        self.emit("log", {"item": item})

    def people_near(self, x: float, y: float, r: float) -> list:
        out = [a for a in self.agents.values() if a.status != "sleeping" and math.hypot(a.x - x, a.y - y) <= r]
        out += [p for p in self.players.values() if p.online and math.hypot(p.x - x, p.y - y) <= r]
        return out

    # ------------------------------------------------------------------ main loop
    async def run(self) -> None:
        last = time.perf_counter()
        while True:
            await asyncio.sleep(0.2)
            now = time.perf_counter()
            dt = min(now - last, 1.0)
            last = now
            try:
                self._tick(dt)
            except Exception:  # noqa: BLE001
                log.exception("tick 出错")
            await self._flush()
            if time.time() - self.last_save > 30:
                self.save()

    def _tick(self, dt: float) -> None:
        c = self.clock
        eff = 0.0 if c.paused else dt
        if eff:
            c.minutes += eff * settings.minutes_per_second * c.speed
        if c.day != self.last_weather_day and c.minute_of_day >= 300:
            self.last_weather_day = c.day
            self.set_weather(self._pick_weather())
            for a in self.agents.values():
                a.convs_today = 0
        for a in self.agents.values():
            if a.plan_day != c.day and not a.planning and (c.minute_of_day >= 180 or a.plan_day == 0):
                a.planning = True
                self.spawn(cog.plan_day(self, a))
            if eff:
                a.tick(eff)
        self.next_second -= dt
        if self.next_second <= 0:
            self.next_second = 1.0
            if not c.paused:
                self._each_second()
        self.emit("tick", {
            "clock": {"label": c.label(), "minutes": c.minutes, "day": c.day, "mod": c.minute_of_day, "speed": c.speed, "paused": c.paused, "period": c.period()},
            "weather": self.weather,
            "agents": [a.brief() for a in self.agents.values()],
            "players": [p.brief() for p in self.players.values() if p.online],
            "llm": llm.status(),
        })

    def _each_second(self) -> None:
        now = self.clock.minutes
        agents = list(self.agents.values())
        # 感知
        for a in agents:
            if a.status == "sleeping" or now < a.next_perceive:
                continue
            a.next_perceive = now + 15
            seen = [o for o in self.people_near(a.x, a.y, 4.5) if o is not a]
            ids = frozenset(o.id for o in seen)
            if ids and ids != a.last_seen_set:
                names = "、".join(o.name for o in seen)
                act = "；".join(f"{o.name}在{o.activity}" for o in seen if isinstance(o, Agent))[:80]
                a.memory.add(f"在{self.loc_name(a.location)}看到了{names}" + (f"（{act}）" if act else ""), "observation", now, 2, list(ids))
            a.last_seen_set = ids
        # 反思
        for a in agents:
            if a.status != "sleeping" and not a.busy and a.memory.importance_since(a.last_reflect_t) >= 50 and self.llm_free(0):
                a.busy = True
                self.spawn(cog.reflect(self, a))
        # 刷手机
        for a in agents:
            if a.status in ("acting", "moving") and not a.busy and not a.chat_partner and now >= a.next_phone and self.llm_free(0):
                a.next_phone = now + self.rng.randint(120, 300)
                a.last_phone = now
                a.busy = True
                self.spawn(cog.social_session(self, a))
        # 偶遇对话
        if len(self.active_convs) < 3 and self.llm_free(1):
            free = [a for a in agents if a.available() and not a.busy and a.convs_today < 10]
            self.rng.shuffle(free)
            used: set[str] = set()
            for i, a in enumerate(free):
                if a.id in used:
                    continue
                for b in free[i + 1 :]:
                    if b.id in used or a.dist(b.x, b.y) > 2.2:
                        continue
                    if now < a.conv_cooldown.get(b.id, 0):
                        continue
                    aff = (a.rel(b.id)["affinity"] + b.rel(a.id)["affinity"]) / 200
                    if self.rng.random() < 0.10 + 0.2 * aff:
                        used |= {a.id, b.id}
                        self.start_conversation(a, b)
                        break
                    a.conv_cooldown[b.id] = now + 20  # 擦肩而过
                if len(self.active_convs) >= 3:
                    break
        # 玩家：打招呼 / 聊天超时
        for p in list(self.players.values()):
            if not p.online:
                continue
            if p.talking_to and time.time() - p.last_chat > 120:
                self.player_chat_end(p.id)
            if p.talking_to:
                continue
            for a in agents:
                if a.available() and not a.busy and a.dist(p.x, p.y) < 2.6 and now >= a.greet_cooldown.get(p.id, 0) and self.llm_free(0):
                    a.greet_cooldown[p.id] = now + 240
                    self.spawn(self._greet(a, p))
                    break

    async def _flush(self) -> None:
        if not self.outbox or not self.clients:
            self.outbox.clear()
            return
        msgs, self.outbox = self.outbox, []
        dead = []
        for ws, pid in list(self.clients.items()):
            batch = [{k: v for k, v in m.items() if k != "_to"} for m in msgs if m["_to"] is None or m["_to"] == pid]
            if not batch:
                continue
            try:
                await ws.send_json({"t": "batch", "items": batch})
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    # ------------------------------------------------------------------ npc conversations
    def start_conversation(self, a: Agent, b: Agent) -> None:
        cid = uuid.uuid4().hex[:8]
        for x, y in ((a, b), (b, a)):
            x.status = "chatting"
            x.chat_partner = y.id
            x.path = []
            x.face = (y.x, y.y)
            x.emoji = "💬"
            x.activity = f"和{y.name}聊天"
            x.convs_today += 1
            x.conv_cooldown[y.id] = self.clock.minutes + 180
        self.active_convs[cid] = {"a": a.id, "b": b.id}
        self.spawn(self._run_conversation(cid, a, b))

    async def _run_conversation(self, cid: str, a: Agent, b: Agent) -> None:
        try:
            data = await cog.npc_dialogue(self, a, b)
            lines = data["lines"]
            self.emit("conv_start", {"id": cid, "a": a.id, "b": b.id})
            for ln in lines:
                spk = self.agents[ln["speaker"]]
                lis = b if spk is a else a
                self.emit("say", {"speaker": spk.id, "name": spk.name, "to": lis.id, "text": ln["text"], "conv": cid})
                await asyncio.sleep(1.8 + len(ln["text"]) / 12)
            self._finish_conversation(cid, a, b, data, lines)
        finally:
            for x in (a, b):
                x.status = "acting"
                x.chat_partner = None
                x.face = None
                x.target_loc = None
                x.block_key = None
            self.active_convs.pop(cid, None)
            self.emit("conv_end", {"id": cid})

    def _finish_conversation(self, cid: str, a: Agent, b: Agent, data: dict, lines: list) -> None:
        now = self.clock.minutes
        summary = str(data.get("summary") or f"{a.name}和{b.name}聊了几句")[:120]
        imp = int(data.get("importance") or 3)
        a.memory.add(f"和{b.name}聊天：{summary}", "conversation", now, imp, [b.id])
        b.memory.add(f"和{a.name}聊天：{summary}", "conversation", now, imp, [a.id])
        a.change_affinity(b.id, int(data.get("a_affinity") or 1))
        b.change_affinity(a.id, int(data.get("b_affinity") or 1))
        if data.get("a_mood"):
            a.mood = str(data["a_mood"])[:8]
        if data.get("b_mood"):
            b.mood = str(data["b_mood"])[:8]
        if data.get("a_view_of_b"):
            a.rel(b.id)["desc"] = str(data["a_view_of_b"])[:40]
        if data.get("b_view_of_a"):
            b.rel(a.id)["desc"] = str(data["b_view_of_a"])[:40]
        commits = []
        for c in as_list(data.get("commitments"))[:2]:
            if not isinstance(c, dict):
                continue
            off = 1 if c.get("day") == "tomorrow" else 0
            d1 = a.add_commitment(str(c.get("time", "")), str(c.get("location", "")), str(c.get("activity", "见面")), [b.id], off)
            b.add_commitment(str(c.get("time", "")), str(c.get("location", "")), str(c.get("activity", "见面")), [a.id], off)
            if d1:
                commits.append(d1)
        # 旁听
        for o in self.people_near((a.x + b.x) / 2, (a.y + b.y) / 2, 5.0):
            if isinstance(o, Agent) and o not in (a, b):
                o.memory.add(f"听到{a.name}和{b.name}在聊：{summary}", "observation", now, 3, [a.id, b.id])
        rec = {"id": cid, "a": a.id, "b": b.id, "names": [a.name, b.name], "stamp": self.clock.stamp(), "location": self.loc_name(a.location), "lines": [{"name": self.name_of(l["speaker"]), **l} for l in lines], "summary": summary, "commitments": commits}
        self.conv_log.append(rec)
        self.log(f"💬 {a.name} 和 {b.name}：{summary}" + (f"（约定：{'；'.join(commits)}）" if commits else ""), "conversation", [a.id, b.id])
        self.emit("agent_update", {"id": a.id})
        self.emit("agent_update", {"id": b.id})

    # ------------------------------------------------------------------ players
    def player_join(self, pid: str, name: str, bio: str, color: str) -> Player:
        name = (name or "旅人").strip()[:12]
        p = self.players.get(pid)
        if not p:
            p = Player(pid, name, bio, color)
            sx, sy = self.map.random_spot("inn", self.rng)
            p.x, p.y = sx + 0.5, sy + 0.5
            self.players[pid] = p
            self.log(f"🧳 {name} 来到了{TOWN_NAME}，住进了云溪民宿", "player", [pid])
            for a in self.agents.values():
                if pid not in a.relations:
                    a.relations[pid] = {"affinity": 30, "desc": "新来镇上的外地人"}
        else:
            p.name, p.bio, p.color = name, bio or p.bio, color or p.color
        self.social.add_user(pid, p.name, p.bio, p.color, False)
        p.online = True
        return p

    def player_move(self, pid: str, x: float, y: float, d: float) -> None:
        p = self.players.get(pid)
        if not p:
            return
        p.x = max(0.5, min(self.map.size - 0.5, float(x)))
        p.y = max(0.5, min(self.map.size - 0.5, float(y)))
        p.dir = float(d)
        loc = self.map.location_at(p.x, p.y)
        p.location = loc.id if loc else None

    async def _greet(self, a: Agent, p: Player) -> None:
        a.busy = True
        try:
            line = await cog.greet_player(self, a, p)
            if p.talking_to:
                return
            self.emit("say", {"speaker": a.id, "name": a.name, "to": p.id, "text": line, "greet": True})
            a.memory.add(f"在{self.loc_name(a.location)}遇见{p.name}，打了招呼：“{line}”", "observation", self.clock.minutes, 2, [p.id])
        finally:
            a.busy = False

    def player_chat_start(self, pid: str, aid: str) -> str | None:
        p = self.players.get(pid)
        a = self.agents.get(aid)
        if not p or not a:
            return "找不到这个人"
        if p.talking_to:
            self.player_chat_end(pid)
        if a.dist(p.x, p.y) > 4.0:
            return f"离{a.name}太远了，走近一点吧"
        if a.status == "sleeping":
            return f"{a.name}正在睡觉 😴"
        if a.status == "talking":
            return f"{a.name}正在和别人说话"
        if a.status == "chatting":
            return f"{a.name}正在和{self.name_of(a.chat_partner or '')}聊天，稍等一下吧"
        a.status = "talking"
        a.chat_partner = pid
        a.path = []
        a.face = (p.x, p.y)
        a.emoji = "💬"
        a.activity = f"和{p.name}聊天"
        p.talking_to = aid
        p.history = []
        p.last_chat = time.time()
        self.emit("chat_open", {"agent": a.detail()}, to=pid)
        return None

    def player_chat_say(self, pid: str, text: str) -> None:
        p = self.players.get(pid)
        if not p or not p.talking_to or p.waiting:
            return
        text = text.strip()[:300]
        if not text:
            return
        a = self.agents[p.talking_to]
        p.last_chat = time.time()
        a.face = (p.x, p.y)
        self.emit("say", {"speaker": pid, "name": p.name, "to": a.id, "text": text})
        self.spawn(self._player_reply(p, a, text))

    async def _player_reply(self, p: Player, a: Agent, text: str) -> None:
        p.waiting = True
        self.emit("chat_typing", {"agent": a.id}, to=p.id)
        try:
            hist = list(p.history)
            p.history.append({"from": p.id, "text": text})
            res = await cog.player_reply(self, a, p, hist, text)
            if p.talking_to != a.id:
                return
            p.history.append({"from": a.id, "text": res["reply"]})
            p.last_chat = time.time()
            self.emit("chat_msg", {"agent": a.id, **res}, to=p.id)
            self.emit("say", {"speaker": a.id, "name": a.name, "to": p.id, "text": res["reply"]})
        finally:
            p.waiting = False

    def player_chat_end(self, pid: str) -> None:
        p = self.players.get(pid)
        if not p or not p.talking_to:
            return
        a = self.agents.get(p.talking_to)
        hist = p.history
        p.talking_to = None
        p.history = []
        self.emit("chat_close", {}, to=pid)
        if a:
            a.status = "acting"
            a.chat_partner = None
            a.face = None
            a.target_loc = None
            a.block_key = None
            if hist:
                self.log(f"🗨️ {p.name} 和 {a.name} 聊了 {len(hist) // 2} 轮", "player", [pid, a.id])
                self.spawn(cog.summarize_player_chat(self, a, p, hist))

    # ------------------------------------------------------------------ social wrappers
    def post_view(self, post: dict) -> dict:
        return {
            **post,
            "author_name": self.name_of(post["author"]),
            "author_color": self.social.users.get(post["author"], {}).get("color", "#888"),
            "is_npc": post["author"] in self.agents,
            "stamp": self.clock.stamp(post["t"]),
            "location_name": self.loc_name(post.get("location")) if post.get("location") else "",
            "like_names": [self.name_of(u) for u in post["likes"]],
            "comments": [{**c, "author_name": self.name_of(c["author"]), "stamp": self.clock.stamp(c["t"])} for c in post["comments"]],
        }

    def _poke(self, uid: str, minutes: int = 10) -> None:
        a = self.agents.get(uid)
        if a:
            # 被 @/评论时会更早看手机，但两次刷手机之间至少隔 40 游戏分钟，避免 NPC 之间无限互评
            a.next_phone = max(min(a.next_phone, self.clock.minutes + self.rng.randint(3, minutes)), a.last_phone + 40)

    def social_post(self, uid: str, text: str) -> dict:
        loc = None
        if uid in self.agents:
            loc = self.agents[uid].location
        elif uid in self.players:
            loc = self.players[uid].location
        post = self.social.create_post(uid, text, self.clock.minutes, loc)
        self.emit("social", {"kind": "post", "post": self.post_view(post)})
        self.log(f"📱 {self.name_of(uid)} 发布动态：{text[:60]}", "social", [uid])
        for name in MENTION_RE.findall(text):
            mid = self.social.name_to_id(name)
            if mid:
                self._poke(mid, 8)
        if uid in self.agents:
            self.agents[uid].memory.add(f"在小镇圈发了帖子：{text[:60]}", "social", self.clock.minutes, 3)
        return post

    def social_like(self, uid: str, pid: int) -> dict | None:
        p = self.social.like(uid, pid, self.clock.minutes)
        if p:
            self.emit("social", {"kind": "update", "post": self.post_view(p)})
            if uid in self.agents and p["author"] in self.agents and uid in p["likes"]:
                self.agents[p["author"]].memory.add(f"{self.name_of(uid)}给我的帖子点了赞", "social", self.clock.minutes, 1, [uid])
        return p

    def social_comment(self, uid: str, pid: int, text: str) -> dict | None:
        c = self.social.comment(uid, pid, text, self.clock.minutes)
        if c:
            p = self.social.get_post(pid)
            self.emit("social", {"kind": "update", "post": self.post_view(p)})
            self.log(f"💭 {self.name_of(uid)} 评论了 {self.name_of(p['author'])} 的动态：{text[:50]}", "social", [uid, p["author"]])
            if p["author"] != uid:
                self._poke(p["author"], 15 if uid in self.agents else 6)
                if p["author"] in self.agents:
                    self.agents[p["author"]].memory.add(f"{self.name_of(uid)}在我的帖子下评论：{text[:50]}", "social", self.clock.minutes, 4, [uid])
            for name in MENTION_RE.findall(text):
                mid = self.social.name_to_id(name)
                if mid:
                    self._poke(mid, 8)
        return c

    def social_follow(self, uid: str, target: str) -> bool:
        res = self.social.follow(uid, target, self.clock.minutes)
        if res:
            self.log(f"➕ {self.name_of(uid)} 关注了 {self.name_of(target)}", "social", [uid, target])
            if target in self.agents:
                self.agents[target].memory.add(f"{self.name_of(uid)}在小镇圈关注了我", "social", self.clock.minutes, 2, [uid])
        self.emit("social", {"kind": "follow", "from": uid, "to": target, "on": res})
        return res

    def social_dm(self, frm: str, to: str, text: str) -> dict:
        msg = self.social.send_dm(frm, to, text, self.clock.minutes)
        view = {**msg, "from_name": self.name_of(frm), "to_name": self.name_of(to), "stamp": self.clock.stamp(msg["t"])}
        self.emit("dm", {"msg": view}, to=to)
        self.emit("dm", {"msg": view}, to=frm)
        if to in self.agents and frm not in self.agents:
            self.spawn(self._dm_reply_later(to, frm))
        return view

    async def _dm_reply_later(self, aid: str, frm: str) -> None:
        a = self.agents[aid]
        await asyncio.sleep(self.rng.uniform(1.5, 4.0) if a.status != "sleeping" else 2.0)
        if a.status == "sleeping":
            self.social_dm(aid, frm, "（自动回复）我已经睡了，明天再聊 😴")
            a.memory.add(f"睡觉时收到{self.name_of(frm)}的私信：{self.social.dm_thread(aid, frm, 1)[-1]['text'][:40]}", "social", self.clock.minutes, 4, [frm])
            return
        await cog.dm_reply(self, a, frm)

    # ------------------------------------------------------------------ world control
    def _pick_weather(self) -> str:
        total = sum(w for _, w in WEATHERS)
        r = self.rng.uniform(0, total)
        for name, w in WEATHERS:
            r -= w
            if r <= 0:
                return name
        return "晴"

    def set_weather(self, w: str) -> None:
        if w == self.weather:
            return
        self.weather = w
        for a in self.agents.values():
            a.memory.add(f"天气变成了{w}", "observation", self.clock.minutes, 2)
        self.log(f"🌦️ 天气变为：{w}", "world")
        self.emit("weather", {"weather": w})

    def inject_event(self, text: str, location: str | None = None, importance: int = 7, by: str | None = None) -> None:
        text = text.strip()[:200]
        if not text:
            return
        if location and location not in self.map.locations:
            location = None
        place = self.loc_name(location) if location else "全镇"
        self.log(f"⚡ 事件（{place}）：{text}", "event")
        self.emit("world_event", {"text": text, "location": location})
        reactors = []
        for a in self.agents.values():
            if location:
                loc = self.map.locations[location]
                cx, cy = loc.center()
                near = a.dist(cx, cy) < 9
                prefix = "亲眼看到" if near else "听说"
                imp = importance if near else max(3, importance - 2)
            else:
                near, prefix, imp = True, "得知", importance
            a.memory.add(f"{prefix}{place}发生了：{text}", "event", self.clock.minutes, imp)
            if a.status != "sleeping" and not a.busy and (near or self.rng.random() < 0.5):
                reactors.append(a)
        self.rng.shuffle(reactors)
        for i, a in enumerate(reactors[:8]):
            a.busy = True
            self.spawn(self._delayed(i * 0.6, cog.react_event(self, a, text, location)))

    async def _delayed(self, delay: float, coro) -> None:
        await asyncio.sleep(delay)
        await coro

    def set_speed(self, speed: float | None = None, paused: bool | None = None) -> None:
        if speed is not None:
            self.clock.speed = max(0.25, min(20.0, float(speed)))
        if paused is not None:
            self.clock.paused = bool(paused)

    def skip_to(self, hhmm_str: str) -> None:
        from .world.clock import parse_hhmm

        m = parse_hhmm(hhmm_str)
        if m is None:
            return
        cur = self.clock.minute_of_day
        delta = (m - cur) % 1440
        self.clock.minutes += delta
        for a in self.agents.values():
            if a.status in ("chatting", "talking"):
                continue
            b = a.current_block()
            if b["location"] in self.map.locations:
                sx, sy = self.map.random_spot(b["location"], a.rng)
                a.x, a.y = sx + 0.5, sy + 0.5
                a.path = []
                a.target_loc = b["location"]
                a.block_key = None
        self.log(f"⏩ 时间跳到了 {self.clock.label()}", "world")

    # ------------------------------------------------------------------ connections
    def connect(self, ws, pid: str | None) -> None:
        self.clients[ws] = pid

    def disconnect(self, ws) -> None:
        pid = self.clients.pop(ws, None)
        if pid and pid not in self.clients.values():
            p = self.players.get(pid)
            if p:
                self.player_chat_end(pid)
                p.online = False

    def init_payload(self, pid: str | None) -> dict:
        return {
            "t": "init",
            "town": TOWN_NAME,
            "map": self.map.to_dict(),
            "agents": [{**a.static_info(), **a.brief()} for a in self.agents.values()],
            "players": [p.brief() for p in self.players.values() if p.online],
            "me": self.players[pid].to_dict() if pid and pid in self.players else None,
            "weather": self.weather,
            "logs": list(self.logs)[-80:],
            "llm": llm.status(),
        }

    # ------------------------------------------------------------------ persistence
    def to_dict(self) -> dict:
        return {
            "version": 1,
            "clock": self.clock.to_dict(),
            "weather": self.weather,
            "last_weather_day": self.last_weather_day,
            "agents": {k: a.to_dict() for k, a in self.agents.items()},
            "players": {k: p.to_dict() for k, p in self.players.items()},
            "social": self.social.to_dict(),
            "logs": list(self.logs),
            "conv_log": list(self.conv_log),
        }

    def load(self, d: dict) -> None:
        self.clock.load(d.get("clock", {}))
        self.weather = d.get("weather", "晴")
        self.last_weather_day = d.get("last_weather_day", self.clock.day)
        for k, ad in d.get("agents", {}).items():
            if k in self.agents:
                self.agents[k].load(ad)
        for k, pd in d.get("players", {}).items():
            p = Player(k, pd["name"], pd.get("bio", ""), pd.get("color", "#4f9dff"))
            p.x, p.y = pd.get("x", p.x), pd.get("y", p.y)
            self.players[k] = p
        self.social.load(d.get("social", {}))
        self.logs = deque(d.get("logs", []), maxlen=400)
        self.conv_log = deque(d.get("conv_log", []), maxlen=150)

    def save(self, key: str = "world") -> None:
        self.last_save = time.time()
        try:
            self.store.save(key, self.to_dict())
        except Exception:  # noqa: BLE001
            log.exception("保存失败")

    def reset(self) -> None:
        self.store.delete("world")
        self.reset_from(None)

    def reset_from(self, data: dict | None) -> None:
        for t in list(self.tasks):
            t.cancel()
        clients = self.clients
        self._init_state()
        if data:
            self.load(data)
        self.clients = clients
        for ws in clients:
            self.clients[ws] = None
        self.emit("reload", {})
