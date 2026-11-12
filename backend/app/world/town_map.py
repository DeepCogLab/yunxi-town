"""小镇地图：程序化生成地块、建筑、道路，并提供 A* 寻路。

坐标单位为“格”（tile），前端按 1 格 = 2 米渲染。
"""
from __future__ import annotations

import heapq
import random
from dataclasses import dataclass, field

SIZE = 46
ROADS = [2, 15, 28, 41]  # 每条道路占 r, r+1 两格
BLOCK_STARTS = [4, 17, 30]
BLOCK = 11


@dataclass
class Location:
    id: str
    name: str
    type: str
    rect: tuple[int, int, int, int]  # x, y, w, h
    building: tuple[int, int, int, int] | None = None
    front: str = "s"  # 门朝向 n/s/e/w
    desc: str = ""
    spots: list[tuple[int, int]] = field(default_factory=list)
    public: bool = True

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "rect": self.rect,
            "building": self.building,
            "front": self.front,
            "desc": self.desc,
            "public": self.public,
            "center": self.center(),
        }

    def center(self) -> tuple[float, float]:
        x, y, w, h = self.rect
        return (x + w / 2, y + h / 2)

    def contains(self, tx: float, ty: float) -> bool:
        x, y, w, h = self.rect
        return x <= tx < x + w and y <= ty < y + h


# (块行, 块列) -> 布局
LAYOUT: dict[tuple[int, int], dict] = {
    (0, 0): {"kind": "houses4", "slots": ["home_lin", "home_chen", "home_wang", "home_su"]},
    (0, 1): {"kind": "split2", "a": "school", "b": "library"},
    (0, 2): {"kind": "houses4", "slots": ["home_zhao", "home_li", "home_zhou", "home_wu"]},
    (1, 0): {"kind": "split2", "a": "cafe", "b": "bakery"},
    (1, 1): {"kind": "plaza", "id": "plaza"},
    (1, 2): {"kind": "split2", "a": "market", "b": "clinic"},
    (2, 0): {"kind": "park", "id": "park"},
    (2, 1): {"kind": "split2", "a": "townhall", "b": "tavern"},
    (2, 2): {"kind": "houses4", "slots": ["home_sun", "inn", "makerspace", "postoffice"]},
}

LOC_INFO: dict[str, tuple[str, str, str, bool]] = {
    # id: (名称, 类型, 描述, 是否公共场所)
    "home_lin": ("林晓雨的家", "house", "带小花园的白色小屋", False),
    "home_chen": ("陈默的家", "house", "安静整洁的灰色小屋", False),
    "home_wang": ("王大山的家", "house", "镇长家，院子里挂着红灯笼", False),
    "home_su": ("苏晴的家", "house", "窗台摆满绿植的小屋", False),
    "home_zhao": ("赵铁柱的家", "house", "飘着面粉香的砖房", False),
    "home_li": ("李想的家", "house", "装满电子设备的出租屋", False),
    "home_zhou": ("周婉的家", "house", "种着月季的老房子", False),
    "home_wu": ("吴磊的家", "house", "门口堆着酒桶的木屋", False),
    "home_sun": ("孙家", "house", "孙浩和女儿孙小满的家", False),
    "inn": ("云溪民宿", "inn", "外来旅客的落脚处，玩家的住所", True),
    "makerspace": ("创客空间", "studio", "有 3D 打印机和直播设备的共享工作室", True),
    "postoffice": ("邮局", "post", "小镇唯一的邮局，也收发快递", True),
    "school": ("云溪小学", "school", "小镇唯一的小学，有操场和旗杆", True),
    "library": ("图书馆", "library", "安静的图书馆，二楼有阅览室", True),
    "cafe": ("晓雨咖啡", "cafe", "林晓雨经营的咖啡馆，墙上挂满摄影作品", True),
    "bakery": ("铁柱面包房", "bakery", "每天清晨出炉新鲜面包", True),
    "plaza": ("中心广场", "plaza", "小镇中心，有喷泉和长椅，常举办活动", True),
    "market": ("菜市场", "market", "热闹的露天菜市场", True),
    "clinic": ("云溪诊所", "clinic", "陈默医生坐诊的小诊所", True),
    "park": ("溪畔公园", "park", "有小湖、树林和步道的公园", True),
    "townhall": ("镇政府", "townhall", "镇长办公和开会的地方", True),
    "tavern": ("老吴酒馆", "tavern", "晚上最热闹的地方，有驻唱和桌游", True),
}


