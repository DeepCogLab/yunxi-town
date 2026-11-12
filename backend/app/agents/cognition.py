"""智能体认知：日程规划、NPC 间对话、与玩家对话、反思、刷小镇圈、对事件的反应。

每个函数在大模型不可用 / 失败时都有规则兜底，保证小镇始终能运转。
"""
from __future__ import annotations

import random
from typing import TYPE_CHECKING

from ..llm import as_list, llm
from ..world.clock import hhmm, parse_hhmm
from ..world.personas import TOWN_DESC, TOWN_NAME, default_plan
from .agent import Agent, normalize_plan
from .memory import format_memories

if TYPE_CHECKING:
    from ..sim import Player, World

SYSTEM = f"你是一个生成式智能体小镇模拟器的角色扮演引擎。小镇背景：{TOWN_DESC} 你要让角色言行符合设定、有生活气息、有个人情绪和小心思，避免空洞客套和说教。"


# ---------------------------------------------------------------------- blocks
def persona_block(a: Agent) -> str:
    p = a.p
    return (
        f"姓名：{a.name}，{p['age']}岁，{p['occupation']}。\n"
        f"性格：{p['personality']}\n背景：{p['background']}\n说话风格：{p['speech']}\n"
        f"家：{a.world.loc_name(p['home'])}；工作地点：{a.world.loc_name(p['work'])}；作息：{p['wake']} 起床，{p['sleep']} 睡觉。\n"
        f"当前心情：{a.mood}"
    )


def relations_block(a: Agent, only: list[str] | None = None, n: int = 8) -> str:
    items = [(k, v) for k, v in a.relations.items() if only is None or k in only]
    items.sort(key=lambda kv: -kv[1]["affinity"])
    if not items:
        return "（无）"
    return "\n".join(f"- {a.world.name_of(k)}：好感 {v['affinity']}/100，{v['desc']}" for k, v in items[:n])


def locations_block(w: "World") -> str:
    return "\n".join(f"- {l.id}：{l.name}（{l.desc}）" for l in w.map.locations.values())


def situation(w: "World", a: Agent) -> str:
    return f"现在是{w.clock.label()}（{w.clock.period()}），天气{w.weather}。{a.name}在{w.loc_name(a.location)}，正在{a.activity}。"


def mems(w: "World", a: Agent, query: str, k: int = 8, person: str | None = None) -> str:
    return format_memories(a.memory.retrieve(query, w.clock.minutes, k, person), w.clock.stamp)


# ---------------------------------------------------------------------- plan
async def plan_day(w: "World", a: Agent) -> None:
    a.planning = True
    try:
        commits = a.todays_commitments()
        commit_txt = "\n".join(f"- {c['start']} 在 {c['location']}：{c['activity']}" for c in commits) or "（无）"
        refl = format_memories(a.memory.recent(4, ("reflection",)), w.clock.stamp)
        recent = format_memories(sorted(a.memory.items[-60:], key=lambda m: -m.importance)[:8], w.clock.stamp)
        user = f"""{persona_block(a)}

今天是{w.clock.label()}，天气：{w.weather}。
最近的感悟：
{refl}
最近的重要记忆：
{recent}
人际关系：
{relations_block(a)}
今天已有的约定（必须安排进日程）：
{commit_txt}

可以去的地点（location 必须使用这些 id）：
{locations_block(w)}

请为{a.name}制定今天从起床（{a.p['wake']}）到睡觉（{a.p['sleep']}）的详细日程，8~14 个时间段，符合职业与性格，并结合最近的记忆/约定/心事安排一些有个人色彩的活动（比如去找某人、准备某件事）。
输出 JSON：{{"summary": "一句话描述今天的心情和主要目标", "plan": [{{"start": "HH:MM", "end": "HH:MM", "location": "地点id", "activity": "具体在做什么（15字以内）", "emoji": "一个emoji"}}]}}"""
        data = await llm.json(SYSTEM, user, max_tokens=1200, temperature=0.9)
        blocks = as_list(data.get("plan")) if data else []
        if len(blocks) >= 4:
            # 用默认日程补上睡眠时段
            wake = parse_hhmm(a.p["wake"]) or 420
            sleep = parse_hhmm(a.p["sleep"]) or 1380
            full = [{"start": "00:00", "end": hhmm(wake), "location": a.p["home"], "activity": "睡觉", "emoji": "😴"}] + blocks
            if sleep > wake:
                full.append({"start": hhmm(sleep), "end": "23:59", "location": a.p["home"], "activity": "睡觉", "emoji": "😴"})
            a.plan = normalize_plan(full, a.p, set(w.map.locations))
            a.plan_summary = str(data.get("summary", ""))[:80] or "新的一天"
        else:
            a.plan = normalize_plan(default_plan(a.p), a.p, set(w.map.locations))
            a.plan_summary = "按平常的习惯过一天"
        for c in commits:
            s = parse_hhmm(c["start"])
            if s is not None:
                a.insert_block(s, s + 75, c["location"], c["activity"], "🤝", c.get("with"))
        a.plan_day = w.clock.day
        a.block_key = None
        a.target_loc = None
        a.memory.add(f"今天的计划：{a.plan_summary}", "plan", w.clock.minutes, 3)
        a.thought = a.plan_summary
        w.log(f"{a.name} 制定了今天的计划：{a.plan_summary}", "plan", [a.id])
        w.emit("agent_update", {"id": a.id})
    finally:
        a.planning = False


