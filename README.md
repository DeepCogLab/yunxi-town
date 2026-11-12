# 🏡 云溪镇 · 大模型智能体驱动的 3D 虚拟小镇

一座由大模型智能体驱动的 3D 小镇，**线下物理世界**与**线上社交网络（“小镇圈”）**互相影响。10 位居民各自拥有记忆、日程、情绪、人际关系和社交账号；你可以创建自己的角色走进小镇，和他们聊天、交朋友、发帖、私信，也可以当“导演”投放事件，看整座小镇怎么反应。

## 快速开始

```powershell
.\start.ps1
```

脚本会安装依赖、构建前端、启动服务并打开 http://localhost:8000 。

- 需要 Python 3.10+、Node 18+
- 大模型配置在根目录 `.env`（参考 `.env.example`），默认使用阿里云百炼的 OpenAI 兼容接口，模型为 `qwen3.5-122b-a10b`
- **不填 `LLM_API_KEY` 也能运行**：自动进入离线规则模式（默认日程 + 模板对话），方便调试
- 开发模式：`.\dev.ps1`（后端热重载 + Vite 热更新，访问 5173 端口）

## 玩法

| 操作 | 说明 |
|---|---|
| `WASD` / 方向键，`Shift` 奔跑 | 在小镇里走动（第三人称） |
| `E` | 与身边的居民面对面交谈（对方会按自己的性格、记忆、对你的好感来回答） |
| `Enter` | 对周围的人喊话，附近居民会听到并记住 |
| `P` | 打开手机“小镇圈”：动态、热搜、私信、通知、居民列表 |
| 点击居民 / 名牌 | 查看 TA 的实时日程、记忆流、人际关系、内心想法 |
| `V` | 切换观察者模式（自由镜头、可跟随任意居民） |
| `G` | 导演面板：投放事件、改天气、跳转时间、存档/读档、重置 |
| `R` / `C` | 关系网络图 / 居民之间的完整对话记录 |
| `空格` | 暂停/继续；顶栏可调 1×～12× 速度 |

## 智能体如何“活着”

架构参考斯坦福 *Generative Agents*（Park et al., 2023），并加入了社交网络这一层：

- **记忆流**：观察、对话、小镇圈见闻、事件、与玩家的交流、反思都写入记忆；检索按 *时近性 + 重要性 + 相关性* 打分（相关性用中文二元组余弦相似度，零依赖）
- **日程规划**：每天凌晨根据人设、近期记忆与反思、已有约定，由大模型生成 8～14 段日程；Agent 沿 A* 路径在地图上移动并执行
- **偶遇对话**：两位居民相遇时按好感概率发起对话，大模型一次生成整段对话 → 写入双方记忆、更新好感与看法、心情；**约好的事会写进双方日程并真的赴约**；附近的人会“旁听”到八卦
- **反思**：重要性累计到阈值后提炼高层感悟，并更新对他人的看法
- **刷小镇圈**：居民定期刷手机，根据记忆与人设发帖、点赞、评论、关注；被 @ 或被评论会更快回来看；看到感兴趣的活动会**改变线下计划**
- **事件反应**：导演投放的事件会被“亲眼看到”或“听说”，居民据此产生想法、改计划、发帖
- **与玩家互动**：面对面聊天、私信都会被总结进记忆，影响好感；可以和居民约时间地点，TA 会记进日程

所有大模型调用都有并发限制（`LLM_CONCURRENCY`）和规则兜底，单次失败不会影响小镇运行。

## 目录结构

```
backend/app/
  main.py            FastAPI：WebSocket 实时通道 + REST API + 静态前端
  sim.py             世界主循环：时间、调度、偶遇、玩家交互、社交联动、存档
  llm.py             OpenAI 兼容客户端（并发、统计、JSON 解析）
  agents/agent.py    智能体状态、日程执行、移动、关系
  agents/cognition.py  规划 / 对话 / 反思 / 刷手机 / 私信 / 事件反应的提示词与逻辑
  agents/memory.py   记忆流与检索
  social/network.py  小镇圈：帖子、点赞、评论、关注、私信、通知、热搜
  world/town_map.py  程序化地图 + A* 寻路
  world/personas.py  居民设定（可自行增删改）
  db.py              SQLite 存档（每 30 秒自动保存，支持手动存档槽）
frontend/src/
  world3d/           Three.js：场景与昼夜/天气、程序化小镇、低多边形角色
  ui/                顶栏与日志、手机社交 App、观察/对话/导演/关系图面板
  main.js            玩家控制、镜头、拾取、网络同步
```

## 自定义

- **增加居民**：在 `world/personas.py` 添加一项，并在 `world/town_map.py` 的 `LAYOUT`/`LOC_INFO` 中给 TA 一个家
- **换模型**：修改 `.env` 中的 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`，任何 OpenAI 兼容接口都可以
- **调节节奏**：`SIM_MINUTES_PER_SECOND`（1 秒现实时间 = 多少游戏分钟），或在游戏内调速

## 用到的开源项目

- [three.js](https://threejs.org/)（3D 渲染、OrbitControls、CSS2DRenderer）
- [FastAPI](https://fastapi.tiangolo.com/) + [Uvicorn](https://www.uvicorn.org/)
- [OpenAI Python SDK](https://github.com/openai/openai-python)（调用兼容接口）
- [Vite](https://vitejs.dev/)
- 设计思路参考 [Generative Agents](https://github.com/joonspk-research/generative_agents)、[AI Town](https://github.com/a16z-infra/ai-town)
