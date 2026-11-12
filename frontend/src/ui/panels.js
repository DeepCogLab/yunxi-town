// 角色观察面板、玩家对话框、导演面板、关系网络图、对话记录、帮助、进入小镇
import { api, send } from '../net.js';
import { esc, state } from '../state.js';
import { toast } from './hud.js';
import { avatarHtml, openDm, openProfile } from './phone.js';

const $ = (s) => document.querySelector(s);

// ================================================================ 观察面板
let inspTab = 'plan';
let inspData = null;
let inspTimer = null;
export const inspectorHooks = { follow: null, walkTo: null };

export async function openInspector(id) {
  state.selected = id;
  $('#inspector').classList.remove('hidden');
  await refreshInspector();
  clearInterval(inspTimer);
  inspTimer = setInterval(refreshInspector, 4000);
}

export function closeInspector() {
  state.selected = null;
  inspData = null;
  clearInterval(inspTimer);
  $('#inspector').classList.add('hidden');
}

export async function refreshInspector() {
  const id = state.selected;
  if (!id || !state.agents.has(id)) return;
  try {
    inspData = await api(`/agents/${id}`);
  } catch { return; }
  if (state.selected !== id) return;
  renderInspector();
}

function renderInspector() {
  const a = inspData;
  if (!a) return;
  const el = $('#inspector');
  const keepScroll = el.querySelector('.tab-body')?.scrollTop || 0;
  const STATUS = { moving: '🚶 走路中', acting: '🟢 活动中', sleeping: '😴 睡觉', chatting: '💬 聊天中', talking: '💬 与玩家交谈' };
  const nowStr = state.clock.label.split(' ').pop();
  let body = '';
  if (inspTab === 'plan') {
    body = `<div style="color:var(--muted);margin-bottom:6px">📋 ${esc(a.plan_summary || '')}</div>` + a.plan.map((b) => {
      const now = nowStr >= b.start && nowStr < b.end;
      return `<div class="plan-row ${now ? 'now' : ''}"><span class="t">${b.start}–${b.end}</span><span>${esc(b.emoji)} ${esc(b.activity)} <span style="color:var(--muted)">@${esc(b.location)}</span></span></div>`;
    }).join('') + (a.commitments.length ? `<div style="margin-top:10px;color:var(--accent)">📌 之后的约定</div>${a.commitments.map((c) => `<div class="plan-row"><span class="t">第${c.day}天 ${c.start}</span><span>${esc(c.activity)}</span></div>`).join('')}` : '');
  } else if (inspTab === 'mem') {
    const L = { observation: '观察', conversation: '对话', reflection: '感悟', social: '小镇圈', event: '事件', chat: '玩家', plan: '计划', thought: '想法' };
    body = a.memories.map((m) => `<div class="mem"><span class="imp">${'★'.repeat(Math.min(5, Math.ceil(m.importance / 2)))}</span><span class="k ${m.kind}">${L[m.kind] || m.kind}</span><span style="color:var(--muted);font-size:11px">${esc(m.stamp)}</span><div>${esc(m.text)}</div></div>`).join('') || '暂无记忆';
  } else if (inspTab === 'rel') {
    body = a.relations.map((r) => `<div class="rel-row"><div style="width:64px">${esc(r.name)}</div><div style="flex:1"><div class="bar"><i style="width:${r.affinity}%"></i></div><div class="desc">${esc(r.desc)}</div></div><b style="width:28px;text-align:right">${r.affinity}</b></div>`).join('');
  } else {
    body = `<p><b>性格：</b>${esc(a.personality)}</p><p><b>背景：</b>${esc(a.background)}</p><p><b>小镇圈简介：</b>${esc(a.bio)}</p><p><b>家：</b>${esc(state.locations.get(a.home)?.name || a.home)}　<b>工作：</b>${esc(state.locations.get(a.work)?.name || a.work)}</p>`;
  }
  el.innerHTML = `
    <div class="insp-head">${avatarHtml(a.name, a.colors.shirt, 'lg')}
      <div class="meta"><h3>${esc(a.name)} <small style="font-weight:400;color:var(--muted);font-size:12px">${a.age}岁 · ${esc(a.occupation)}</small></h3>
      <p>${STATUS[a.status] || a.status} · 📍${esc(state.locations.get(a.location)?.name || '路上')} · 心情：${esc(a.mood)}</p></div>
      <button class="mini" data-x="close">✕</button></div>
    <div class="insp-now">${esc(a.emoji)} 正在：${esc(a.activity)}${a.thought ? `<div class="thought">💭 ${esc(a.thought)}</div>` : ''}</div>
    <div class="tabs">${[['plan', '日程'], ['mem', '记忆'], ['rel', '关系'], ['bio', '档案']].map(([k, v]) => `<button data-t="${k}" class="${k === inspTab ? 'on' : ''}">${v}</button>`).join('')}</div>
    <div class="tab-body">${body}</div>
    <div class="insp-actions">
      <button data-x="follow">🎥 镜头跟随</button>
      ${state.me ? '<button data-x="walk">🚶 走过去</button><button data-x="dm">✉️ 私信</button>' : ''}
      <button data-x="profile">📱 主页</button>
    </div>`;
  el.querySelector('.tab-body').scrollTop = keepScroll;
}