# ---------------------------------------------------------------------- npc <-> npc
MOCK_LINES = [
    ("早啊，{b}！今天{weather}，心情怎么样？", "还行还行，正准备去{loc}呢。你呢？"),
    ("{b}，好巧，在这儿碰到你。", "是啊，最近忙吗？"),
    ("听说镇上最近要办活动，你知道吗？", "略有耳闻，到时候一起去看看？"),
]


async def npc_dialogue(w: "World", a: Agent, b: Agent) -> dict:
    topic_q = f"{b.name} {a.activity} {b.activity} {w.loc_name(a.location)}"
    user = f"""{situation(w, a)} {b.name}也在附近，正在{b.activity}。

【角色A】
{persona_block(a)}
A 对 B 的看法：{a.rel(b.id)['desc']}（好感 {a.rel(b.id)['affinity']}/100）
A 的相关记忆：
{mems(w, a, topic_q, 6, b.id)}

【角色B】
{persona_block(b)}
B 对 A 的看法：{b.rel(a.id)['desc']}（好感 {b.rel(a.id)['affinity']}/100）
B 的相关记忆：
{mems(w, b, topic_q, 6, a.id)}

两人偶遇，由 A 先开口，进行一段自然的生活化对话（4~8 句，每句不超过 40 字），话题应来自他们的记忆、近况、小镇八卦、小镇圈上的动态或当下场景，可以有情绪、分歧或约定。
如果对话中约好了之后一起做什么，写进 commitments（location 用地点 id：{', '.join(w.map.locations)}）。
输出 JSON：{{"dialogue": [{{"speaker": "A或B", "text": "..."}}], "summary": "一句话概括对话内容", "importance": 1到10, "a_affinity": -5到5的整数, "b_affinity": -5到5, "a_mood": "A对话后的心情（4字内）", "b_mood": "...", "a_view_of_b": "A 对 B 的最新看法（20字内）", "b_view_of_a": "...", "commitments": [{{"time": "HH:MM", "day": "today或tomorrow", "location": "地点id", "activity": "一起做什么"}}]}}"""
    data = await llm.json(SYSTEM, user, max_tokens=900)
    if data and as_list(data.get("dialogue")):
        lines = []
        for t in as_list(data["dialogue"])[:10]:
            if not isinstance(t, dict) or not t.get("text"):
                continue
            spk = a if str(t.get("speaker", "A")).strip().upper().startswith("A") or t.get("speaker") == a.name else b
            lines.append({"speaker": spk.id, "text": str(t["text"])[:80]})
        if lines:
            data["lines"] = lines
            return data
    # 兜底
    first, second = random.choice(MOCK_LINES)
    fmt = {"b": b.name, "weather": w.weather, "loc": w.loc_name(b.current_block()["location"])}
    return {
        "lines": [{"speaker": a.id, "text": first.format(**fmt)}, {"speaker": b.id, "text": second.format(**fmt)}],
        "summary": f"{a.name}和{b.name}寒暄了几句",
        "importance": 2, "a_affinity": 1, "b_affinity": 1, "commitments": [],
    }


