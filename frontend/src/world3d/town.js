// 根据后端地图数据程序化生成低多边形小镇
import * as THREE from 'three';
import { TS, toWorld } from '../state.js';

const STYLE = {
  house: { h: 3.4, walls: ['#f4e9d8', '#e8d5c4', '#dfe8ef', '#f1dfe3', '#e3ecd9'], roof: ['#c0573e', '#7a4e3a', '#4c6a8d', '#9b5b4b', '#5f7d4f'], roofType: 'gable' },
  inn: { h: 6.2, walls: ['#f6e7c9'], roof: ['#3f6f5c'], roofType: 'gable', floors: 2 },
  studio: { h: 4.6, walls: ['#cfe3ee'], roof: ['#37474f'], roofType: 'flat', glass: true },
  post: { h: 3.8, walls: ['#cfe6c8'], roof: ['#2e7d32'], roofType: 'flat' },
  school: { h: 6.5, walls: ['#f3e0b5'], roof: ['#b5523b'], roofType: 'gable', floors: 2 },
  library: { h: 5.6, walls: ['#d9d4c7'], roof: ['#5a5f6b'], roofType: 'gable', columns: true },
  cafe: { h: 4.0, walls: ['#e9d3b8'], roof: ['#6d4c41'], roofType: 'flat', awning: '#d9826b' },
  bakery: { h: 4.0, walls: ['#fbefd5'], roof: ['#b23a2f'], roofType: 'gable', awning: '#e8b44f' },
  market: { h: 3.2, walls: ['#d7c29e'], roof: ['#e57a44'], roofType: 'stalls' },
  clinic: { h: 4.4, walls: ['#f7f9fa'], roof: ['#9fb3c0'], roofType: 'flat', cross: true },
  townhall: { h: 7.0, walls: ['#ece3d0'], roof: ['#8a3b2e'], roofType: 'gable', tower: true, floors: 2 },
  tavern: { h: 4.4, walls: ['#8d6748'], roof: ['#3e2c22'], roofType: 'gable', awning: '#7b2d26' },
};

const GROUND = {
  grass: '#8fbf6a', road: '#6c6f73', plaza: '#d8cbb3', park: '#7fb35c', lot: '#cdbf9c', house: '#a9c98a', water: '#5ea9d6',
};