function initInspector() {
  $('#inspector').addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]');
    if (t) { inspTab = t.dataset.t; renderInspector(); return; }
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (!x || !inspData) return;
    if (x === 'close') closeInspector();
    if (x === 'follow') inspectorHooks.follow?.(inspData.id);
    if (x === 'walk') inspectorHooks.walkTo?.(inspData.id);
    if (x === 'dm') openDm(inspData.id);
    if (x === 'profile') openProfile(inspData.id);
  });
}

// ================================================================ 对话
export function onChatOpen(msg) {
  const a = msg.agent;
  state.chatWith = a.id;
  $('#chat').classList.remove('hidden');
  $('#chat-avatar').outerHTML = `<div class="avatar" id="chat-avatar" style="background:${esc(a.colors.shirt)}">${esc(a.name[0])}</div>`;
  $('#chat-name').textContent = a.name;
  $('#chat-sub').textContent = `${a.occupation} · ${a.mood} · ${a.activity}`;
  $('#chat-list').innerHTML = `<div class="msg them typing">（${esc(a.name)} 停下了手里的事，看向你）</div>`;
  setTimeout(() => $('#chat-input').focus(), 50);
}

export function onChatMsg(msg) {
  $('#chat-list .typing')?.remove();
  addChat('them', msg.reply, msg.action ? `${msg.emoji || ''} ${msg.action}` : msg.emoji);
}

export function onChatTyping() {
  $('#chat-list .typing')?.remove();
  const el = document.createElement('div');
  el.className = 'msg them typing';
  el.textContent = '正在思考怎么回答…';
  $('#chat-list').appendChild(el);
  $('#chat-list').scrollTop = 1e9;
}

export function onChatClose() {
  state.chatWith = null;
  $('#chat').classList.add('hidden');
  document.activeElement?.blur();
}

function addChat(who, text, act) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.innerHTML = `${act ? `<span class="act">${esc(act)}</span>` : ''}${esc(text)}`;
  $('#chat-list').appendChild(el);
  $('#chat-list').scrollTop = 1e9;
}

function initChat() {
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#chat-input');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    addChat('me', text);
    send({ t: 'chat_say', text });
  });
  $('#chat-close').addEventListener('click', () => send({ t: 'chat_end' }));
}

// ================================================================ 弹窗
export function openModal(title, html, onMount) {
  $('#modal-card').innerHTML = `<div class="modal-head">${title}<button class="mini" data-close>关闭 (Esc)</button></div><div class="modal-body">${html}</div>`;
  $('#modal').classList.remove('hidden');
  onMount?.($('#modal-card'));
}
export function closeModal() { $('#modal').classList.add('hidden'); }
export function modalOpen() { return !$('#modal').classList.contains('hidden'); }

// ---------------------------------------------------------------- 导演面板
const EVENT_PRESETS = [
  ['广场上突然来了一支街头乐队，正在免费演出', 'plaza'],
  ['镇长宣布：本周六晚上在中心广场举办首届云溪旅游节开幕晚会', 'townhall'],
  ['菜市场有人丢了钱包，里面有一张重要的老照片', 'market'],
  ['公园的小湖里发现了一只受伤的白鹭', 'park'],
  ['一位著名美食博主今天来到晓雨咖啡探店', 'cafe'],
  ['诊所门口有位老人突然晕倒了', 'clinic'],
  ['全镇停电了，要到晚上才能恢复', ''],
  ['有传言说一家大公司想收购溪畔公园建度假村', ''],
];

