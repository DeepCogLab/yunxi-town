// WebSocket 实时通道 + REST 封装
const listeners = new Map();
let ws = null;
let retry = 0;

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
}

function dispatch(msg) {
  (listeners.get(msg.t) || []).forEach((fn) => fn(msg));
  (listeners.get('*') || []).forEach((fn) => fn(msg));
}

export function connect(pid) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws${pid ? `?pid=${encodeURIComponent(pid)}` : ''}`);
  ws.onopen = () => { retry = 0; dispatch({ t: 'open' }); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'batch') msg.items.forEach(dispatch);
    else dispatch(msg);
  };
  ws.onclose = () => {
    dispatch({ t: 'close' });
    retry = Math.min(retry + 1, 5);
    setTimeout(() => connect(pid), 800 * retry);
  };
}

export function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

export async function api(path, body, method) {
  const opt = { method: method || (body ? 'POST' : 'GET'), headers: {} };
  if (body) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(`/api${path}`, opt);
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail || detail; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return r.json();
}