export function buildTown(env, map) {
  const group = new THREE.Group();
  env.scene.add(group);
  const night = { windows: [], lamps: [], lampLights: [] };
  const size = map.size;
  const W = size * TS;

  // ---------------- 地面贴图
  const px = 16;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size * px;
  const g = cv.getContext('2d');
  g.fillStyle = GROUND.grass;
  g.fillRect(0, 0, cv.width, cv.height);
  // 草地噪点
  for (let i = 0; i < 6000; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    g.fillRect(Math.random() * cv.width, Math.random() * cv.height, 2, 2);
  }
  for (const loc of map.locations) {
    const [x, y, w, h] = loc.rect;
    const t = loc.type;
    g.fillStyle = t === 'plaza' ? GROUND.plaza : t === 'park' ? GROUND.park : t === 'house' ? GROUND.house : GROUND.lot;
    g.fillRect(x * px, y * px, w * px, h * px);
    if (t === 'plaza') {
      g.strokeStyle = 'rgba(120,100,70,0.25)';
      for (let i = 0; i <= w * 2; i++) {
        g.beginPath(); g.moveTo((x + i / 2) * px, y * px); g.lineTo((x + i / 2) * px, (y + h) * px); g.stroke();
        g.beginPath(); g.moveTo(x * px, (y + i / 2) * px); g.lineTo((x + w) * px, (y + i / 2) * px); g.stroke();
      }
      g.strokeStyle = 'rgba(160,130,90,0.6)'; g.lineWidth = 6;
      g.beginPath(); g.arc((x + w / 2) * px, (y + h / 2) * px, 3.6 * px, 0, Math.PI * 2); g.stroke(); g.lineWidth = 1;
    }
    if (t === 'park') {
      g.strokeStyle = '#d8c79a'; g.lineWidth = px * 0.8; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x * px, (y + 2) * px); g.bezierCurveTo((x + 4) * px, (y + 1) * px, (x + 2) * px, (y + 9) * px, (x + w) * px, (y + 10) * px); g.stroke();
      g.lineWidth = 1;
    }
  }
  for (const r of map.roads) {
    g.fillStyle = GROUND.road;
    g.fillRect(0, r * px, cv.width, 2 * px);
    g.fillRect(r * px, 0, 2 * px, cv.height);
  }
  g.strokeStyle = 'rgba(255,240,200,0.7)'; g.setLineDash([px * 0.8, px * 0.8]); g.lineWidth = 2;
  for (const r of map.roads) {
    g.beginPath(); g.moveTo(0, (r + 1) * px); g.lineTo(cv.width, (r + 1) * px); g.stroke();
    g.beginPath(); g.moveTo((r + 1) * px, 0); g.lineTo((r + 1) * px, cv.height); g.stroke();
  }
  g.setLineDash([]);
  // 人行道边线
  g.strokeStyle = 'rgba(230,230,230,0.6)'; g.lineWidth = 3;
  for (const r of map.roads) {
    for (const off of [0, 2]) {
      g.beginPath(); g.moveTo(0, (r + off) * px); g.lineTo(cv.width, (r + off) * px); g.stroke();
      g.beginPath(); g.moveTo((r + off) * px, 0); g.lineTo((r + off) * px, cv.height); g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, W), new THREE.MeshLambertMaterial({ map: tex }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  group.add(ground);
  // 外围大草地
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(W * 6, W * 6), new THREE.MeshLambertMaterial({ color: 0x7aa95a }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.05;
  outer.receiveShadow = true;
  group.add(outer);
  addHills(group, W);

  // ---------------- 建筑
  const rnd = mulberry(42);
  const buildingMeshes = [];
  for (const loc of map.locations) {
    if (!loc.building) continue;
    const b = makeBuilding(loc, rnd, night);
    group.add(b);
    b.traverse((o) => { if (o.isMesh) { o.userData.locId = loc.id; buildingMeshes.push(o); } });
  }

  // ---------------- 装饰
  const water = [];
  for (const d of map.decor) {
    const [wx, wz] = toWorld(d.x, d.y);
    let obj = null;
    if (d.type === 'tree') obj = makeTree(rnd, d.big);
    else if (d.type === 'lamp') obj = makeLamp(night);
    else if (d.type === 'bench') obj = makeBench(d.rot || 0);
    else if (d.type === 'fountain') { obj = makeFountain(water); }
    else if (d.type === 'pond') { obj = makePond(d.w * TS, d.h * TS, water); }
    else if (d.type === 'stage') obj = makeStage();
    if (obj) { obj.position.set(wx, 0, wz); group.add(obj); }
  }
  // 少量真实点光源（广场/酒馆附近）
  for (const lid of ['plaza', 'tavern', 'cafe']) {
    const loc = map.locations.find((l) => l.id === lid);
    if (!loc) continue;
    const [wx, wz] = toWorld(loc.center[0], loc.center[1]);
    const pl = new THREE.PointLight(0xffc27a, 0, 28, 1.6);
    pl.position.set(wx, 4, wz);
    group.add(pl);
    night.lampLights.push(pl);
  }

  return {
    group,
    buildingMeshes,
    update(env2, t) {
      const n = env2.nightFactor;
      for (const m of night.windows) m.emissiveIntensity = 0.05 + n * 1.4;
      for (const m of night.lamps) m.emissiveIntensity = n * 2.5;
      for (const l of night.lampLights) l.intensity = n * 40;
      for (const w of water) w.material.color.setHSL(0.56, 0.55, 0.55 + Math.sin(t * 1.5) * 0.03);
    },
  };
}

// ---------------------------------------------------------------- builders
function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0, flatShading: true, ...opts });
}

function shadow(o) {
  o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  return o;
}