async function openDirector() {
  const locs = state.map.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  let slots = [];
  try { slots = await api('/world/slots'); } catch { /* ignore */ }
  openModal('🎬 导演面板 · 影响小镇世界', `
    <div class="grid2">
      <div class="card"><h4>⚡ 投放事件</h4>
        <textarea class="field" id="ev-text" placeholder="描述一件发生在小镇的事，居民会感知、记住、议论，并可能改变计划"></textarea>
        <div class="row"><select class="field" id="ev-loc"><option value="">全镇（所有人都会知道）</option>${locs}</select>
        <select class="field" id="ev-imp" style="flex:0 0 110px"><option value="5">一般</option><option value="7" selected>重要</option><option value="9">重大</option></select>
        <button class="btn" id="ev-go">投放</button></div>
        <div class="row">${EVENT_PRESETS.map(([t, l], i) => `<button class="preset" data-p="${i}">${esc(t.slice(0, 14))}…</button>`).join('')}</div>
      </div>
      <div class="card"><h4>🌦 天气 & ⏱ 时间</h4>
        <div class="row">${['晴', '多云', '小雨', '雷阵雨', '雾'].map((w) => `<button class="preset" data-w="${w}">${w}</button>`).join('')}</div>
        <div class="row" style="margin-top:14px">${['07:00', '09:00', '12:00', '15:00', '18:00', '20:00', '23:00'].map((t) => `<button class="preset" data-skip="${t}">跳到 ${t}</button>`).join('')}</div>
        <p style="color:var(--muted);font-size:12px">跳转时间会把居民直接放到对应日程的位置。</p>
      </div>
      <div class="card"><h4>💾 存档</h4>
        <div class="row"><input class="field" id="slot-name" placeholder="存档名" /><button class="btn" id="slot-save">保存</button></div>
        <div style="margin-top:8px">${slots.map((s) => `<div class="row" style="align-items:center"><span style="flex:1">${esc(s.key.replace('slot:', ''))} <small style="color:var(--muted)">${new Date(s.updated * 1000).toLocaleString()}</small></span><button class="preset" data-load="${esc(s.key.replace('slot:', ''))}">读取</button></div>`).join('') || '<small style="color:var(--muted)">暂无手动存档（世界每 30 秒自动保存）</small>'}</div>
      </div>
      <div class="card"><h4>🧨 重置世界</h4>
        <p style="color:var(--muted);font-size:12.5px;line-height:1.6">清空所有居民的记忆、关系变化、小镇圈动态和玩家数据，回到第 1 天清晨。手动存档不受影响。</p>
        <button class="btn danger" id="reset">重置小镇</button>
      </div>
    </div>`, (card) => {
    card.addEventListener('click', async (e) => {
      const t = e.target;
      try {
        if (t.dataset.p) { const [txt, loc] = EVENT_PRESETS[t.dataset.p]; $('#ev-text').value = txt; $('#ev-loc').value = loc; }
        if (t.id === 'ev-go') {
          const text = $('#ev-text').value.trim();
          if (!text) return toast('请先描述事件');
          await api('/world/event', { text, location: $('#ev-loc').value || null, importance: Number($('#ev-imp').value) });
          toast('⚡ 事件已投放，居民们正在做出反应'); closeModal();
        }
        if (t.dataset.w) { await api('/world/weather', { weather: t.dataset.w }); toast(`天气已变为 ${t.dataset.w}`); }
        if (t.dataset.skip) { await api('/world/skip', { time: t.dataset.skip }); toast(`时间已跳到 ${t.dataset.skip}`); }
        if (t.id === 'slot-save') { await api('/world/save', { name: $('#slot-name').value || `存档${Date.now() % 10000}` }); toast('已保存'); openDirector(); }
        if (t.dataset.load) { if (confirm(`读取存档「${t.dataset.load}」？当前进度会被覆盖（自动存档）。`)) { await api('/world/load', { name: t.dataset.load }); location.reload(); } }
        if (t.id === 'reset') { if (confirm('确定重置整个小镇吗？此操作不可撤销。')) { await api('/world/reset', {}); localStorage.removeItem('yunxi_me'); location.reload(); } }
      } catch (err) { toast(`操作失败：${err.message}`); }
    });
  });
}

