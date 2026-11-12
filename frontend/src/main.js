import * as THREE from 'three';
import { api, connect, on, send } from './net.js';
import { esc, state, toTile, toWorld } from './state.js';
import { addLog, drawMinimap, initHud, setPrompt, toast, updateTopbar } from './ui/hud.js';
import { initPhone, isPhoneOpen, onDm, onSocial, primeMyPosts, togglePhone } from './ui/phone.js';
import {
  closeInspector, closeModal, initPanels, inspectorHooks, modalOpen, onChatClose, onChatMsg, onChatOpen,
  onChatTyping, openConvs, openDirector, openGraph, openHelp, openInspector, refreshInspector, showJoin,
} from './ui/panels.js';
import { createScene, updateDayNight } from './world3d/scene.js';
import { buildTown } from './world3d/town.js';
import { Character } from './world3d/characters.js';

const env = createScene(document.getElementById('world'));
const chars = new Map(); // id -> Character（NPC 与其他玩家）
let town = null;
let me = null; // { char, x, y }
let followId = null;
const keys = new Set();
const saved = (() => { try { return JSON.parse(localStorage.getItem('yunxi_me') || 'null'); } catch { return null; } })();
let joinedOnce = false;

Character.onPick = (id) => { if (state.agents.has(id)) openInspector(id); };
initHud();
initPhone();
initPanels();