# ---------------------------------------------------------------------- player
async def player_reply(w: "World", a: Agent, player: "Player", history: list[dict], text: str) -> dict:
    rel = a.rel(player.id)
    sysmsg = f"""{SYSTEM}
你现在扮演{a.name}，用第一人称和玩家角色“{player.name}”面对面聊天。
{persona_block(a)}
{situation(w, a)}
你对{player.name}的了解：{rel['desc']}（好感 {rel['affinity']}/100）。{player.name}的自我介绍：{player.bio or '暂无'}
你的人际关系：
{relations_block(a, n=6)}
与当前话题相关的记忆：
{mems(w, a, text + ' ' + player.name, 8, player.id)}

要求：完全以{a.name}的身份、语气回答，口语化，每次 1~3 句话（不超过 80 字）；可以有自己的情绪、立场和秘密，不要无条件顺从；不要提到自己是 AI。
输出 JSON：{{"reply": "说的话", "emoji": "一个表情emoji", "action": "可选的简短动作描写，如 递过一杯咖啡，没有则为空字符串"}}"""
    msgs = [{"role": "system", "content": sysmsg}]
    for h in history[-12:]:
        msgs.append({"role": "user" if h["from"] == player.id else "assistant", "content": h["text"]})
    msgs.append({"role": "user", "content": text})
    raw = await llm.chat(msgs, max_tokens=300, temperature=0.9)
    if raw:
        from ..llm import extract_json

        data = extract_json(raw)
        if data and data.get("reply"):
            return {"reply": str(data["reply"])[:200], "emoji": str(data.get("emoji", ""))[:4], "action": str(data.get("action", "") or "")[:40]}
        return {"reply": raw[:200], "emoji": "", "action": ""}
    canned = ["嗯嗯，我在听。", f"{player.name}，你说的挺有意思的。", "哈哈，是吗？", "这个嘛……让我想想。"]
    return {"reply": random.choice(canned), "emoji": "🙂", "action": ""}


async def summarize_player_chat(w: "World", a: Agent, player: "Player", history: list[dict]) -> None:
    if not history:
        return
    transcript = "\n".join(f"{player.name if h['from'] == player.id else a.name}：{h['text']}" for h in history[-30:])
    rel = a.rel(player.id)
    user = f"""{persona_block(a)}
{a.name} 刚刚和 {player.name} 聊完天，对话如下：
{transcript}

此前{a.name}对{player.name}的看法：{rel['desc']}（好感 {rel['affinity']}）。
请站在{a.name}的视角总结。如果对话中约定了之后见面/一起做事，写进 commitments（location 用地点 id：{', '.join(w.map.locations)}）。
输出 JSON：{{"summary": "一句话记住这次对话（第三人称）", "importance": 1到10, "affinity_change": -8到8的整数, "view": "对{player.name}的最新看法（20字内）", "mood": "现在的心情（4字内）", "commitments": [{{"time": "HH:MM", "day": "today或tomorrow", "location": "地点id", "activity": "做什么"}}]}}"""
    data = await llm.json(SYSTEM, user, max_tokens=500) or {}
    summary = str(data.get("summary") or f"和{player.name}聊了一会儿天")
    a.memory.add(f"和{player.name}聊天：{summary}", "chat", w.clock.minutes, int(data.get("importance") or 4), [player.id])
    a.change_affinity(player.id, int(data.get("affinity_change") or 2))
    if data.get("view"):
        a.rel(player.id)["desc"] = str(data["view"])[:40]
    if data.get("mood"):
        a.mood = str(data["mood"])[:8]
    for c in as_list(data.get("commitments")):
        if isinstance(c, dict):
            desc = a.add_commitment(str(c.get("time", "")), str(c.get("location", "")), str(c.get("activity", "见面")), [player.id], 1 if c.get("day") == "tomorrow" else 0)
            if desc:
                w.notify_player(player.id, f"📌 {a.name} 记下了约定：{desc}")
                w.log(f"{a.name} 与 {player.name} 约定：{desc}", "commit", [a.id, player.id])
    w.emit("agent_update", {"id": a.id})