// ---------------------------------------------------------------- 关系图
async function openGraph() {
  const g = await api('/relations');
  const W = 560;
  const H = 520;
  const n = g.nodes.length;
  const pos = {};
  g.nodes.forEach((nd, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const r = nd.npc ? 200 : 110;
    pos[nd.id] = [W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r];
  });
  const edges = g.edges.filter((e) => e.affinity >= 40 || e.affinity <= 25);
  const color = (v) => (v >= 75 ? '#5fd38d' : v >= 55 ? '#ffd166' : v >= 40 ? '#8aa0b8' : '#ff7a7a');
  const lines = edges.map((e, i) => {
    const [x1, y1] = pos[e.from];
    const [x2, y2] = pos[e.to];
    const mx = (x1 + x2) / 2 + (y2 - y1) * 0.08;
    const my = (y1 + y2) / 2 - (x2 - x1) * 0.08;
    return `<path d="M${x1},${y1} Q${mx},${my} ${x2},${y2}" stroke="${color(e.affinity)}" stroke-width="${1 + (Math.abs(e.affinity - 50) / 50) * 2.5}" fill="none" opacity="0.55" data-e="${i}" marker-end="url(#arr)"><title>${esc(state.agents.get(e.from)?.name || e.from)} → ${esc(state.agents.get(e.to)?.name || state.players.get(e.to)?.name || e.to)}：${e.affinity} ${esc(e.desc)}</title></path>`;
  }).join('');
  const nodes = g.nodes.map((nd) => {
    const [x, y] = pos[nd.id];
    return `<g data-n="${esc(nd.id)}" style="cursor:pointer"><circle cx="${x}" cy="${y}" r="${nd.npc ? 20 : 16}" fill="${esc(nd.color)}" stroke="#fff" stroke-width="2"/><text x="${x}" y="${y + 36}" fill="#eef1f6" font-size="12.5" text-anchor="middle">${esc(nd.name)}</text></g>`;
  }).join('');
  openModal('🕸 小镇关系网络', `<div class="graph-wrap"><svg viewBox="0 0 ${W} ${H}" id="graph"><defs><marker id="arr" viewBox="0 0 10 10" refX="28" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#aaa"/></marker></defs>${lines}${nodes}</svg>
    <div class="graph-side" id="graph-side"><p>点击人物查看 TA 对其他人的看法。</p><p><span style="color:#5fd38d">━</span> 亲密 (≥75)　<span style="color:#ffd166">━</span> 友好 (≥55)<br/><span style="color:#8aa0b8">━</span> 一般　<span style="color:#ff7a7a">━</span> 紧张 (≤25)</p><p style="color:var(--muted)">关系会随着对话、小镇圈互动和反思不断变化。</p></div></div>`, (card) => {
    card.querySelector('#graph').addEventListener('click', (e) => {
      const nEl = e.target.closest('[data-n]');
      if (!nEl) return;
      const id = nEl.dataset.n;
      const mine = g.edges.filter((x) => x.from === id).sort((a, b) => b.affinity - a.affinity);
      const toMe = g.edges.filter((x) => x.to === id).sort((a, b) => b.affinity - a.affinity);
      const nm = (x) => g.nodes.find((n2) => n2.id === x)?.name || x;
      card.querySelectorAll('#graph path').forEach((p) => {
        const ed = edges[p.dataset.e];
        p.setAttribute('opacity', ed.from === id || ed.to === id ? '0.95' : '0.08');
      });
      card.querySelector('#graph-side').innerHTML = `<h4 style="margin:0 0 8px">${esc(nm(id))}</h4>
        <b>TA 怎么看别人</b>${mine.map((x) => `<div class="rel-row"><span style="width:56px">${esc(nm(x.to))}</span><span class="desc" style="flex:1">${esc(x.desc)}</span><b>${x.affinity}</b></div>`).join('') || '<p>—</p>'}
        <b>别人怎么看 TA</b>${toMe.map((x) => `<div class="rel-row"><span style="width:56px">${esc(nm(x.from))}</span><span class="desc" style="flex:1">${esc(x.desc)}</span><b>${x.affinity}</b></div>`).join('') || '<p>—</p>'}`;
    });
  });
}