class TownMap:
    def __init__(self, seed: int = 7) -> None:
        self.size = SIZE
        self.walkable = [[True] * SIZE for _ in range(SIZE)]
        self.locations: dict[str, Location] = {}
        self.decor: list[dict] = []
        rng = random.Random(seed)
        self._build(rng)

    # ------------------------------------------------------------------ build
    def _block_rect(self, r: int, c: int) -> tuple[int, int]:
        return BLOCK_STARTS[c], BLOCK_STARTS[r]

    def _block_tiles(self, x: int, y: int, w: int, h: int):
        for ty in range(y, y + h):
            for tx in range(x, x + w):
                yield tx, ty

    def _set_blocked(self, rect: tuple[int, int, int, int]) -> None:
        for tx, ty in self._block_tiles(*rect):
            self.walkable[ty][tx] = False

    def _add_loc(self, lid: str, rect, building=None, front="s") -> Location:
        name, typ, desc, public = LOC_INFO[lid]
        loc = Location(lid, name, typ, rect, building, front, desc, public=public)
        self.locations[lid] = loc
        if building:
            self._set_blocked(building)
        return loc

    def _build(self, rng: random.Random) -> None:
        for (r, c), lay in LAYOUT.items():
            bx, by = self._block_rect(r, c)
            kind = lay["kind"]
            if kind == "houses4":
                offs = [(0, 0), (6, 0), (0, 6), (6, 6)]
                for lid, (ox, oy) in zip(lay["slots"], offs):
                    sx, sy = bx + ox, by + oy
                    self._add_loc(lid, (sx, sy, 5, 5), (sx + 1, sy, 3, 3), "s")
                    self.decor.append({"type": "tree", "x": sx + 0.5, "y": sy + 0.5})
            elif kind == "split2":
                self._add_loc(lay["a"], (bx, by, BLOCK, 5), (bx + 1, by, 9, 3), "s")
                self._add_loc(lay["b"], (bx, by + 6, BLOCK, 5), (bx + 1, by + 8, 9, 3), "n")
                for k in range(3):
                    self.decor.append({"type": "lamp", "x": bx + 1.5 + k * 4, "y": by + 5.5})
            elif kind == "plaza":
                lid = lay["id"]
                self._add_loc(lid, (bx, by, BLOCK, BLOCK))
                fountain = (bx + 4, by + 4, 3, 3)
                self._set_blocked(fountain)
                self.decor.append({"type": "fountain", "x": bx + 5.5, "y": by + 5.5})
                for px, py in [(bx + 1, by + 1), (bx + 9, by + 1), (bx + 1, by + 9), (bx + 9, by + 9)]:
                    self.decor.append({"type": "tree", "x": px + 0.5, "y": py + 0.5})
                    self.walkable[py][px] = False
                for px, py in [(bx + 5.5, by + 2.3), (bx + 5.5, by + 8.7), (bx + 2.3, by + 5.5), (bx + 8.7, by + 5.5)]:
                    self.decor.append({"type": "bench", "x": px, "y": py, "rot": 0 if px == bx + 5.5 else 90})
                self.decor.append({"type": "stage", "x": bx + 5.5, "y": by + 0.8})
            elif kind == "park":
                lid = lay["id"]
                self._add_loc(lid, (bx, by, BLOCK, BLOCK))
                pond = (bx + 5, by + 5, 4, 3)
                self._set_blocked(pond)
                self.decor.append({"type": "pond", "x": bx + 7, "y": by + 6.5, "w": 4, "h": 3})
                for _ in range(14):
                    tx, ty = bx + rng.randrange(BLOCK), by + rng.randrange(BLOCK)
                    if self.walkable[ty][tx] and not (bx + 4 <= tx <= bx + 9 and by + 4 <= ty <= by + 8):
                        self.walkable[ty][tx] = False
                        self.decor.append({"type": "tree", "x": tx + 0.5, "y": ty + 0.5, "big": True})
                self.decor.append({"type": "bench", "x": bx + 3.5, "y": by + 6.5, "rot": 90})

        # 外圈树木
        for i in range(0, SIZE, 3):
            for tx, ty in [(i, 0), (i, SIZE - 1), (0, i), (SIZE - 1, i)]:
                if self.walkable[ty][tx]:
                    self.walkable[ty][tx] = False
                    self.decor.append({"type": "tree", "x": tx + 0.5, "y": ty + 0.5})
        # 路灯
        for r in ROADS:
            for i in range(4, SIZE - 4, 6):
                self.decor.append({"type": "lamp", "x": i + 0.5, "y": r - 0.3})
                self.decor.append({"type": "lamp", "x": r - 0.3, "y": i + 0.5})

        for loc in self.locations.values():
            loc.spots = [
                (tx, ty)
                for tx, ty in self._block_tiles(*loc.rect)
                if self.walkable[ty][tx]
            ]

    # ------------------------------------------------------------------ query
    def to_dict(self) -> dict:
        return {
            "size": self.size,
            "roads": ROADS,
            "locations": [l.to_dict() for l in self.locations.values()],
            "decor": self.decor,
            "walkable": ["".join("1" if w else "0" for w in row) for row in self.walkable],
        }

    def location_at(self, x: float, y: float) -> Location | None:
        for loc in self.locations.values():
            if loc.contains(x, y):
                return loc
        return None

    def random_spot(self, loc_id: str, rng: random.Random, avoid: set | None = None) -> tuple[int, int]:
        loc = self.locations[loc_id]
        spots = loc.spots
        if avoid:
            free = [s for s in spots if s not in avoid]
            if free:
                spots = free
        # 有建筑的地点优先站在门前
        if loc.building:
            bx, by, bw, bh = loc.building
            if loc.front == "s":
                near = [s for s in spots if s[1] == by + bh]
            else:
                near = [s for s in spots if s[1] == by - 1]
            if near and rng.random() < 0.7:
                spots = near
        return rng.choice(spots)

    def nearest_walkable(self, x: float, y: float) -> tuple[int, int]:
        tx, ty = int(x), int(y)
        if 0 <= tx < SIZE and 0 <= ty < SIZE and self.walkable[ty][tx]:
            return tx, ty
        best, bd = (ROADS[1], ROADS[1]), 1e9
        for r in range(1, 6):
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    nx, ny = tx + dx, ty + dy
                    if 0 <= nx < SIZE and 0 <= ny < SIZE and self.walkable[ny][nx]:
                        d = dx * dx + dy * dy
                        if d < bd:
                            best, bd = (nx, ny), d
            if bd < 1e9:
                return best
        return best

    def find_path(self, start: tuple[int, int], goal: tuple[int, int]) -> list[tuple[int, int]]:
        start = self.nearest_walkable(*start)
        goal = self.nearest_walkable(*goal)
        if start == goal:
            return [goal]
        openq: list = [(0, 0, start)]
        came: dict = {start: None}
        g = {start: 0}
        n = 0
        while openq:
            _, _, cur = heapq.heappop(openq)
            if cur == goal:
                break
            cx, cy = cur
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx + dx, cy + dy
                if not (0 <= nx < SIZE and 0 <= ny < SIZE) or not self.walkable[ny][nx]:
                    continue
                ng = g[cur] + 1
                if ng < g.get((nx, ny), 1e9):
                    g[(nx, ny)] = ng
                    came[(nx, ny)] = cur
                    n += 1
                    h = abs(nx - goal[0]) + abs(ny - goal[1])
                    heapq.heappush(openq, (ng + h, n, (nx, ny)))
        if goal not in came:
            return [goal]
        path = []
        cur = goal
        while cur is not None:
            path.append(cur)
            cur = came[cur]
        path.reverse()
        return path[1:]
