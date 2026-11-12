// 全局共享状态
export const state = {
  me: null,          // {id, name, bio, color, x, y}
  map: null,
  town: '云溪镇',
  agents: new Map(), // id -> {static + brief}
  players: new Map(),
  clock: { label: '', mod: 390, period: '清晨', speed: 1, paused: false },
  weather: '晴',
  llm: {},
  chatWith: null,
  observer: false,
  selected: null,
  locations: new Map(),
};

export const TS = 2; // 1 格 = 2 米

export function toWorld(x, y) {
  const half = (state.map?.size || 46) / 2;
  return [(x - half) * TS, (y - half) * TS];
}

export function toTile(wx, wz) {
  const half = (state.map?.size || 46) / 2;
  return [wx / TS + half, wz / TS + half];
}

export function nameOf(id) {
  if (state.agents.has(id)) return state.agents.get(id).name;
  if (state.players.has(id)) return state.players.get(id).name;
  if (state.me && state.me.id === id) return state.me.name;
  return id;
}

export function colorOf(id) {
  const a = state.agents.get(id);
  if (a) return a.colors.shirt;
  const p = state.players.get(id);
  if (p) return p.color;
  if (state.me && state.me.id === id) return state.me.color;
  return '#888';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