function makeBuilding(loc, rnd, night) {
  const st = STYLE[loc.type] || STYLE.house;
  const [bx, by, bw, bh] = loc.building;
  const [cx, cz] = toWorld(bx + bw / 2, by + bh / 2);
  const w = bw * TS - 0.6;
  const d = bh * TS - 0.6;
  const H = st.h;
  const grp = new THREE.Group();
  grp.position.set(cx, 0, cz);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const wallColor = pick(st.walls);
  const roofColor = pick(st.roof);
  const front = loc.front === 'n' ? -1 : 1; // 门朝 +z (s) 或 -z (n)

  if (st.roofType === 'stalls') {
    // 菜市场：一排摊位
    const n = 4;
    for (let i = 0; i < n; i++) {
      const sx = -w / 2 + (i + 0.5) * (w / n);
      const stall = new THREE.Group();
      const table = new THREE.Mesh(new THREE.BoxGeometry(w / n - 0.8, 1, 2.4), mat('#8d6e4c'));
      table.position.y = 0.5;
      stall.add(table);
      const colors = ['#e74c3c', '#f1c40f', '#27ae60', '#e67e22'];
      for (let k = 0; k < 6; k++) {
        const veg = new THREE.Mesh(new THREE.SphereGeometry(0.28, 6, 5), mat(colors[(i + k) % 4]));
        veg.position.set(-1 + (k % 3) * 0.9, 1.2, -0.5 + Math.floor(k / 3) * 0.9);
        stall.add(veg);
      }
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(w / n - 0.4, 0.15, 3.4), mat(i % 2 ? roofColor : '#f4f1ea'));
      canopy.position.y = 3;
      canopy.rotation.x = 0.12 * front;
      stall.add(canopy);
      for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3), mat('#5d4037'));
        post.position.set(px * (w / n / 2 - 0.4), 1.5, pz * 1.5);
        stall.add(post);
      }
      stall.position.x = sx;
      grp.add(stall);
    }
    addSign(grp, loc.name, 0, 3.8, front * (d / 2 + 0.2), front);
    return shadow(grp);
  }

  const walls = new THREE.Mesh(new THREE.BoxGeometry(w, H, d), mat(wallColor));
  walls.position.y = H / 2;
  grp.add(walls);
  // 墙基
  const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.5, d + 0.2), mat('#8b8378'));
  base.position.y = 0.25;
  grp.add(base);

  // 屋顶
  if (st.roofType === 'gable') {
    const roofH = Math.min(w, d) * 0.45;
    const shape = new THREE.Shape();
    shape.moveTo(-d / 2 - 0.5, 0);
    shape.lineTo(0, roofH);
    shape.lineTo(d / 2 + 0.5, 0);
    shape.lineTo(-d / 2 - 0.5, 0);
    const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: w + 0.8, bevelEnabled: false }), mat(roofColor));
    roof.rotation.y = Math.PI / 2;
    roof.position.set(-(w + 0.8) / 2, H, 0);
    grp.add(roof);
  } else {
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.5, d + 0.6), mat(roofColor));
    roof.position.y = H + 0.25;
    grp.add(roof);
  }

  // 窗户（夜晚发光）
  const winMat = new THREE.MeshStandardMaterial({ color: '#41546b', emissive: '#ffcf7a', emissiveIntensity: 0.1, roughness: 0.3 });
  night.windows.push(winMat);
  const floors = st.floors || 1;
  const nx = Math.max(1, Math.floor(w / 3.2));
  for (let f = 0; f < floors; f++) {
    const y = (H / floors) * (f + 0.62);
    for (let i = 0; i < nx; i++) {
      const x = -w / 2 + (i + 0.5) * (w / nx);
      if (f === 0 && Math.abs(x) < 1.4) continue; // 门的位置
      for (const side of [1, -1]) {
        const win = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 0.1), winMat);
        win.position.set(x, y, side * (d / 2 + 0.03));
        grp.add(win);
      }
    }
  }
  // 门
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.3, 0.12), mat('#5b3a29'));
  door.position.set(0, 1.15, front * (d / 2 + 0.05));
  grp.add(door);

  if (st.glass) {
    const glass = new THREE.Mesh(new THREE.BoxGeometry(w * 0.8, H * 0.6, 0.1), new THREE.MeshStandardMaterial({ color: '#7fc8f8', transparent: true, opacity: 0.6, emissive: '#5fb0ff', emissiveIntensity: 0.1 }));
    night.windows.push(glass.material);
    glass.position.set(0, H * 0.55, front * (d / 2 + 0.06));
    grp.add(glass);
  }
  if (st.awning) {
    const aw = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.12, 1.6), mat(st.awning));
    aw.position.set(0, 2.9, front * (d / 2 + 0.8));
    aw.rotation.x = -0.25 * front;
    grp.add(aw);
    // 户外桌椅
    for (const sx of [-w / 3, w / 3]) {
      const t = makeTable();
      t.position.set(sx, 0, front * (d / 2 + 2.6));
      grp.add(t);
    }
  }
  if (st.cross) {
    const c1 = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.15), mat('#e53935', { emissive: '#e53935', emissiveIntensity: 0.3 }));
    const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.6, 0.15), c1.material);
    c1.position.set(w / 2 - 1.5, H - 0.9, front * (d / 2 + 0.1));
    c2.position.copy(c1.position);
    grp.add(c1, c2);
  }
  if (st.columns) {
    for (let i = 0; i < 4; i++) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, H - 0.4, 8), mat('#f0ece2'));
      col.position.set(-w / 2 + 1.5 + i * ((w - 3) / 3), H / 2, front * (d / 2 + 0.7));
      grp.add(col);
    }
  }
  if (st.tower) {
    const tower = new THREE.Mesh(new THREE.BoxGeometry(2.6, 4, 2.6), mat(wallColor));
    tower.position.set(0, H + 2.6, 0);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(2.2, 2.4, 4), mat(roofColor));
    cap.position.set(0, H + 5.8, 0);
    cap.rotation.y = Math.PI / 4;
    const clock = new THREE.Mesh(new THREE.CircleGeometry(0.8, 16), mat('#fffaf0', { emissive: '#fff3c4', emissiveIntensity: 0.2 }));
    clock.position.set(0, H + 3, front * 1.32);
    if (front < 0) clock.rotation.y = Math.PI;
    grp.add(tower, cap, clock);
    night.windows.push(clock.material);
  }
  if (loc.type === 'school') {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 9), mat('#cccccc', { metalness: 0.6 }));
    pole.position.set(w / 2 + 1.2, 4.5, front * (d / 2 + 3));
    const flag = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.1, 0.05), mat('#d62828'));
    flag.position.set(w / 2 + 2.1, 8.3, front * (d / 2 + 3));
    grp.add(pole, flag);
  }
  if (loc.type === 'tavern') {
    for (const sx of [-w / 2 + 0.8, w / 2 - 0.8]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.2, 10), mat('#7b4f2c'));
      barrel.position.set(sx, 0.6, front * (d / 2 + 0.9));
      grp.add(barrel);
    }
  }
  if (loc.type === 'post') {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.4, 0.6), mat('#2e7d32'));
    box.position.set(w / 2 - 0.8, 0.7, front * (d / 2 + 0.8));
    grp.add(box);
  }
  if (loc.type === 'house') {
    const chim = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.8, 0.7), mat('#8d6e63'));
    chim.position.set(w / 4, H + 1.4, -d / 5);
    grp.add(chim);
  }
  addSign(grp, loc.name, 0, loc.type === 'house' ? 2.75 : Math.min(H - 0.7, 3.6), front * (d / 2 + 0.12), front, loc.type === 'house');
  return shadow(grp);
}