async def greet_player(w: "World", a: Agent, player: "Player") -> str:
    rel = a.rel(player.id)
    user = f"""{persona_block(a)}
{situation(w, a)}
{player.name}（{rel['desc']}，好感 {rel['affinity']}）走到了{a.name}身边。相关记忆：
{mems(w, a, player.name, 4, player.id)}
以{a.name}的口吻，说一句自然的招呼（20 字以内，符合关系亲疏和当下正在做的事）。输出 JSON：{{"line": "..."}}"""
    data = await llm.json(SYSTEM, user, max_tokens=120)
    if data and data.get("line"):
        return str(data["line"])[:60]
    return random.choice([f"嗨，{player.name}！", "哟，你也在这儿？", "今天天气不错呀。"])


# ---------------------------------------------------------------------- reflection
async def reflect(w: "World", a: Agent) -> None:
    a.busy = True
    try:
        recent = format_memories(a.memory.recent(30), w.clock.stamp)
        user = f"""{persona_block(a)}
{a.name}最近的记忆：
{recent}

人际关系：
{relations_block(a)}

请以{a.name}的视角，从这些记忆中提炼 2~3 条更高层次的感悟/判断（关于自己、他人或小镇），并更新对相关人物的看法。
输出 JSON：{{"insights": [{{"text": "感悟（30字内）", "importance": 1到10}}], "mood": "当前心情（4字内）", "thought": "此刻心里的一句内心独白", "relations": [{{"name": "人物姓名", "view": "最新看法（20字内）"}}]}}"""
        data = await llm.json(SYSTEM, user, max_tokens=600)
        a.last_reflect_t = w.clock.minutes
        if not data:
            return
        for ins in as_list(data.get("insights"))[:3]:
            if isinstance(ins, dict) and ins.get("text"):
                a.memory.add(str(ins["text"]), "reflection", w.clock.minutes, int(ins.get("importance") or 6))
        if data.get("mood"):
            a.mood = str(data["mood"])[:8]
        if data.get("thought"):
            a.thought = str(data["thought"])[:80]
        for r in as_list(data.get("relations")):
            if isinstance(r, dict) and r.get("name") and r.get("view"):
                uid = w.social.name_to_id(str(r["name"]))
                if uid and uid != a.id:
                    a.rel(uid)["desc"] = str(r["view"])[:40]
        w.log(f"{a.name} 陷入沉思：{a.thought}", "reflect", [a.id])
        w.emit("agent_update", {"id": a.id})
    finally:
        a.busy = False


# ---------------------------------------------------------------------- social
MOCK_POSTS = [
    "今天的云溪镇也很安静呢 #云溪日常#",
    "{loc}的{period}真舒服～",
    "忙完一天，累但充实。",
    "有没有人晚上一起去广场散步？",
]


def _post_line(w: "World", p: dict) -> str:
    cm = "；".join(f"{w.name_of(c['author'])}：{c['text']}" for c in p["comments"][-3:])
    return f"[#{p['id']}] {w.name_of(p['author'])}（{w.clock.stamp(p['t'])}）：{p['text']}（赞{len(p['likes'])}，评论{len(p['comments'])}{'：' + cm if cm else ''}）"


