// 手机里的“小镇圈”社交 App
import { api } from '../net.js';
import { esc, state } from '../state.js';
import { toast } from './hud.js';

const $ = (s) => document.querySelector(s);
let tab = 'feed';
let feedMode = 'all';
let tagFilter = null;
let view = null; // {type:'profile', id} | {type:'dm', id}
let unread = { dm: 0, notif: 0 };

export function avatarHtml(name, color, cls = '') {
  return `<div class="avatar ${cls}" style="background:${esc(color)}">${esc((name || '?').slice(0, 1))}</div>`;
}

function richText(t) {
  return esc(t)
    .replace(/#([^\s#，。！？、,.!?@&;]{1,15})#?/g, '<span class="tag" data-tag="$1">#$1#</span>')
    .replace(/@([一-龥A-Za-z0-9_]{1,12})/g, '<span class="at">@$1</span>');
}

function postHtml(p) {
  const me = state.me?.id;
  const liked = me && p.likes.includes(me);
  const comments = p.comments.length
    ? `<div class="comments">${p.comments.slice(-8).map((c) => `<div class="c"><b data-user="${esc(c.author)}">${esc(c.author_name)}</b>：${richText(c.text)}<span class="s">${esc(c.stamp)}</span></div>`).join('')}</div>`
    : '';
  return `<div class="post" data-pid="${p.id}">
    <div class="post-head">${avatarHtml(p.author_name, p.author_color)}
      <div><div class="n" data-user="${esc(p.author)}">${esc(p.author_name)}${p.is_npc ? '' : ' <span style="color:#2f7de1;font-size:11px">玩家</span>'}</div>
      <div class="s">${esc(p.stamp)}${p.location_name ? ` · 📍${esc(p.location_name)}` : ''}</div></div></div>
    <div class="post-text">${richText(p.text)}</div>
    <div class="post-acts">
      <button class="${liked ? 'liked' : ''}" data-act="like">${liked ? '❤️' : '🤍'} ${p.likes.length || '赞'}</button>
      <button data-act="cmt">💬 ${p.comments.length || '评论'}</button>
    </div>
    ${p.like_names.length ? `<div class="likes-line">❤️ ${esc(p.like_names.slice(0, 6).join('、'))}${p.like_names.length > 6 ? ` 等${p.like_names.length}人` : ''}</div>` : ''}
    ${comments}
    <form class="cform hidden"><input placeholder="写评论…可用 @名字" maxlength="200" /><button class="pbtn">发送</button></form>
  </div>`;
}

export function initPhone() {
  $('#btn-phone').addEventListener('click', togglePhone);
  $('#phone-close').addEventListener('click', togglePhone);
  $('#phone-nav').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setTab(b.dataset.tab);
  });
  const body = $('#phone-body');
  body.addEventListener('click', onClick);
  body.addEventListener('submit', onSubmit);
}

export function isPhoneOpen() { return !$('#phone').classList.contains('hidden'); }

export function togglePhone(force) {
  const open = typeof force === 'boolean' ? force : !isPhoneOpen();
  $('#phone').classList.toggle('hidden', !open);
  document.body.classList.toggle('phone-open', open);
  $('#btn-phone').classList.toggle('on', open);
  if (open) render();
}

export function openProfile(id) {
  togglePhone(true);
  tab = 'people';
  view = { type: 'profile', id };
  syncNav();
  render();
}

export function openDm(id) {
  togglePhone(true);
  tab = 'dm';
  view = { type: 'dm', id };
  syncNav();
  render();
}

function setTab(t) {
  tab = t;
  view = null;
  tagFilter = null;
  syncNav();
  render();
}

