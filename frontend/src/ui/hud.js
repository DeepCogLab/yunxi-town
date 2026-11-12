// 顶栏、小镇动态日志、提示、小地图
import { api } from '../net.js';
import { esc, state } from '../state.js';

const $ = (s) => document.querySelector(s);
let logFilter = 'all';
const logItems = [];

export function toast(text, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function initHud() {
  $('#speed').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const v = b.dataset.speed;
    if (v === 'pause') await api('/world/speed', { paused: !state.clock.paused });
    else await api('/world/speed', { speed: Number(v), paused: false });
  });
  $('#log-filters').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    logFilter = b.dataset.f;
    document.querySelectorAll('#log-filters button').forEach((x) => x.classList.toggle('on', x === b));
    renderLog();
  });
  $('#log-toggle').addEventListener('click', () => $('#log-panel').classList.toggle('collapsed'));
}

const PERIOD_ICON = { 深夜: '🌙', 清晨: '🌅', 上午: '🌤', 中午: '☀️', 下午: '🌤', 傍晚: '🌇', 晚上: '🌃' };
const WEATHER_ICON = { 晴: '☀️ 晴', 多云: '⛅ 多云', 小雨: '🌧 小雨', 雷阵雨: '⛈ 雷阵雨', 雾: '🌫 雾' };

export function updateTopbar() {
  const c = state.clock;
  $('#clock-label').textContent = c.label;
  $('#period-icon').textContent = PERIOD_ICON[c.period] || '🕒';
  $('#weather').textContent = WEATHER_ICON[state.weather] || state.weather;
  document.querySelectorAll('#speed button').forEach((b) => {
    const v = b.dataset.speed;
    b.classList.toggle('on', v === 'pause' ? c.paused : !c.paused && Number(v) === c.speed);
    if (v === 'pause') b.textContent = c.paused ? '▶' : '⏸';
  });
  const l = state.llm || {};
  const chip = $('#llm-chip');
  chip.className = `chip llm ${l.enabled ? 'on' : 'off'}`;
  chip.textContent = l.enabled ? `${l.model} · ${l.calls} 次 · ${(l.tokens / 1000).toFixed(1)}k tok${l.inflight ? ` · 思考中 ${l.inflight}` : ''}` : '离线规则模式（未配置 API Key）';
  chip.title = l.enabled ? `成功 ${l.ok} / 失败 ${l.fail}，平均 ${l.avg_ms}ms` : '在 .env 中配置 LLM_API_KEY 后重启即可启用大模型';
  const pt = $('#phone-time');
  if (pt) pt.textContent = c.label.split(' ').pop();
}

export function addLog(item) {
  logItems.push(item);
  if (logItems.length > 400) logItems.shift();
  if (passes(item)) appendLog(item, true);
}

function passes(item) {
  if (logFilter === 'all') return true;
  if (logFilter === 'conversation') return item.kind === 'conversation' || item.kind === 'say' || item.kind === 'commit' || item.kind === 'player';
  if (logFilter === 'plan') return item.kind === 'plan' || item.kind === 'reflect' || item.kind === 'commit';
  if (logFilter === 'event') return item.kind === 'event' || item.kind === 'world';
  return item.kind === logFilter;
}

function appendLog(item, scroll) {
  const list = $('#log-list');
  const el = document.createElement('div');
  el.className = `log-item ${item.kind}`;
  el.innerHTML = item.html || `<span class="st">${esc(item.stamp || '')}</span>${esc(item.text)}`;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.appendChild(el);
  while (list.children.length > 300) list.firstChild.remove();
  if (scroll && nearBottom) list.scrollTop = list.scrollHeight;
}

function renderLog() {
  $('#log-list').innerHTML = '';
  logItems.filter(passes).slice(-300).forEach((i) => appendLog(i, false));
  $('#log-list').scrollTop = 1e9;
}

export function setPrompt(html) {
  const p = $('#prompt');
  if (!html) p.classList.add('hidden');
  else { p.innerHTML = html; p.classList.remove('hidden'); }
}

// ---------------------------------------------------------------- 小地图
const MM_COLORS = { house: '#7fa46a', plaza: '#cbbd9f', park: '#5c9a45', default: '#b9a888' };
export function drawMinimap(canvas, me, onPickLoc) {
  const map = state.map;
  if (!map) return;
  const ctx = canvas.getContext('2d');
  const s = canvas.width / map.size;
  if (!canvas._bg) {
    const bg = document.createElement('canvas');
    bg.width = bg.height = canvas.width;
    const g = bg.getContext('2d');
    g.fillStyle = '#5f8a4c';
    g.fillRect(0, 0, bg.width, bg.height);
    for (const loc of map.locations) {
      const [x, y, w, h] = loc.rect;
      g.fillStyle = MM_COLORS[loc.type] || MM_COLORS.default;
      g.fillRect(x * s, y * s, w * s, h * s);
      if (loc.building) {
        const [bx, by, bw, bh] = loc.building;
        g.fillStyle = loc.type === 'house' ? '#c98b6b' : '#e9dcc5';
        g.fillRect(bx * s, by * s, bw * s, bh * s);
      }
    }
    g.fillStyle = '#4a4d52';
    for (const r of map.roads) {
      g.fillRect(0, r * s, bg.width, 2 * s);
      g.fillRect(r * s, 0, 2 * s, bg.height);
    }
    canvas._bg = bg;
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const tx = ((e.clientX - rect.left) / rect.width) * map.size;
      const ty = ((e.clientY - rect.top) / rect.height) * map.size;
      const loc = map.locations.find((l) => tx >= l.rect[0] && tx < l.rect[0] + l.rect[2] && ty >= l.rect[1] && ty < l.rect[1] + l.rect[3]);
      if (loc) onPickLoc(loc);
    });
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const tx = ((e.clientX - rect.left) / rect.width) * map.size;
      const ty = ((e.clientY - rect.top) / rect.height) * map.size;
      const loc = map.locations.find((l) => tx >= l.rect[0] && tx < l.rect[0] + l.rect[2] && ty >= l.rect[1] && ty < l.rect[1] + l.rect[3]);
      canvas.title = loc ? loc.name : '小地图';
    });
  }
  ctx.drawImage(canvas._bg, 0, 0);
  for (const a of state.agents.values()) {
    if (a.status === 'sleeping') continue;
    ctx.fillStyle = a.colors.shirt;
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    ctx.arc(a.x * s, a.y * s, a.id === state.selected ? 4.5 : 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  for (const p of state.players.values()) {
    if (state.me && p.id === state.me.id) continue;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x * s - 3, p.y * s - 3, 6, 6);
  }
  if (me) {
    ctx.fillStyle = '#ffd166';
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    ctx.moveTo(me.x * s, me.y * s - 6);
    ctx.lineTo(me.x * s + 5, me.y * s + 4);
    ctx.lineTo(me.x * s - 5, me.y * s + 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}
