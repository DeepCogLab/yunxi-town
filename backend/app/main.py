"""FastAPI 入口：WebSocket 实时通道 + REST API + 前端静态文件。"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import FRONTEND_DIST, settings
from .llm import llm
from .sim import World

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("main")

world: World | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global world
    world = World()
    task = asyncio.create_task(world.run())
    log.info("小镇已启动 | 模型：%s", llm.status()["model"])
    try:
        yield
    finally:
        task.cancel()
        world.save()
        log.info("已保存存档")


app = FastAPI(title="云溪镇 · AI 智能体小镇", lifespan=lifespan)


def W() -> World:
    assert world is not None
    return world


# ---------------------------------------------------------------------- websocket
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    w = W()
    pid = ws.query_params.get("pid") or None
    w.connect(ws, None)
    await ws.send_json(w.init_payload(pid if pid in w.players else None))
    try:
        while True:
            msg = await ws.receive_json()
            t = msg.get("t")
            if t == "join":
                pid = str(msg.get("pid") or "")[:40]
                if not pid.startswith("p_"):
                    pid = "p_" + pid
                p = w.player_join(pid, str(msg.get("name", "")), str(msg.get("bio", ""))[:120], str(msg.get("color", "#4f9dff"))[:9])
                w.clients[ws] = pid
                await ws.send_json({"t": "joined", "me": p.to_dict()})
            elif not w.clients.get(ws):
                continue
            elif t == "move":
                w.player_move(w.clients[ws], msg.get("x", 0), msg.get("y", 0), msg.get("d", 0))
            elif t == "chat_start":
                err = w.player_chat_start(w.clients[ws], str(msg.get("agent")))
                if err:
                    await ws.send_json({"t": "batch", "items": [{"t": "toast", "text": err}]})
            elif t == "chat_say":
                w.player_chat_say(w.clients[ws], str(msg.get("text", "")))
            elif t == "chat_end":
                w.player_chat_end(w.clients[ws])
            elif t == "shout":
                p = w.players.get(w.clients[ws])
                text = str(msg.get("text", "")).strip()[:120]
                if p and text:
                    w.emit("say", {"speaker": p.id, "name": p.name, "to": None, "text": text})
                    for o in w.people_near(p.x, p.y, 6):
                        if hasattr(o, "memory"):
                            o.memory.add(f"听到{p.name}说：“{text}”", "observation", w.clock.minutes, 3, [p.id])
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("ws 错误：%s", e)
    finally:
        w.disconnect(ws)


# ---------------------------------------------------------------------- models
class PostIn(BaseModel):
    uid: str
    text: str


class CommentIn(BaseModel):
    uid: str
    text: str


class UidIn(BaseModel):
    uid: str


class DmIn(BaseModel):
    uid: str
    to: str
    text: str


class EventIn(BaseModel):
    text: str
    location: str | None = None
    importance: int = 7


class SpeedIn(BaseModel):
    speed: float | None = None
    paused: bool | None = None


class SkipIn(BaseModel):
    time: str


class WeatherIn(BaseModel):
    weather: str


class SlotIn(BaseModel):
    name: str


def _need_user(uid: str) -> None:
    if uid not in W().social.users:
        raise HTTPException(400, "请先进入小镇创建角色")


# ---------------------------------------------------------------------- world api
@app.get("/api/status")
async def status():
    w = W()
    return {"clock": w.clock.label(), "weather": w.weather, "llm": llm.status(), "agents": len(w.agents), "players": sum(p.online for p in w.players.values()), "tasks": len(w.tasks)}


@app.get("/api/agents")
async def agents():
    return [a.detail() for a in W().agents.values()]


@app.get("/api/agents/{aid}")
async def agent(aid: str):
    a = W().agents.get(aid)
    if not a:
        raise HTTPException(404)
    return a.detail()


@app.get("/api/relations")
async def relations():
    w = W()
    nodes = [{"id": a.id, "name": a.name, "color": a.p["colors"]["shirt"], "npc": True} for a in w.agents.values()]
    nodes += [{"id": p.id, "name": p.name, "color": p.color, "npc": False} for p in w.players.values()]
    edges = []
    for a in w.agents.values():
        for oid, r in a.relations.items():
            if oid in w.agents or oid in w.players:
                edges.append({"from": a.id, "to": oid, "affinity": r["affinity"], "desc": r["desc"]})
    return {"nodes": nodes, "edges": edges}


@app.get("/api/logs")
async def logs(n: int = 150):
    return list(W().logs)[-n:]


@app.get("/api/conversations")
async def conversations(n: int = 40):
    return list(W().conv_log)[-n:][::-1]


@app.get("/api/locations")
async def locations():
    w = W()
    out = []
    for l in w.map.locations.values():
        people = [a.name for a in w.agents.values() if a.location == l.id and a.status != "sleeping"]
        out.append({**l.to_dict(), "people": people})
    return out


@app.post("/api/world/event")
async def world_event(e: EventIn):
    W().inject_event(e.text, e.location, max(1, min(10, e.importance)))
    return {"ok": True}


@app.post("/api/world/speed")
async def world_speed(s: SpeedIn):
    W().set_speed(s.speed, s.paused)
    return W().clock.to_dict()


@app.post("/api/world/skip")
async def world_skip(s: SkipIn):
    W().skip_to(s.time)
    return {"ok": True, "clock": W().clock.label()}


@app.post("/api/world/weather")
async def world_weather(s: WeatherIn):
    W().set_weather(s.weather[:6])
    return {"ok": True}


@app.post("/api/world/save")
async def world_save(s: SlotIn):
    name = "".join(ch for ch in s.name if ch.isalnum() or ch in "-_ ")[:30] or "slot"
    W().save("slot:" + name)
    W().save()
    return {"ok": True, "slots": W().store.list("slot:")}


@app.get("/api/world/slots")
async def world_slots():
    return W().store.list("slot:")


@app.post("/api/world/load")
async def world_load(s: SlotIn):
    w = W()
    data = w.store.load("slot:" + s.name)
    if not data:
        raise HTTPException(404, "存档不存在")
    w.store.save("world", data)
    w.reset_from(data)
    return {"ok": True}


@app.post("/api/world/reset")
async def world_reset():
    W().reset()
    return {"ok": True}


# ---------------------------------------------------------------------- social api
@app.get("/api/social/feed")
async def feed(uid: str | None = None, mode: str = "all", author: str | None = None, n: int = 40):
    w = W()
    return [w.post_view(p) for p in w.social.feed(uid, mode, n, author)]


@app.get("/api/social/trending")
async def trending():
    w = W()
    return w.social.trending(w.clock.minutes)


@app.get("/api/social/users")
async def users(uid: str | None = None):
    w = W()
    mine = w.social.follows.get(uid or "", set())
    out = []
    for u in w.social.users.values():
        d = w.social.user_public(u["id"])
        d["followed"] = u["id"] in mine
        if u["id"] in w.agents:
            a = w.agents[u["id"]]
            d["occupation"] = a.p["occupation"]
            if uid:
                d["affinity"] = a.rel(uid)["affinity"] if uid in a.relations else None
        out.append(d)
    return out


@app.get("/api/social/user/{target}")
async def user_profile(target: str, uid: str | None = None):
    w = W()
    if target not in w.social.users:
        raise HTTPException(404)
    d = w.social.user_public(target)
    d["followed"] = target in w.social.follows.get(uid or "", set())
    d["posts_list"] = [w.post_view(p) for p in w.social.feed(None, "all", 30, target)]
    return d


@app.post("/api/social/post")
async def post(p: PostIn):
    _need_user(p.uid)
    if not p.text.strip():
        raise HTTPException(400, "内容不能为空")
    return W().post_view(W().social_post(p.uid, p.text))


@app.post("/api/social/post/{pid}/like")
async def like(pid: int, u: UidIn):
    _need_user(u.uid)
    p = W().social_like(u.uid, pid)
    if not p:
        raise HTTPException(404)
    return W().post_view(p)


@app.post("/api/social/post/{pid}/comment")
async def comment(pid: int, c: CommentIn):
    _need_user(c.uid)
    if not W().social_comment(c.uid, pid, c.text):
        raise HTTPException(404)
    return W().post_view(W().social.get_post(pid))


@app.post("/api/social/follow/{target}")
async def follow(target: str, u: UidIn):
    _need_user(u.uid)
    return {"following": W().social_follow(u.uid, target)}


@app.get("/api/social/dms")
async def dms(uid: str):
    w = W()
    return [{**t, "name": w.name_of(t["with"]), "color": w.social.users.get(t["with"], {}).get("color", "#888")} for t in w.social.dm_threads(uid)]


@app.get("/api/social/dm/{other}")
async def dm_thread(other: str, uid: str):
    w = W()
    w.social.mark_dm_read(uid, other)
    return [{**m, "from_name": w.name_of(m["from"]), "stamp": w.clock.stamp(m["t"])} for m in w.social.dm_thread(uid, other, 100)]


@app.post("/api/social/dm")
async def send_dm(d: DmIn):
    _need_user(d.uid)
    if d.to not in W().social.users or not d.text.strip():
        raise HTTPException(400)
    return W().social_dm(d.uid, d.to, d.text)


@app.get("/api/social/notifications")
async def notifications(uid: str):
    w = W()
    items = w.social.notifications.get(uid, [])[-50:][::-1]
    out = [{**n, "from_name": w.name_of(n["from"]), "stamp": w.clock.stamp(n["t"])} for n in items]
    for n in items:
        n["read"] = True
    return out


# ---------------------------------------------------------------------- static
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str):
        f = FRONTEND_DIST / path
        if path and f.is_file():
            return FileResponse(f)
        return FileResponse(FRONTEND_DIST / "index.html")
else:

    @app.get("/")
    async def root():
        return JSONResponse({"msg": "前端尚未构建：cd frontend && npm install && npm run build，或用 npm run dev 访问 5173 端口"})