async def social_session(w: "World", a: Agent) -> None:
    """智能体刷“小镇圈”：读动态、通知、发帖、点赞、评论、关注、改计划。"""
    a.busy = True
    try:
        s = w.social
        feed = s.feed_for_agent(a.id, 8)
        notes = s.unread_notifications(a.id, mark=True)
        my_posts = [p for p in s.posts[-200:] if p["author"] == a.id][-3:]
        note_txt = "\n".join(f"- {w.name_of(n['from'])} {dict(like='赞了你', comment='评论了你', mention='提到了你', reply='回复了你', follow='关注了你').get(n['kind'], n['kind'])}：{n['text']}（帖子#{n['post_id']}）" for n in notes[-8:]) or "（无）"
        feed_txt = "\n".join(_post_line(w, p) for p in feed) or "（暂时没有新动态）"
        mine_txt = "\n".join(_post_line(w, p) for p in my_posts) or "（无）"
        following = ", ".join(w.name_of(u) for u in s.follows.get(a.id, ())) or "无"
        trending = "、".join(t["tag"] for t in s.trending(w.clock.minutes, 5)) or "无"
        user = f"""{persona_block(a)}
{situation(w, a)}
{a.name}拿起手机打开了“小镇圈”（小镇居民的社交 App）。
最近的记忆：
{format_memories(a.memory.recent(8), w.clock.stamp)}
人际关系：
{relations_block(a, n=6)}
已关注：{following}；当前热搜话题：{trending}
新通知：
{note_txt}
自己最近发的帖子：
{mine_txt}
信息流：
{feed_txt}

请决定{a.name}这次刷手机做什么。要符合人设：爱分享的人多发帖，内向的人多潜水。发帖内容应来自自己真实的生活/记忆/情绪/想法（可以用 #话题# 和 @某人），不要重复以前发过的内容；有人评论或@自己时通常会回复。
如果看到感兴趣的活动/邀约想去参加，用 plan_change 改今天的计划（location 用地点 id：{', '.join(w.map.locations)}）。
输出 JSON：{{"post": "要发的新帖子，不发则为空字符串", "likes": [帖子id], "comments": [{{"post_id": 帖子id, "text": "评论内容（40字内）"}}], "follow": ["要关注的人名"], "plan_change": null 或 {{"start": "HH:MM", "end": "HH:MM", "location": "地点id", "activity": "做什么"}}, "thought": "看完手机的内心想法（20字内）"}}"""
        data = await llm.json(SYSTEM, user, max_tokens=700, temperature=0.95)
        if data is None:
            if random.random() < 0.35:
                w.social_post(a.id, random.choice(MOCK_POSTS).format(loc=w.loc_name(a.location), period=w.clock.period()))
            for p in feed[:2]:
                if random.random() < 0.4:
                    w.social_like(a.id, p["id"])
            return
        valid_ids = {p["id"] for p in feed} | {p["id"] for p in my_posts}  # 自己帖子下的评论视为“回复” | {n["post_id"] for n in notes if n.get("post_id")}
        post = str(data.get("post") or "").strip()
        if post and len(post) > 2:
            w.social_post(a.id, post)
        for pid in as_list(data.get("likes"))[:4]:
            try:
                pid = int(pid)
            except (TypeError, ValueError):
                continue
            p = s.get_post(pid)
            if pid in valid_ids and p and a.id not in p["likes"]:
                w.social_like(a.id, pid)
        for c in as_list(data.get("comments"))[:3]:
            if isinstance(c, dict) and c.get("text"):
                try:
                    pid = int(c.get("post_id"))
                except (TypeError, ValueError):
                    continue
                if pid in valid_ids:
                    w.social_comment(a.id, pid, str(c["text"]))
        for name in as_list(data.get("follow"))[:2]:
            uid = s.name_to_id(str(name))
            if uid and uid != a.id and uid not in s.follows.get(a.id, set()):
                w.social_follow(a.id, uid)
        pc = data.get("plan_change")
        if isinstance(pc, dict):
            _apply_plan_change(w, a, pc, "看到小镇圈的动态后改变了计划")
        for p in feed[:3]:
            a.memory.add(f"在小镇圈看到{w.name_of(p['author'])}发帖：{p['text'][:60]}", "social", w.clock.minutes, 3 if a.rel(p["author"])["affinity"] < 60 else 4, [p["author"]])
        if data.get("thought"):
            a.thought = str(data["thought"])[:60]
        w.emit("agent_update", {"id": a.id})
    finally:
        a.busy = False