function addSign(grp, text, x, y, z, front, small = false) {
  const cv = document.createElement('canvas');
  const fs = 56;
  const ctx = cv.getContext('2d');
  ctx.font = `bold ${fs}px "Microsoft YaHei","PingFang SC",sans-serif`;
  const tw = ctx.measureText(text).width;
  cv.width = Math.ceil(tw + 48);
  cv.height = fs + 30;
  ctx.font = `bold ${fs}px "Microsoft YaHei","PingFang SC",sans-serif`;
  ctx.fillStyle = small ? '#fdf6e3' : '#3b2a20';
  roundRect(ctx, 0, 0, cv.width, cv.height, 18);
  ctx.fill();
  ctx.fillStyle = small ? '#4a3a2a' : '#fbe7c6';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 24, cv.height / 2 + 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const hgt = small ? 0.55 : 0.9;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry((cv.width / cv.height) * hgt, hgt), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  sign.position.set(x, y, z + front * 0.02);
  if (front < 0) sign.rotation.y = Math.PI;
  grp.add(sign);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeTree(rnd, big) {
  const g = new THREE.Group();
  const s = (big ? 1.25 : 0.9) * (0.8 + rnd() * 0.4);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * s, 0.28 * s, 1.6 * s, 6), mat('#6d4c35'));
  trunk.position.y = 0.8 * s;
  g.add(trunk);
  const greens = ['#4f8a3c', '#5e9c45', '#3f7a3a', '#6aa84f'];
  if (rnd() < 0.5) {
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry((1.5 - i * 0.35) * s, 1.7 * s, 7), mat(greens[Math.floor(rnd() * 4)]));
      cone.position.y = (2 + i * 0.9) * s;
      g.add(cone);
    }
  } else {
    const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4 * s, 0), mat(greens[Math.floor(rnd() * 4)]));
    ball.position.y = 2.6 * s;
    g.add(ball);
    const b2 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 * s, 0), mat(greens[Math.floor(rnd() * 4)]));
    b2.position.set(0.6 * s, 3.2 * s, 0.3 * s);
    g.add(b2);
  }
  g.rotation.y = rnd() * Math.PI;
  return shadow(g);
}

