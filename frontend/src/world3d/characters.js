// 低多边形角色：身体、走路动画、头顶名牌与对话气泡
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { esc, toWorld } from '../state.js';

function m(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, flatShading: true });
}

export class Character {
  static onPick = null;

  constructor(scene, opts) {
    this.id = opts.id;
    this.isPlayer = !!opts.isPlayer;
    this.isMe = !!opts.isMe;
    const c = opts.colors || { shirt: opts.color || '#4f9dff', pants: '#2f3b52', hair: '#2b1d14', skin: '#f1cfb1' };
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const legGeo = new THREE.BoxGeometry(0.32, 0.9, 0.34);
    legGeo.translate(0, -0.45, 0);
    this.legL = new THREE.Mesh(legGeo, m(c.pants));
    this.legR = new THREE.Mesh(legGeo, m(c.pants));
    this.legL.position.set(-0.2, 0.9, 0);
    this.legR.position.set(0.2, 0.9, 0);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.0, 0.5), m(c.shirt));
    torso.position.y = 1.4;
    const armGeo = new THREE.BoxGeometry(0.24, 0.85, 0.26);
    armGeo.translate(0, -0.4, 0);
    this.armL = new THREE.Mesh(armGeo, m(c.shirt));
    this.armR = new THREE.Mesh(armGeo, m(c.shirt));
    this.armL.position.set(-0.56, 1.85, 0);
    this.armR.position.set(0.56, 1.85, 0);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.6), m(c.skin));
    head.position.y = 2.25;
    const hair = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.24, 0.66), m(c.hair));
    hair.position.y = 2.6;
    const hairBack = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.5, 0.18), m(c.hair));
    hairBack.position.set(0, 2.35, -0.27);
    const eyeMat = m('#222');
    const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.02), eyeMat);
    const eyeR = eyeL.clone();
    eyeL.position.set(-0.14, 2.3, 0.31);
    eyeR.position.set(0.14, 2.3, 0.31);
    body.add(this.legL, this.legR, torso, this.armL, this.armR, head, hair, hairBack, eyeL, eyeR);
    body.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.userData.charId = this.id; } });
    // 隐形的放大点击范围
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 3.4, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 1.7;
    hit.userData.charId = this.id;
    body.add(hit);
    this.body = body;

    if (this.isMe || this.isPlayer) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.9, 24), new THREE.MeshBasicMaterial({ color: this.isMe ? '#ffd166' : c.shirt, transparent: true, opacity: 0.85 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      root.add(ring);
    }
    // 选中光圈
    this.sel = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.1, 32), new THREE.MeshBasicMaterial({ color: '#7cf', transparent: true, opacity: 0.9 }));
    this.sel.rotation.x = -Math.PI / 2;
    this.sel.position.y = 0.06;
    this.sel.visible = false;
    root.add(this.sel);

    // 名牌
    const tag = document.createElement('div');
    tag.className = `nametag${this.isMe ? ' me' : ''}${this.isPlayer ? ' player' : ''}`;
    this.tagEl = tag;
    tag.addEventListener('click', (e) => { e.stopPropagation(); Character.onPick?.(this.id); });
    this.label = new CSS2DObject(tag);
    this.label.position.set(0, 3.25, 0);
    root.add(this.label);
    // 气泡
    const bub = document.createElement('div');
    bub.className = 'bubble hidden';
    this.bubbleEl = bub;
    this.bubble = new CSS2DObject(bub);
    this.bubble.position.set(0, 4.1, 0);
    root.add(this.bubble);
    this.bubbleTimer = 0;

    this.root = root;
    scene.add(root);
    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.heading = 0;
    this.walk = 0;
    this.speed = 0;
    this.visible = true;
    this.name = opts.name;
    this.setTag(opts.name, opts.emoji || '', opts.activity || '');
  }

  setTag(name, emoji, activity) {
    const key = `${name}|${emoji}|${activity}`;
    if (key === this._tagKey) return;
    this._tagKey = key;
    this.tagEl.innerHTML = `<b>${esc(emoji)} ${esc(name)}</b>${activity ? `<small>${esc(activity)}</small>` : ''}`;
  }

  place(x, y) {
    const [wx, wz] = toWorld(x, y);
    this.target.set(wx, 0, wz);
    this.pos.copy(this.target);
    this.root.position.copy(this.pos);
  }

  setTarget(x, y) {
    const [wx, wz] = toWorld(x, y);
    this.target.set(wx, 0, wz);
  }

  faceTo(x, y) {
    const [wx, wz] = toWorld(x, y);
    this.faceTarget = new THREE.Vector3(wx, 0, wz);
  }

  say(text, ms = 5000) {
    this.bubbleEl.textContent = text;
    this.bubbleEl.classList.remove('hidden');
    this.bubbleTimer = ms / 1000;
  }

  setVisible(v) {
    if (v === this.visible) return;
    this.visible = v;
    this.root.visible = v;
    this.tagEl.style.display = v ? '' : 'none';
    this.bubbleEl.style.display = v ? '' : 'none';
  }

  setSelected(v) { this.sel.visible = v; }

  update(dt, direct = false) {
    const prev = this.root.position.clone();
    if (!direct) {
      const k = 1 - Math.exp(-dt * 8);
      this.pos.lerp(this.target, k);
      if (this.pos.distanceTo(this.target) > 12) this.pos.copy(this.target);
    } else {
      this.pos.copy(this.target);
    }
    this.root.position.copy(this.pos);
    const moved = prev.distanceTo(this.pos);
    const sp = dt > 0 ? moved / dt : 0;
    this.speed += (sp - this.speed) * Math.min(1, dt * 10);
    if (moved > 0.002) {
      const want = Math.atan2(this.pos.x - prev.x, this.pos.z - prev.z);
      this.heading = lerpAngle(this.heading, want, Math.min(1, dt * 12));
      this.faceTarget = null;
    } else if (this.faceTarget) {
      const want = Math.atan2(this.faceTarget.x - this.pos.x, this.faceTarget.z - this.pos.z);
      this.heading = lerpAngle(this.heading, want, Math.min(1, dt * 8));
    }
    this.body.rotation.y = this.heading;
    const walking = this.speed > 0.4;
    this.walk += dt * (walking ? Math.min(14, 4 + this.speed * 2) : 0);
    const amp = walking ? 0.6 : 0;
    const s = Math.sin(this.walk) * amp;
    this.legL.rotation.x = s;
    this.legR.rotation.x = -s;
    this.armL.rotation.x = -s * 0.8;
    this.armR.rotation.x = s * 0.8;
    this.body.position.y = walking ? Math.abs(Math.sin(this.walk)) * 0.08 : Math.sin(performance.now() / 600) * 0.015;
    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dt;
      if (this.bubbleTimer <= 0) this.bubbleEl.classList.add('hidden');
    }
  }

  dispose(scene) {
    scene.remove(this.root);
    this.tagEl.remove();
    this.bubbleEl.remove();
  }
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