async def dm_reply(w: "World", a: Agent, frm: str) -> None:
    thread = w.social.dm_thread(a.id, frm, 16)
    if not thread:
        return
    other = w.name_of(frm)
    rel = a.rel(frm)
    convo = "\n".join(f"{w.name_of(m['from'])}：{m['text']}" for m in thread)
    user = f"""{persona_block(a)}
{situation(w, a)}
{other}（你对TA的看法：{rel['desc']}，好感 {rel['affinity']}）在小镇圈给你发了私信。相关记忆：
{mems(w, a, thread[-1]['text'] + ' ' + other, 6, frm)}
私信记录：
{convo}

以{a.name}的身份回复（口语化，1~3 句，60 字以内，像真人发消息）。如果约定了见面，写进 commitment（location 用地点 id：{', '.join(w.map.locations)}）。
输出 JSON：{{"reply": "...", "commitment": null 或 {{"time": "HH:MM", "day": "today或tomorrow", "location": "地点id", "activity": "做什么"}}, "memory": "一句话记住这次私信"}}"""
    data = await llm.json(SYSTEM, user, max_tokens=400)
    reply = str((data or {}).get("reply") or random.choice(["收到～", "好的呀", "哈哈，晚点聊"]))
    w.social_dm(a.id, frm, reply)
    a.memory.add(str((data or {}).get("memory") or f"和{other}私信聊天：{thread[-1]['text'][:40]}"), "social", w.clock.minutes, 4, [frm])
    c = (data or {}).get("commitment")
    if isinstance(c, dict):
        desc = a.add_commitment(str(c.get("time", "")), str(c.get("location", "")), str(c.get("activity", "见面")), [frm], 1 if c.get("day") == "tomorrow" else 0)
        if desc:
            w.notify_player(frm, f"📌 {a.name} 记下了约定：{desc}")
            w.log(f"{a.name} 通过私信与 {other} 约定：{desc}", "commit", [a.id, frm])


# ---------------------------------------------------------------------- events
async def react_event(w: "World", a: Agent, text: str, where: str | None) -> None:
    a.busy = True
    try:
        place = w.loc_name(where) if where else "全镇"
        user = f"""{persona_block(a)}
{situation(w, a)}
当前日程：{a.current_block()['activity']}（到 {hhmm(a.current_block()['e'])}）
{a.name}得知了一件事（发生在{place}）：{text}
相关记忆：
{mems(w, a, text, 5)}

{a.name}会如何反应？是否要改变接下来的计划（例如去现场看看、去帮忙、躲开）？是否会在小镇圈发帖？
输出 JSON：{{"thought": "内心想法（30字内）", "mood": "心情（4字内）", "plan_change": null 或 {{"start": "HH:MM", "end": "HH:MM", "location": "地点id", "activity": "做什么"}}, "post": "要发的帖子，不发为空字符串"}}
地点 id：{', '.join(w.map.locations)}"""
        data = await llm.json(SYSTEM, user, max_tokens=400)
        if not data:
            return
        if data.get("thought"):
            a.thought = str(data["thought"])[:60]
            a.memory.add(f"对“{text[:30]}”的想法：{a.thought}", "thought", w.clock.minutes, 4)
        if data.get("mood"):
            a.mood = str(data["mood"])[:8]
        pc = data.get("plan_change")
        if isinstance(pc, dict):
            _apply_plan_change(w, a, pc, f"因为“{text[:20]}”改变了计划")
        post = str(data.get("post") or "").strip()
        if post:
            w.social_post(a.id, post)
        w.emit("agent_update", {"id": a.id})
    finally:
        a.busy = False


def _apply_plan_change(w: "World", a: Agent, pc: dict, reason: str) -> None:
    s = parse_hhmm(str(pc.get("start", "")))
    e = parse_hhmm(str(pc.get("end", "")))
    loc = str(pc.get("location", ""))
    if s is None or loc not in w.map.locations:
        return
    now = w.clock.minute_of_day
    s = max(s, now)
    if e is None or e <= s:
        e = s + 60
    e = min(e, s + 240, 1440)
    act = str(pc.get("activity", "去看看"))[:30]
    for b in a.plan:  # 已有相同安排则不重复
        if b["location"] == loc and b["s"] <= s < b["e"] and b["emoji"] in ("✨", "🤝"):
            return
    a.insert_block(s, e, loc, act, "✨")
    a.memory.add(f"{reason}：{hhmm(s)} 去{w.loc_name(loc)}{act}", "plan", w.clock.minutes, 4)
    w.log(f"{a.name} {reason}：{hhmm(s)} 去{w.loc_name(loc)}{act}", "plan", [a.id])