// ---------------------------------------------------------------- 对话记录
async function openConvs() {
  const cs = await api('/conversations?n=40');
  openModal('💬 居民对话记录', cs.map((c) => `<div class="conv"><h5>${esc(c.names.join(' × '))}<small>${esc(c.stamp)} · ${esc(c.location)}</small></h5>
    ${c.lines.map((l) => `<div class="line"><b>${esc(l.name)}：</b>${esc(l.text)}</div>`).join('')}
    <div class="sum">📝 ${esc(c.summary)}${c.commitments?.length ? ` · 📌 约定：${esc(c.commitments.join('；'))}` : ''}</div></div>`).join('') || '<p style="color:var(--muted)">居民们还没有展开对话，稍等一会儿～</p>');
}

// ---------------------------------------------------------------- 帮助
export function openHelp() {
  openModal('❓ 玩法说明', `<div class="help-grid">
    <div><kbd>W A S D</kbd> / 方向键　移动</div><div><kbd>Shift</kbd>　奔跑</div>
    <div><kbd>E</kbd>　与附近居民交谈</div><div><kbd>Enter</kbd>　对周围的人喊话</div>
    <div><kbd>P</kbd>　打开/收起手机（小镇圈）</div><div><kbd>V</kbd>　切换观察者 / 第三人称</div>
    <div><kbd>鼠标拖拽</kbd>　旋转视角，<kbd>滚轮</kbd> 缩放</div><div><kbd>点击居民</kbd>　查看 TA 的日程、记忆、关系</div>
    <div><kbd>G</kbd>　导演面板（投放事件、天气、时间、存档）</div><div><kbd>R</kbd> 关系网络　<kbd>C</kbd> 对话记录</div>
    <div><kbd>空格</kbd>　暂停/继续时间</div><div><kbd>Esc</kbd>　关闭面板 / 结束对话</div>
  </div>
  <hr style="border-color:var(--line);margin:16px 0" />
  <div style="line-height:1.8;font-size:13.5px;color:#cfd6e3">
  <p>🧠 <b>每位居民都是一个大模型智能体</b>：拥有记忆流（观察、对话、感悟）、每日日程规划、情绪和人际关系。他们会在路上偶遇并聊天、旁听别人的八卦、反思自己的生活，并把约定写进日程。</p>
  <p>📱 <b>小镇圈 = 线上世界</b>：居民会刷动态、发帖、点赞评论、@别人。你在小镇圈 @ 某人或私信 TA，TA 会回复你；看到感兴趣的活动，居民会真的改变计划到现场去。</p>
  <p>🌍 <b>线上线下相互影响</b>：线下的经历会成为发帖的素材，线上的动态会成为线下聊天的话题。你和居民的每次交流都会被记住，并影响 TA 对你的好感与看法。</p>
  <p>🎬 <b>当导演</b>：投放一个事件（比如“广场来了街头乐队”），看看整座小镇如何反应。</p>
  </div>`);
}

// ---------------------------------------------------------------- 进入小镇
const COLORS = ['#4f9dff', '#ff8a3d', '#5fd38d', '#c77dff', '#ff5d8f', '#ffd166', '#2ec4b6', '#e63946'];
export function showJoin(onJoin, onWatch) {
  const el = $('#join');
  el.classList.remove('hidden');
  let color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const box = $('#join-colors');
  box.innerHTML = COLORS.map((c) => `<button style="background:${c}" data-c="${c}" class="${c === color ? 'on' : ''}"></button>`).join('');
  box.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    color = b.dataset.c;
    box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#join-name').focus();
  $('#join-go').onclick = () => {
    const name = $('#join-name').value.trim();
    if (!name) { $('#join-name').focus(); return toast('给自己起个名字吧'); }
    if ([...state.agents.values()].some((a) => a.name === name)) return toast('这个名字和镇上居民重名了，换一个吧');
    el.classList.add('hidden');
    onJoin({ name, bio: $('#join-bio').value.trim(), color });
  };
  $('#join-watch').onclick = () => { el.classList.add('hidden'); onWatch(); };
}

export function initPanels() {
  initInspector();
  initChat();
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal();
  });
  $('#btn-director').addEventListener('click', openDirector);
  $('#btn-graph').addEventListener('click', openGraph);
  $('#btn-convs').addEventListener('click', openConvs);
  $('#btn-help').addEventListener('click', openHelp);
}

export { openDirector, openGraph, openConvs };