function syncNav() {
  document.querySelectorAll('#phone-nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
}

function needMe() {
  if (!state.me) { toast('观察者模式下不能发言，请先创建角色（刷新页面）'); return false; }
  return true;
}

async function render() {
  const body = $('#phone-body');
  const me = state.me?.id || '';
  try {
    if (view?.type === 'profile') return renderProfile(body, view.id);
    if (view?.type === 'dm') return renderDm(body, view.id);
    if (tab === 'feed') {
      const mode = tagFilter ? 'all' : feedMode;
      let posts = await api(`/social/feed?uid=${encodeURIComponent(me)}&mode=${mode}&n=${tagFilter ? 200 : 50}`);
      if (tagFilter) posts = posts.filter((p) => p.tags.includes(tagFilter));
      body.innerHTML = `
        ${state.me ? `<div class="compose"><textarea id="compose" maxlength="400" placeholder="分享新鲜事…  #话题#  @居民名字 会通知对方"></textarea>
        <div class="row"><span>以 ${esc(state.me.name)} 的身份发布</span><button class="pbtn" data-act="post">发布</button></div></div>` : ''}
        <div class="subtabs">${tagFilter ? `<button class="on">#${esc(tagFilter)}#</button><button data-act="cleartag">✕ 清除话题</button>` : ['all:最新', 'following:关注', 'hot:热门'].map((x) => { const [k, v] = x.split(':'); return `<button data-mode="${k}" class="${k === feedMode ? 'on' : ''}">${v}</button>`; }).join('')}</div>
        <div id="feed">${posts.map(postHtml).join('') || '<div class="empty">还没有动态</div>'}</div>`;
    } else if (tab === 'hot') {
      const [tags, hot] = await Promise.all([api('/social/trending'), api('/social/feed?mode=hot&n=10')]);
      body.innerHTML = `<div class="subtabs"><button class="on">🔥 小镇热搜</button></div>
        ${tags.map((t, i) => `<div class="hot-item" data-tag="${esc(t.tag)}"><span class="rank">${i + 1}</span><b>#${esc(t.tag)}#</b><span class="sc">${t.score}</span></div>`).join('') || '<div class="empty">暂无热搜</div>'}
        <div class="subtabs"><button class="on">热门动态</button></div>${hot.map(postHtml).join('')}`;
    } else if (tab === 'dm') {
      if (!state.me) { body.innerHTML = '<div class="empty">创建角色后才能收发私信</div>'; return; }
      const threads = await api(`/social/dms?uid=${encodeURIComponent(me)}`);
      unread.dm = 0; badge();
      body.innerHTML = `<div class="dm-list">${threads.map((t) => `<div class="urow" data-dm="${esc(t.with)}">${avatarHtml(t.name, t.color)}<div class="info"><b>${esc(t.name)}</b>${t.unread ? ` <span class="aff">${t.unread} 条未读</span>` : ''}<p>${esc(t.last.text)}</p></div></div>`).join('') || '<div class="empty">还没有私信。去“居民”里找人聊聊吧～</div>'}</div>`;
    } else if (tab === 'notif') {
      if (!state.me) { body.innerHTML = '<div class="empty">创建角色后才有通知</div>'; return; }
      const ns = await api(`/social/notifications?uid=${encodeURIComponent(me)}`);
      unread.notif = 0; badge();
      const K = { like: '赞了你的动态', comment: '评论了你', mention: '在动态中提到了你', reply: '回复了你参与的讨论', follow: '关注了你' };
      body.innerHTML = ns.map((n) => `<div class="notif ${n.read ? '' : 'unread'}" data-user="${esc(n.from)}">${avatarHtml(n.from_name, '#999', 'sm')}<div><b>${esc(n.from_name)}</b> ${K[n.kind] || n.kind}<p>${esc(n.text)} · ${esc(n.stamp)}</p></div></div>`).join('') || '<div class="empty">暂无通知</div>';
    } else if (tab === 'people') {
      const us = await api(`/social/users?uid=${encodeURIComponent(me)}`);
      body.innerHTML = us.filter((u) => u.id !== me).map((u) => `<div class="urow">${avatarHtml(u.name, u.color)}<div class="info" data-user="${esc(u.id)}"><b>${esc(u.name)}</b>${u.occupation ? ` <small style="color:#8a8f99">${esc(u.occupation)}</small>` : ' <small style="color:#2f7de1">玩家</small>'}${u.affinity != null ? `<span class="aff">好感 ${u.affinity}</span>` : ''}<p>${esc(u.bio)}</p></div>
        ${state.me ? `<button class="pbtn ${u.followed ? 'on' : ''}" data-follow="${esc(u.id)}">${u.followed ? '已关注' : '+ 关注'}</button>` : ''}</div>`).join('');
    }
  } catch (e) {
    body.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

async function renderProfile(body, id) {
  const me = state.me?.id || '';
  const u = await api(`/social/user/${encodeURIComponent(id)}?uid=${encodeURIComponent(me)}`);
  body.innerHTML = `<button class="back" data-act="back">‹ 返回</button>
    <div class="profile">${avatarHtml(u.name, u.color, 'lg')}<b style="font-size:17px">${esc(u.name)}</b><p>${esc(u.bio)}</p>
    <div class="stats"><span><b>${u.posts}</b>动态</span><span><b>${u.following}</b>关注</span><span><b>${u.followers}</b>粉丝</span></div>
    ${state.me && id !== me ? `<button class="pbtn ${u.followed ? 'on' : ''}" data-follow="${esc(id)}">${u.followed ? '已关注' : '+ 关注'}</button> <button class="pbtn ghost" data-dm="${esc(id)}">✉️ 私信</button>` : ''}</div>
    ${u.posts_list.map(postHtml).join('') || '<div class="empty">TA 还没有发过动态</div>'}`;
}

async function renderDm(body, id) {
  const me = state.me?.id;
  if (!me) { body.innerHTML = '<div class="empty">创建角色后才能私信</div>'; return; }
  const msgs = await api(`/social/dm/${encodeURIComponent(id)}?uid=${encodeURIComponent(me)}`);
  const name = state.agents.get(id)?.name || state.players.get(id)?.name || id;
  body.innerHTML = `<div class="dm-thread"><button class="back" data-act="back">‹ ${esc(name)}</button>
    <div class="dm-msgs" id="dm-msgs">${msgs.map((m) => dmMsgHtml(m)).join('') || `<div class="stamp">和 ${esc(name)} 打个招呼吧</div>`}</div>
    <form class="dm-form" data-to="${esc(id)}"><input placeholder="发消息…" maxlength="400" /><button class="pbtn">发送</button></form></div>`;
  const box = $('#dm-msgs');
  box.scrollTop = box.scrollHeight;
  body.querySelector('.dm-form input').focus();
}

function dmMsgHtml(m) {
  const mine = m.from === state.me?.id;
  return `<div class="msg ${mine ? 'me' : 'them'}" title="${esc(m.stamp || '')}">${esc(m.text)}</div>`;
}

async function onClick(e) {
  const t = e.target;
  const postEl = t.closest('.post');
  const act = t.closest('[data-act]')?.dataset.act;
  if (t.dataset.mode) { feedMode = t.dataset.mode; return render(); }
  if (t.closest('[data-tag]')) { tagFilter = t.closest('[data-tag]').dataset.tag; tab = 'feed'; view = null; syncNav(); return render(); }
  if (t.closest('[data-follow]')) {
    if (!needMe()) return;
    const id = t.closest('[data-follow]').dataset.follow;
    const r = await api(`/social/follow/${encodeURIComponent(id)}`, { uid: state.me.id });
    toast(r.following ? '已关注' : '已取消关注');
    return render();
  }
  if (t.closest('[data-dm]')) { view = { type: 'dm', id: t.closest('[data-dm]').dataset.dm }; return render(); }
  if (t.closest('[data-user]')) { view = { type: 'profile', id: t.closest('[data-user]').dataset.user }; return render(); }
  if (act === 'back') { view = null; return render(); }
  if (act === 'cleartag') { tagFilter = null; return render(); }
  if (act === 'post') {
    if (!needMe()) return;
    const ta = $('#compose');
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    await api('/social/post', { uid: state.me.id, text });
    return;
  }
  if (act === 'like' && postEl) {
    if (!needMe()) return;
    const p = await api(`/social/post/${postEl.dataset.pid}/like`, { uid: state.me.id });
    replacePost(p);
    return;
  }
  if (act === 'cmt' && postEl) {
    const f = postEl.querySelector('.cform');
    f.classList.toggle('hidden');
    f.querySelector('input').focus();
  }
}

async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const input = f.querySelector('input');
  const text = input.value.trim();
  if (!text || !needMe()) return;
  input.value = '';
  if (f.classList.contains('cform')) {
    const pid = f.closest('.post').dataset.pid;
    const p = await api(`/social/post/${pid}/comment`, { uid: state.me.id, text });
    replacePost(p);
  } else if (f.classList.contains('dm-form')) {
    await api('/social/dm', { uid: state.me.id, to: f.dataset.to, text });
  }
}

function replacePost(p) {
  document.querySelectorAll(`.post[data-pid="${p.id}"]`).forEach((el) => {
    const open = !el.querySelector('.cform').classList.contains('hidden');
    el.outerHTML = postHtml(p);
    if (open) document.querySelector(`.post[data-pid="${p.id}"] .cform`)?.classList.remove('hidden');
  });
}

// ---------------------------------------------------------------- 实时推送
export function onSocial(msg) {
  if (msg.kind === 'post') {
    if (state.me && msg.post.author === state.me.id) onSocial[`c${msg.post.id}`] = 0;
    const feed = $('#feed');
    if (isPhoneOpen() && feed && tab === 'feed' && !view && feedMode === 'all' && !tagFilter) {
      feed.insertAdjacentHTML('afterbegin', postHtml(msg.post));
    }
    if (state.me && msg.post.text.includes(`@${state.me.name}`) && msg.post.author !== state.me.id) {
      unread.notif++; badge();
      toast(`📱 ${msg.post.author_name} 在小镇圈提到了你`);
    }
  } else if (msg.kind === 'update') {
    const p = msg.post;
    if (isPhoneOpen()) {
      const el = document.querySelector(`.post[data-pid="${p.id}"]`);
      if (el && document.activeElement?.closest('.post') !== el) replacePost(p);
    }
    if (state.me && p.author === state.me.id) {
      const last = p.comments[p.comments.length - 1];
      if (last && last.author !== state.me.id && msg.kind === 'update' && last._seen !== true) {
        // 新评论提示（粗略：评论数增长时）
        const key = `c${p.id}`;
        const n = p.comments.length;
        if ((onSocial[key] || 0) < n) {
          if (onSocial[key] !== undefined) { toast(`💬 ${last.author_name} 评论了你的动态：${last.text.slice(0, 30)}`); unread.notif++; badge(); }
          onSocial[key] = n;
        }
      }
    }
  } else if (msg.kind === 'follow' && state.me && msg.to === state.me.id && msg.on) {
    toast(`➕ ${state.agents.get(msg.from)?.name || msg.from} 关注了你`);
    unread.notif++; badge();
  }
}

export function onDm(msg) {
  const m = msg.msg;
  const other = m.from === state.me?.id ? m.to : m.from;
  if (isPhoneOpen() && view?.type === 'dm' && view.id === other) {
    const box = $('#dm-msgs');
    if (box) { box.insertAdjacentHTML('beforeend', dmMsgHtml(m)); box.scrollTop = box.scrollHeight; }
    api(`/social/dm/${encodeURIComponent(other)}?uid=${encodeURIComponent(state.me.id)}`).catch(() => {});
    return;
  }
  if (m.from !== state.me?.id) {
    unread.dm++; badge();
    toast(`✉️ ${m.from_name}：${m.text.slice(0, 40)}`);
  }
}

function badge() {
  const n = unread.dm + unread.notif;
  const b = $('#phone-badge');
  b.textContent = n;
  b.classList.toggle('hidden', n === 0);
  $('#dm-dot').classList.toggle('hidden', unread.dm === 0);
  $('#notif-dot').classList.toggle('hidden', unread.notif === 0);
}

// 让自己发的帖子的评论计数初始化，避免启动时误报
export async function primeMyPosts() {
  if (!state.me) return;
  try {
    const ps = await api(`/social/feed?author=${encodeURIComponent(state.me.id)}&n=50`);
    ps.forEach((p) => { onSocial[`c${p.id}`] = p.comments.length; });
    const ns = await api(`/social/dms?uid=${encodeURIComponent(state.me.id)}`);
    unread.dm = ns.reduce((s, t) => s + t.unread, 0);
    badge();
  } catch { /* ignore */ }
}
