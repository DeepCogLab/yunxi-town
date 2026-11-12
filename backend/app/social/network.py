"""“小镇圈”社交网络：用户、动态、点赞、评论、关注、私信、通知、热搜。"""
from __future__ import annotations

import re
import time
from collections import Counter

TAG_RE = re.compile(r"#([^\s#，。！？、,.!?@]{1,15})#?")
MENTION_RE = re.compile(r"@([一-龥A-Za-z0-9_]{1,12})")


class Social:
    def __init__(self) -> None:
        self.users: dict[str, dict] = {}
        self.posts: list[dict] = []
        self.follows: dict[str, set[str]] = {}
        self.dms: dict[str, list[dict]] = {}
        self.notifications: dict[str, list[dict]] = {}
        self._pid = 1
        self._cid = 1

    # ------------------------------------------------------------------ users
    def add_user(self, uid: str, name: str, bio: str = "", color: str = "#888", is_npc: bool = True) -> None:
        u = self.users.get(uid)
        if u:
            u.update({"name": name, "bio": bio or u.get("bio", ""), "color": color})
            return
        self.users[uid] = {"id": uid, "name": name, "bio": bio, "color": color, "is_npc": is_npc}
        self.follows.setdefault(uid, set())
        self.notifications.setdefault(uid, [])

    def name_to_id(self, name: str) -> str | None:
        for u in self.users.values():
            if u["name"] == name:
                return u["id"]
        for u in self.users.values():
            if name and (name in u["name"] or u["name"] in name):
                return u["id"]
        return None

    def user_public(self, uid: str) -> dict:
        u = self.users.get(uid, {"id": uid, "name": uid, "bio": "", "color": "#888", "is_npc": False})
        return {
            **u,
            "following": len(self.follows.get(uid, ())),
            "followers": sum(1 for s in self.follows.values() if uid in s),
            "posts": sum(1 for p in self.posts if p["author"] == uid),
        }

    # ------------------------------------------------------------------ posts
    def _notify(self, uid: str, kind: str, frm: str, text: str, post_id: int | None, t: float) -> None:
        if uid == frm or uid not in self.users:
            return
        lst = self.notifications.setdefault(uid, [])
        lst.append({"kind": kind, "from": frm, "text": text[:80], "post_id": post_id, "t": t, "read": False})
        if len(lst) > 100:
            del lst[:-100]

    def create_post(self, author: str, text: str, t: float, location: str | None = None) -> dict:
        text = text.strip()[:400]
        post = {
            "id": self._pid,
            "author": author,
            "text": text,
            "t": t,
            "ts": time.time(),
            "location": location,
            "likes": [],
            "comments": [],
            "tags": TAG_RE.findall(text),
        }
        self._pid += 1
        self.posts.append(post)
        for name in MENTION_RE.findall(text):
            uid = self.name_to_id(name)
            if uid:
                self._notify(uid, "mention", author, text, post["id"], t)
        if len(self.posts) > 1500:
            self.posts = self.posts[-1500:]
        return post

    def get_post(self, pid: int) -> dict | None:
        for p in reversed(self.posts):
            if p["id"] == pid:
                return p
        return None

    def like(self, uid: str, pid: int, t: float) -> dict | None:
        p = self.get_post(pid)
        if not p:
            return None
        if uid in p["likes"]:
            p["likes"].remove(uid)
        else:
            p["likes"].append(uid)
            self._notify(p["author"], "like", uid, p["text"], pid, t)
        return p

    def comment(self, uid: str, pid: int, text: str, t: float) -> dict | None:
        p = self.get_post(pid)
        if not p:
            return None
        c = {"id": self._cid, "author": uid, "text": text.strip()[:200], "t": t}
        self._cid += 1
        p["comments"].append(c)
        self._notify(p["author"], "comment", uid, text, pid, t)
        for name in MENTION_RE.findall(text):
            mid = self.name_to_id(name)
            if mid and mid != p["author"]:
                self._notify(mid, "mention", uid, text, pid, t)
        # 通知此前参与评论的人（楼中楼）
        for oc in p["comments"][:-1]:
            if oc["author"] not in (uid, p["author"]):
                self._notify(oc["author"], "reply", uid, text, pid, t)
        return c

    def follow(self, uid: str, target: str, t: float) -> bool:
        s = self.follows.setdefault(uid, set())
        if target in s:
            s.discard(target)
            return False
        s.add(target)
        self._notify(target, "follow", uid, "关注了你", None, t)
        return True

    # ------------------------------------------------------------------ dms
    @staticmethod
    def _dm_key(a: str, b: str) -> str:
        return "|".join(sorted([a, b]))

    def send_dm(self, frm: str, to: str, text: str, t: float) -> dict:
        msg = {"from": frm, "to": to, "text": text.strip()[:400], "t": t, "ts": time.time(), "read": False}
        lst = self.dms.setdefault(self._dm_key(frm, to), [])
        lst.append(msg)
        if len(lst) > 200:
            del lst[:-200]
        return msg

    def dm_thread(self, a: str, b: str, n: int = 50) -> list[dict]:
        return self.dms.get(self._dm_key(a, b), [])[-n:]

    def dm_threads(self, uid: str) -> list[dict]:
        out = []
        for key, msgs in self.dms.items():
            a, b = key.split("|")
            if uid not in (a, b) or not msgs:
                continue
            other = b if a == uid else a
            unread = sum(1 for m in msgs if m["to"] == uid and not m["read"])
            out.append({"with": other, "last": msgs[-1], "unread": unread})
        out.sort(key=lambda x: x["last"]["ts"], reverse=True)
        return out

    def mark_dm_read(self, uid: str, other: str) -> None:
        for m in self.dms.get(self._dm_key(uid, other), []):
            if m["to"] == uid:
                m["read"] = True

    # ------------------------------------------------------------------ feed
    def feed(self, uid: str | None = None, mode: str = "all", n: int = 30, author: str | None = None) -> list[dict]:
        posts = self.posts
        if author:
            posts = [p for p in posts if p["author"] == author]
        elif mode == "following" and uid:
            fs = self.follows.get(uid, set()) | {uid}
            posts = [p for p in posts if p["author"] in fs]
        elif mode == "hot":
            posts = sorted(posts[-200:], key=lambda p: len(p["likes"]) * 2 + len(p["comments"]) * 3 + p["t"] / 600, reverse=True)
            return posts[:n]
        return list(reversed(posts[-n:]))

    def feed_for_agent(self, uid: str, n: int = 8) -> list[dict]:
        """智能体刷手机看到的内容：关注的人优先 + 热门 + 最新。"""
        fs = self.follows.get(uid, set())
        recent = [p for p in self.posts[-80:] if p["author"] != uid]
        recent.sort(
            key=lambda p: (p["author"] in fs) * 3 + len(p["likes"]) * 0.5 + len(p["comments"]) + p["t"] / 300,
            reverse=True,
        )
        return recent[:n]

    def trending(self, now: float, n: int = 8) -> list[dict]:
        c: Counter = Counter()
        for p in self.posts:
            if now - p["t"] <= 1440 * 2:
                w = 1 + len(p["likes"]) * 0.3 + len(p["comments"]) * 0.5
                for tag in p["tags"]:
                    c[tag] += w
        return [{"tag": t, "score": round(s, 1)} for t, s in c.most_common(n)]

    def unread_notifications(self, uid: str, mark: bool = False) -> list[dict]:
        out = [x for x in self.notifications.get(uid, []) if not x["read"]]
        if mark:
            for x in out:
                x["read"] = True
        return out

    # ------------------------------------------------------------------ persistence
    def to_dict(self) -> dict:
        return {
            "users": self.users,
            "posts": self.posts,
            "follows": {k: sorted(v) for k, v in self.follows.items()},
            "dms": self.dms,
            "notifications": self.notifications,
            "pid": self._pid,
            "cid": self._cid,
        }

    def load(self, d: dict) -> None:
        self.users = d.get("users", {})
        self.posts = d.get("posts", [])
        self.follows = {k: set(v) for k, v in d.get("follows", {}).items()}
        self.dms = d.get("dms", {})
        self.notifications = d.get("notifications", {})
        self._pid = d.get("pid", len(self.posts) + 1)
        self._cid = d.get("cid", 1)