function makeLamp(night) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 3.6, 6), mat('#37474f', { metalness: 0.5 }));
  pole.position.y = 1.8;
  const bulbMat = new THREE.MeshStandardMaterial({ color: '#fff3d0', emissive: '#ffcc70', emissiveIntensity: 0 });
  night.lamps.push(bulbMat);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), bulbMat);
  bulb.position.y = 3.7;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.3, 6), mat('#263238'));
  cap.position.y = 4.0;
  g.add(pole, bulb, cap);
  pole.castShadow = true;
  return g;
}

function makeBench(rot) {
  const g = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.15, 0.7), mat('#a0714f'));
  seat.position.y = 0.55;
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.6, 0.1), mat('#a0714f'));
  back.position.set(0, 0.9, -0.32);
  for (const x of [-0.9, 0.9]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.55, 0.6), mat('#333'));
    leg.position.set(x, 0.27, 0);
    g.add(leg);
  }
  g.add(seat, back);
  g.rotation.y = (rot * Math.PI) / 180;
  return shadow(g);
}

function makeTable() {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.08, 10), mat('#f5f5f5'));
  top.position.y = 0.95;
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.95), mat('#444'));
  leg.position.y = 0.47;
  const umb = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.5, 8), mat('#e57373'));
  umb.position.y = 2.3;
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4), mat('#666'));
  stick.position.y = 1.6;
  g.add(top, leg, umb, stick);
  return g;
}

function makeFountain(water) {
  const g = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 3.1, 0.8, 16), mat('#bdb3a4'));
  rim.position.y = 0.4;
  const w = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.1, 16), new THREE.MeshStandardMaterial({ color: '#5ea9d6', roughness: 0.1, metalness: 0.2 }));
  w.position.y = 0.75;
  water.push(w);
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 2.2, 8), mat('#d7cfc0'));
  col.position.y = 1.4;
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 0.6, 0.4, 12), mat('#d7cfc0'));
  bowl.position.y = 2.5;
  const spray = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 8), new THREE.MeshStandardMaterial({ color: '#cfeaff', transparent: true, opacity: 0.6 }));
  spray.position.y = 3.2;
  g.add(rim, w, col, bowl, spray);
  return shadow(g);
}

function makePond(w, h, water) {
  const g = new THREE.Group();
  const p = new THREE.Mesh(new THREE.CircleGeometry(1, 24), new THREE.MeshStandardMaterial({ color: '#5ea9d6', roughness: 0.15, metalness: 0.1 }));
  p.scale.set(w / 2, h / 2, 1);
  p.rotation.x = -Math.PI / 2;
  p.position.y = 0.05;
  water.push(p);
  g.add(p);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.35 + Math.random() * 0.25, 0), mat('#9e9e9e'));
    rock.position.set(Math.cos(a) * w / 2, 0.15, Math.sin(a) * h / 2);
    g.add(rock);
  }
  const lily = new THREE.Mesh(new THREE.CircleGeometry(0.4, 8), mat('#4caf50'));
  lily.rotation.x = -Math.PI / 2;
  lily.position.set(1, 0.08, 0.5);
  g.add(lily);
  return g;
}

function makeStage() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(6, 0.6, 1.4), mat('#8d6e63'));
  base.position.y = 0.3;
  g.add(base);
  return shadow(g);
}

function addHills(group, W) {
  const rnd = mulberry(9);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rnd() * 0.2;
    const r = W * (1.35 + rnd() * 0.6);
    const s = 20 + rnd() * 28;
    const hill = new THREE.Mesh(new THREE.ConeGeometry(s, s * (0.45 + rnd() * 0.45), 6), mat(rnd() < 0.5 ? '#6b9a52' : '#5d8a4a'));
    hill.position.set(Math.cos(a) * r, s * 0.25, Math.sin(a) * r);
    group.add(hill);
  }
}

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