// ================================================================ 网络事件
on('init', (msg) => {
  document.getElementById('loading').classList.add('hidden');
  state.town = msg.town;
  document.getElementById('town-name').textContent = msg.town;
  state.weather = msg.weather;
  state.llm = msg.llm;
  if (!state.map) {
    state.map = msg.map;
    msg.map.locations.forEach((l) => state.locations.set(l.id, l));
    town = buildTown(env, msg.map);
    const [cx, cz] = toWorld(msg.map.size / 2, msg.map.size / 2);
    env.controls.target.set(cx, 0, cz);
  }
  for (const a of msg.agents) {
    state.agents.set(a.id, a);
    if (!chars.has(a.id)) {
      const c = new Character(env.scene, { id: a.id, name: a.name, colors: a.colors, emoji: a.emoji, activity: a.activity });
      c.place(a.x, a.y);
      chars.set(a.id, c);
    }
  }
  msg.logs.forEach((l) => addLog(l));
  if (saved && !joinedOnce) {
    send({ t: 'join', pid: saved.pid, name: saved.name, bio: saved.bio, color: saved.color });
  } else if (!joinedOnce) {
    showJoin((info) => {
      const pid = `p_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('yunxi_me', JSON.stringify({ pid, ...info }));
      send({ t: 'join', pid, ...info });
    }, () => { setObserver(true); toast('👁 观察者模式：拖拽旋转、滚轮缩放、点击居民查看详情。刷新页面可创建角色。', 6000); });
  } else if (state.me) {
    send({ t: 'join', pid: state.me.id, name: state.me.name, bio: state.me.bio, color: state.me.color });
  }
});

on('joined', (msg) => {
  const first = !joinedOnce;
  joinedOnce = true;
  state.me = msg.me;
  if (!me) {
    const c = new Character(env.scene, { id: msg.me.id, name: msg.me.name, color: msg.me.color, isMe: true });
    c.place(msg.me.x, msg.me.y);
    me = { char: c, x: msg.me.x, y: msg.me.y, lastSent: 0 };
    const [wx, wz] = toWorld(me.x, me.y);
    env.controls.target.set(wx, 0, wz);
    env.camera.position.set(wx, 18, wz + 22);
  }
  setObserver(false);
  primeMyPosts();
  if (first) {
    toast(`欢迎你，${msg.me.name}！你住在云溪民宿。走近居民按 E 交谈，按 P 打开小镇圈。`, 6000);
    if (!saved) setTimeout(openHelp, 800);
  }
});

on('tick', (msg) => {
  state.clock = msg.clock;
  state.weather = msg.weather;
  state.llm = msg.llm;
  for (const a of msg.agents) {
    const s = state.agents.get(a.id);
    if (s) Object.assign(s, a);
    const c = chars.get(a.id);
    if (!c) continue;
    c.setTarget(a.x, a.y);
    c.setTag(a.name, a.emoji, a.activity);
    c.setVisible(a.status !== 'sleeping');
    if (a.face) c.faceTo(a.face[0], a.face[1]);
    else if (a.partner && state.me && a.partner === state.me.id && me) c.faceTo(me.x, me.y);
  }
  const seen = new Set();
  for (const p of msg.players) {
    if (state.me && p.id === state.me.id) continue;
    seen.add(p.id);
    state.players.set(p.id, p);
    let c = chars.get(p.id);
    if (!c) {
      c = new Character(env.scene, { id: p.id, name: p.name, color: p.color, isPlayer: true });
      c.place(p.x, p.y);
      chars.set(p.id, c);
    }
    c.setTarget(p.x, p.y);
    c.setTag(p.name, '🧳', p.talking_to ? `和${state.agents.get(p.talking_to)?.name || ''}聊天` : '');
  }
  for (const [id, c] of chars) {
    if (id.startsWith('p_') && !seen.has(id)) { c.dispose(env.scene); chars.delete(id); state.players.delete(id); }
  }
  updateTopbar();
});

on('say', (msg) => {
  const c = msg.speaker === state.me?.id ? me?.char : chars.get(msg.speaker);
  if (c) c.say(msg.text, Math.max(3500, msg.text.length * 220));
  // 只记录自己参与的、或附近能“听到”的对话
  const involved = state.me && (msg.speaker === state.me.id || msg.to === state.me.id);
  const src = c ? c.pos : null;
  const focus = env.controls.target;
  const near = src && src.distanceTo(focus) < 26;
  if (involved || near) {
    const toName = msg.to ? (state.agents.get(msg.to)?.name || state.players.get(msg.to)?.name || (msg.to === state.me?.id ? '你' : '')) : '';
    addLog({ kind: 'say', html: `<span class="st">${esc(state.clock.label.split(' ').pop())}</span><b>${esc(msg.name)}</b>${toName ? ` → ${esc(toName)}` : ''}：${esc(msg.text)}` });
  }
});

on('log', (msg) => addLog(msg.item));
on('toast', (msg) => toast(msg.text));
on('social', onSocial);
on('dm', onDm);
on('chat_open', onChatOpen);
on('chat_msg', onChatMsg);
on('chat_typing', onChatTyping);
on('chat_close', onChatClose);
on('agent_update', (msg) => { if (msg.id === state.selected) refreshInspector(); });
on('world_event', (msg) => toast(`⚡ ${msg.text}`, 6000));
on('weather', (msg) => toast(`🌦 天气变成了 ${msg.weather}`));
on('reload', () => location.reload());
on('close', () => toast('与服务器断开，正在重连…'));

connect(saved?.pid);

// ================================================================ 观察者 / 第三人称
function setObserver(v) {
  state.observer = v || !state.me;
  document.getElementById('btn-observer').classList.toggle('on', state.observer);
  env.controls.maxDistance = state.observer ? 160 : 45;
  env.controls.enablePan = state.observer;
  if (!state.observer) followId = null;
  if (state.observer && me && !followId) {
    // 拉远镜头
    const t = env.controls.target;
    env.camera.position.set(t.x + 10, 70, t.z + 60);
  }
}

inspectorHooks.follow = (id) => {
  if (!state.observer) setObserver(true);
  followId = id;
  toast(`🎥 镜头跟随 ${state.agents.get(id)?.name}（拖动镜头取消）`);
};
inspectorHooks.walkTo = (id) => {
  const a = state.agents.get(id);
  if (!a || !me) return;
  setObserver(false);
  autoPath = findPath([me.x, me.y], [a.x, a.y]);
  autoTarget = id;
  toast(`🚶 正在走向 ${a.name}…（按方向键可取消）`);
};
env.controls.addEventListener('start', () => { if (state.observer) followId = null; });

document.getElementById('btn-observer').addEventListener('click', () => {
  if (!state.me) return toast('你目前是观察者。刷新页面即可创建角色进入小镇。');
  setObserver(!state.observer);
});

// ================================================================ 输入
function typing() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (shoutBox) return closeShout();
    if (modalOpen()) return closeModal();
    if (state.chatWith) return send({ t: 'chat_end' });
    if (isPhoneOpen()) return togglePhone(false);
    if (state.selected) return closeInspector();
    return;
  }
  if (typing()) return;
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'e' && nearest && !state.chatWith) { send({ t: 'chat_start', agent: nearest }); e.preventDefault(); }
  else if (k === 'p') togglePhone();
  else if (k === 'v') document.getElementById('btn-observer').click();
  else if (k === 'g') openDirector();
  else if (k === 'r') openGraph();
  else if (k === 'c') openConvs();
  else if (k === 'h') openHelp();
  else if (k === ' ') { e.preventDefault(); api('/world/speed', { paused: !state.clock.paused }); }
  else if (k === 'enter' && state.me) { e.preventDefault(); openShout(); }
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(k)) { autoPath = null; }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

let shoutBox = null;
function openShout() {
  if (shoutBox) return;
  shoutBox = document.createElement('form');
  shoutBox.style.cssText = 'position:fixed;left:50%;bottom:170px;transform:translateX(-50%);z-index:9;display:flex;gap:6px';
  shoutBox.innerHTML = '<input class="field" style="width:360px" maxlength="120" placeholder="对周围的人喊话（附近的居民会听到并记住）"/><button class="btn">喊</button>';
  document.body.appendChild(shoutBox);
  const inp = shoutBox.querySelector('input');
  inp.focus();
  shoutBox.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = inp.value.trim();
    if (text) send({ t: 'shout', text });
    closeShout();
  });
  inp.addEventListener('blur', () => setTimeout(closeShout, 100));
}
function closeShout() { shoutBox?.remove(); shoutBox = null; }

// 点击拾取
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downAt = null;
env.labels.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
env.labels.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, env.camera);
  const objs = [];
  chars.forEach((c) => { if (c.visible) objs.push(c.body); });
  const hit = ray.intersectObjects(objs, true)[0];
  if (hit) {
    const id = hit.object.userData.charId;
    if (state.agents.has(id)) openInspector(id);
    return;
  }
  const bh = town && ray.intersectObjects(town.buildingMeshes, false)[0];
  if (bh) showLocation(bh.object.userData.locId);
});

async function showLocation(id) {
  const loc = state.locations.get(id);
  if (!loc) return;
  const here = [...state.agents.values()].filter((a) => a.location === id && a.status !== 'sleeping').map((a) => a.name);
  toast(`📍 ${loc.name}：${loc.desc}${here.length ? `｜现在在这里：${here.join('、')}` : '｜现在没有人'}`, 5000);
}

// ================================================================ 玩家移动
let nearest = null;
let autoPath = null;
let autoTarget = null;
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();

function walkable(x, y) {
  const m = state.map;
  if (!m) return false;
  const r = 0.28;
  for (const [dx, dy] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
    const tx = Math.floor(x + dx);
    const ty = Math.floor(y + dy);
    if (tx < 0 || ty < 0 || tx >= m.size || ty >= m.size) return false;
    if (m.walkable[ty][tx] !== '1') return false;
  }
  return true;
}

function updateMe(dt) {
  if (!me || state.observer) return;
  let mx = 0;
  let mz = 0;
  if (!state.chatWith && !typing()) {
    if (keys.has('w') || keys.has('arrowup')) mz += 1;
    if (keys.has('s') || keys.has('arrowdown')) mz -= 1;
    if (keys.has('a') || keys.has('arrowleft')) mx -= 1;
    if (keys.has('d') || keys.has('arrowright')) mx += 1;
  }
  let dx = 0;
  let dy = 0;
  if (mx || mz) {
    env.camera.getWorldDirection(fwd);
    fwd.y = 0; fwd.normalize();
    right.crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    const v = fwd.multiplyScalar(mz).add(right.multiplyScalar(mx)).normalize();
    dx = v.x; dy = v.z; // world x/z 与 tile x/y 同向
  } else if (autoPath && autoPath.length && !state.chatWith) {
    const [tx, ty] = autoPath[0];
    const ddx = tx + 0.5 - me.x;
    const ddy = ty + 0.5 - me.y;
    const d = Math.hypot(ddx, ddy);
    if (d < 0.2) autoPath.shift();
    else { dx = ddx / d; dy = ddy / d; }
    const tgt = state.agents.get(autoTarget);
    if (tgt && Math.hypot(tgt.x - me.x, tgt.y - me.y) < 1.8) { autoPath = null; }
  }
  const speed = (keys.has('shift') ? 6.5 : 3.6) * dt;
  if (dx || dy) {
    const nx = me.x + dx * speed;
    const ny = me.y + dy * speed;
    if (walkable(nx, me.y)) me.x = nx;
    if (walkable(me.x, ny)) me.y = ny;
  }
  const [wx, wz] = toWorld(me.x, me.y);
  const prev = me.char.pos.clone();
  me.char.target.set(wx, 0, wz);
  me.char.update(dt, true);
  // 镜头跟随
  const delta = me.char.pos.clone().sub(prev);
  env.camera.position.add(delta);
  env.controls.target.add(delta);
  const now = performance.now();
  if (now - me.lastSent > 120 && (delta.lengthSq() > 0 || now - me.lastSent > 2000)) {
    me.lastSent = now;
    send({ t: 'move', x: me.x, y: me.y, d: me.char.heading });
  }
  // 交互提示
  nearest = null;
  let best = 3.2;
  for (const a of state.agents.values()) {
    if (a.status === 'sleeping') continue;
    const d = Math.hypot(a.x - me.x, a.y - me.y);
    if (d < best) { best = d; nearest = a.id; }
  }
  if (state.chatWith) setPrompt('');
  else if (nearest) {
    const a = state.agents.get(nearest);
    const busy = a.status === 'chatting' ? `（正在和${state.agents.get(a.partner)?.name || '别人'}聊天）` : '';
    setPrompt(`<kbd>E</kbd> 与 <b>${esc(a.name)}</b> 交谈 ${busy}<span style="color:var(--muted)">· ${esc(a.activity)}</span>`);
  } else setPrompt('');
}

// 简单 A*（玩家“走过去”用）
function findPath(from, to) {
  const m = state.map;
  const S = m.size;
  const sx = Math.floor(from[0]); const sy = Math.floor(from[1]);
  let gx = Math.floor(to[0]); let gy = Math.floor(to[1]);
  const ok = (x, y) => x >= 0 && y >= 0 && x < S && y < S && m.walkable[y][x] === '1';
  if (!ok(gx, gy)) {
    outer: for (let r = 1; r < 4; r++) for (let ddy = -r; ddy <= r; ddy++) for (let ddx = -r; ddx <= r; ddx++) if (ok(gx + ddx, gy + ddy)) { gx += ddx; gy += ddy; break outer; }
  }
  const key = (x, y) => y * S + x;
  const came = new Map([[key(sx, sy), -1]]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift();
    if (x === gx && y === gy) break;
    for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ddx; const ny = y + ddy;
      if (ok(nx, ny) && !came.has(key(nx, ny))) { came.set(key(nx, ny), key(x, y)); q.push([nx, ny]); }
    }
  }
  if (!came.has(key(gx, gy))) return null;
  const path = [];
  let k = key(gx, gy);
  while (k !== -1 && k !== key(sx, sy)) { path.push([k % S, Math.floor(k / S)]); k = came.get(k); }
  return path.reverse();
}

// ================================================================ 主循环
const clock = new THREE.Clock();
let mmTimer = 0;
const mm = document.getElementById('minimap');
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  updateMe(dt);
  if (state.observer && followId && chars.has(followId)) {
    const c = chars.get(followId);
    const delta = c.pos.clone().sub(env.controls.target);
    delta.y = 0;
    env.controls.target.add(delta.multiplyScalar(Math.min(1, dt * 4)));
    env.camera.position.add(delta);
  }
  const camPos = env.camera.position;
  chars.forEach((c) => {
    c.update(dt);
    c.setSelected(c.id === state.selected);
    c.tagEl.classList.toggle('far', c.pos.distanceTo(camPos) > 70);
  });
  if (me) me.char.setTag(state.me?.name || '', '⭐', '');
  env.controls.update();
  const focus = env.controls.target;
  updateDayNight(env, state.clock.mod ?? 390, state.weather, focus);
  env.rain.update(dt, focus, env);
  town?.update(env, t);
  env.renderer.render(env.scene, env.camera);
  env.labels.render(env.scene, env.camera);
  mmTimer -= dt;
  if (mmTimer <= 0) {
    mmTimer = 0.25;
    drawMinimap(mm, me, (loc) => {
      showLocation(loc.id);
      if (state.observer) {
        const [wx, wz] = toWorld(loc.center[0], loc.center[1]);
        followId = null;
        const d = new THREE.Vector3(wx, 0, wz).sub(env.controls.target);
        env.controls.target.add(d);
        env.camera.position.add(d);
      }
    });
  }
}
frame();

// 调试用
window.__town = { state, env, chars, toTile, get me() { return me; }, get autoPath() { return autoPath; }, walkTo: (id) => inspectorHooks.walkTo(id) };
