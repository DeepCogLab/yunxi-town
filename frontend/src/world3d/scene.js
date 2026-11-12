// 渲染器、相机、光照、昼夜循环与天气
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.setSize(window.innerWidth, window.innerHeight);
  labels.domElement.className = 'label-layer';
  container.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xbfd9ef, 70, 190);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 600);
  camera.position.set(0, 60, 70);

  const controls = new OrbitControls(camera, labels.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.minDistance = 8;
  controls.maxDistance = 140;
  controls.screenSpacePanning = false;

  const hemi = new THREE.HemisphereLight(0xdfefff, 0x6b7f52, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 260;
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);
  const moon = new THREE.DirectionalLight(0x8fa8ff, 0.0);
  moon.position.set(-40, 80, -30);
  scene.add(moon);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    labels.setSize(window.innerWidth, window.innerHeight);
  });

  const env = { renderer, labels, scene, camera, controls, hemi, sun, moon, nightFactor: 0 };
  env.rain = createRain(scene);
  return env;
}

// 天空关键帧：[小时, 天空色, 太阳强度, 半球光强度]
const SKY = [
  [0, 0x0b1430, 0.0, 0.18],
  [4.5, 0x16224a, 0.0, 0.22],
  [6, 0xf2a37a, 0.7, 0.55],
  [8, 0xa9d4f5, 1.9, 0.85],
  [12, 0x9fd0fa, 2.4, 0.95],
  [16.5, 0xa6cfee, 2.0, 0.9],
  [18.3, 0xf0956a, 0.9, 0.6],
  [19.6, 0x2a2f5e, 0.1, 0.3],
  [24, 0x0b1430, 0.0, 0.18],
];

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

export function updateDayNight(env, minuteOfDay, weather, focus) {
  const h = minuteOfDay / 60;
  let i = 0;
  while (i < SKY.length - 2 && h >= SKY[i + 1][0]) i++;
  const [h0, c0, s0, e0] = SKY[i];
  const [h1, c1, s1, e1] = SKY[i + 1];
  const t = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
  tmpA.setHex(c0).lerp(tmpB.setHex(c1), t);
  let sunI = s0 + (s1 - s0) * t;
  let hemiI = e0 + (e1 - e0) * t;

  const cloudy = { 多云: 0.75, 小雨: 0.55, 雷阵雨: 0.4, 雾: 0.6 }[weather] ?? 1;
  if (cloudy < 1) {
    const gray = new THREE.Color(0x8a96a3).multiplyScalar(0.4 + 0.6 * Math.min(1, sunI / 2));
    tmpA.lerp(gray, 1 - cloudy);
    sunI *= cloudy;
    hemiI *= 0.8 + 0.2 * cloudy;
  }
  env.scene.background = tmpA.clone();
  env.scene.fog.color.copy(tmpA);
  if (weather === '雾') { env.scene.fog.near = 10; env.scene.fog.far = 70; }
  else if (weather === '小雨' || weather === '雷阵雨') { env.scene.fog.near = 40; env.scene.fog.far = 140; }
  else { env.scene.fog.near = 80; env.scene.fog.far = 220; }

  // 太阳轨迹：6 点东升，18 点西落
  const ang = ((h - 6) / 12) * Math.PI;
  const cx = focus?.x || 0;
  const cz = focus?.z || 0;
  env.sun.position.set(cx + Math.cos(ang) * 80, Math.max(8, Math.sin(ang) * 90), cz + 35);
  env.sun.target.position.set(cx, 0, cz);
  env.sun.intensity = sunI;
  env.sun.color.setHSL(0.09, 0.6, 0.6 + 0.3 * Math.min(1, sunI / 2.4));
  env.hemi.intensity = hemiI;
  env.nightFactor = Math.max(0, Math.min(1, 1 - (sunI - 0.1) / 0.9));
  env.moon.intensity = 0.35 * env.nightFactor;
  env.renderer.toneMappingExposure = 1.0 + 0.25 * env.nightFactor;
  env.rain.setMode(weather);
}

function createRain(scene) {
  const N = 4000;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 120;
    pos[i * 3 + 1] = Math.random() * 50;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 120;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xaecbe8, size: 0.18, transparent: true, opacity: 0.7, depthWrite: false });
  const pts = new THREE.Points(geo, mat);
  pts.visible = false;
  pts.frustumCulled = false;
  scene.add(pts);
  let mode = '';
  let flash = 0;
  return {
    setMode(w) {
      mode = w;
      pts.visible = w === '小雨' || w === '雷阵雨';
      mat.size = w === '雷阵雨' ? 0.24 : 0.16;
    },
    update(dt, focus, env) {
      if (!pts.visible) return;
      pts.position.set(focus.x, 0, focus.z);
      const speed = mode === '雷阵雨' ? 60 : 38;
      for (let i = 0; i < N; i++) {
        let y = pos[i * 3 + 1] - speed * dt;
        if (y < 0) y += 50;
        pos[i * 3 + 1] = y;
      }
      geo.attributes.position.needsUpdate = true;
      if (mode === '雷阵雨') {
        if (flash > 0) {
          flash -= dt;
          env.hemi.intensity += 2.5 * Math.max(0, flash);
        } else if (Math.random() < dt * 0.08) {
          flash = 0.35;
        }
      }
    },
  };
}
