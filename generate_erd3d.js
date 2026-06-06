/**
 * generate_erd3d.js
 * Generates an interactive 3D Entity Relationship Diagram (HTML) from tables.json.
 *
 * Usage: node generate_erd3d.js [tables.json path] [output directory]
 *
 * Auto-computes FK-depth levels and domain groupings from the table definitions.
 * Tables may optionally include a "domain" property to override auto-assignment.
 */
const fs   = require('fs');
const path = require('path');

const isMain = require.main === module;
const jsonPath = (isMain && process.argv[2])
  ? path.resolve(process.argv[2])
  : path.join(__dirname, 'tables.json');
const tables = require(jsonPath);

// ── Helpers ──────────────────────────────────────────────────────────────────

function simplifyType(t) {
  return t.replace('datetime2(7)', 'datetime2');
}

function labelToDef(label) {
  if (!label) return null;
  if (label === 'empty' || label === 'empty_string') return "''";
  if (/^\d+$/.test(label)) return label;
  return `'${label}'`;
}

function getCheckCol(expr) {
  const isNullOr = expr.match(/^(\w+) IS NULL OR /);
  if (isNullOr) return isNullOr[1];
  const first = expr.match(/^(\w+)\s/);
  return first ? first[1] : null;
}

function parseCk(expr) {
  const clean = expr.replace(/^\w+ IS NULL OR \w+ /, '');
  const inMatch = clean.match(/^IN \(([^)]+)\)/);
  if (inMatch) return inMatch[1].split(',').map(v => v.trim().replace(/'/g, '')).join('|');
  const between = clean.match(/^BETWEEN (\d+) AND (\d+)/);
  if (between) return `${between[1]}–${between[2]}`;
  const gte = expr.match(/\w+ (>=? \d+)/);
  if (gte) return gte[1];
  return null;
}

// ── Build fields array for one table ──────────────────────────────────────────

function buildFields(table) {
  const name  = table.name;
  const pkDef = table.useNewId ? 'newid()' : 'newseqid()';

  const fkMap = {};
  for (const fk of (table.fks || [])) fkMap[fk.col] = fk.refTable;

  const uqCols = new Set();
  for (const u of (table.uniques || [])) {
    if (u.cols.length === 1 && !u.filter) uqCols.add(u.cols[0]);
  }

  const ckMap = {};
  for (const ck of (table.checks || [])) {
    const col = getCheckCol(ck.expr);
    if (col) { const val = parseCk(ck.expr); if (val) ckMap[col] = val; }
  }

  const fields = [];
  fields.push({ n: `${name}_id`, t: 'uniqueidentifier', pk: 1, def: pkDef });

  for (const col of (table.columns || [])) {
    const f = { n: col.name, t: simplifyType(col.type) };
    if (fkMap[col.name]) f.fk = fkMap[col.name];
    if (col.nullable)    f.null = 1;
    const def = labelToDef(col.defaultLabel);
    if (def)             f.def = def;
    if (uqCols.has(col.name)) f.uq = 1;
    if (ckMap[col.name]) f.ck = ckMap[col.name];
    fields.push(f);
  }

  fields.push({ n: 'modified', t: 'datetime2', def: 'getutcdate()' });
  fields.push({ n: 'created',  t: 'datetime2', def: 'getutcdate()' });

  return fields;
}

// ── Auto-compute FK-depth levels ──────────────────────────────────────────────

function computeLevels(tables) {
  const nameSet = new Set(tables.map(t => t.name));
  const deps = {};  // tableName -> Set of tables it depends on
  for (const t of tables) {
    deps[t.name] = new Set();
    for (const fk of (t.fks || [])) {
      if (fk.refTable !== t.name && nameSet.has(fk.refTable)) {
        deps[t.name].add(fk.refTable);
      }
    }
  }

  const depth = {};
  function getDepth(name, visited) {
    if (depth[name] !== undefined) return depth[name];
    if (visited.has(name)) return 0; // circular
    visited.add(name);
    let max = -1;
    for (const dep of deps[name]) {
      max = Math.max(max, getDepth(dep, visited));
    }
    depth[name] = max + 1;
    return depth[name];
  }

  for (const t of tables) getDepth(t.name, new Set());

  const maxDepth = Math.max(...Object.values(depth), 0);
  const levels = [];
  for (let i = 0; i <= maxDepth; i++) {
    levels.push(tables.filter(t => depth[t.name] === i).map(t => t.name));
  }
  return levels;
}

// ── Auto-assign domains via connected components ──────────────────────────────

const DOMAIN_PALETTE = [
  { name: 'primary',   hex: '0x1d4ed8', css: '#1d4ed8' },
  { name: 'emerald',   hex: '0x047857', css: '#047857' },
  { name: 'amber',     hex: '0xb45309', css: '#b45309' },
  { name: 'violet',    hex: '0x6d28d9', css: '#6d28d9' },
  { name: 'teal',      hex: '0x0e7490', css: '#0e7490' },
  { name: 'red',       hex: '0xb91c1c', css: '#b91c1c' },
  { name: 'slate',     hex: '0x374151', css: '#4b5563' },
  { name: 'rose',      hex: '0x9f1239', css: '#9f1239' },
  { name: 'sky',       hex: '0x0369a1', css: '#0369a1' },
  { name: 'lime',      hex: '0x4d7c0f', css: '#4d7c0f' },
];

function autoDomains(tables) {
  // Tables with explicit domain keep it
  const assigned = {};
  for (const t of tables) {
    if (t.domain) assigned[t.name] = t.domain;
  }

  // Build undirected adjacency from FKs (only among tables without domain)
  const nameSet = new Set(tables.map(t => t.name));
  const adj = {};
  for (const t of tables) {
    adj[t.name] = new Set();
  }
  for (const t of tables) {
    for (const fk of (t.fks || [])) {
      if (fk.refTable !== t.name && nameSet.has(fk.refTable)) {
        adj[t.name].add(fk.refTable);
        adj[fk.refTable].add(t.name);
      }
    }
  }

  // BFS connected components for unassigned tables
  const visited = new Set(Object.keys(assigned));
  const components = [];
  for (const t of tables) {
    if (visited.has(t.name)) continue;
    const comp = [];
    const queue = [t.name];
    visited.add(t.name);
    while (queue.length) {
      const cur = queue.shift();
      comp.push(cur);
      for (const nb of adj[cur]) {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
    components.push(comp);
  }

  // Sort components largest-first, assign palette colors
  components.sort((a, b) => b.length - a.length);

  // Collect already-used domain names
  const usedDomains = new Set(Object.values(assigned));
  let colorIdx = 0;
  for (const comp of components) {
    // Find next unused palette entry
    while (colorIdx < DOMAIN_PALETTE.length && usedDomains.has(DOMAIN_PALETTE[colorIdx].name)) {
      colorIdx++;
    }
    const domain = DOMAIN_PALETTE[colorIdx % DOMAIN_PALETTE.length].name;
    usedDomains.add(domain);
    colorIdx++;
    for (const name of comp) assigned[name] = domain;
  }

  return assigned;
}

// ── Generate T and LEVELS JavaScript blocks ───────────────────────────────────

function sd(def) {
  return def.includes("'") ? `"${def}"` : `'${def}'`;
}

function generateT(tables, domainMap) {
  const lines = ['const T = ['];
  for (const tbl of tables) {
    const fields = buildFields(tbl);
    const domain = domainMap[tbl.name] || 'slate';
    const maxN = Math.max(...fields.map(f => f.n.length));
    lines.push(`  { id:'${tbl.name}', domain:'${domain}', fields:[`);
    for (const f of fields) {
      const nPad = f.n.padEnd(maxN);
      const tStr = JSON.stringify(f.t);
      const p = [`n:'${nPad}'`, `t:${tStr}`];
      if (f.pk)   p.push('pk:1');
      if (f.fk)   p.push(`fk:'${f.fk}'`);
      if (f.null)  p.push('null:1');
      if (f.def)   p.push(`def:${sd(f.def)}`);
      lines.push(`    { ${p.join(', ')} },`);
    }
    lines.push('  ]},');
  }
  lines.push('];');
  return lines.join('\n');
}

function generateLEVELS(levels) {
  const inner = levels.map(l => '  ' + JSON.stringify(l) + ',').join('\n');
  return `const LEVELS = [\n${inner}\n];`;
}

// ── Compute LEVEL_Z and LEVEL_RAD dynamically ─────────────────────────────────

function generateLevelArrays(levels) {
  const n = levels.length;
  if (n === 0) return 'const LEVEL_Z = [];\nconst LEVEL_RAD = [];';

  // Spread levels evenly across Z axis
  const totalSpan = Math.max(80, n * 18);
  const halfSpan = totalSpan / 2;
  const zArr = [];
  const rArr = [];
  for (let i = 0; i < n; i++) {
    const z = n === 1 ? 0 : -halfSpan + (i / (n - 1)) * totalSpan;
    zArr.push(Math.round(z));
    // Radius proportional to count of tables at this level
    const count = levels[i].length;
    rArr.push(Math.max(8, Math.round(count * 2.8)));
  }

  return `const LEVEL_Z   = [${zArr.join(', ')}];\nconst LEVEL_RAD = [${rArr.join(', ')}];`;
}

// ── Build domain color map for HTML ───────────────────────────────────────────

function generateDomainColors(domainMap) {
  const usedDomains = [...new Set(Object.values(domainMap))];

  // Assign each unique domain name a palette color in order
  const colorFor = {};
  let idx = 0;
  for (const name of usedDomains) {
    const p = DOMAIN_PALETTE[idx % DOMAIN_PALETTE.length];
    colorFor[name] = p;
    idx++;
  }

  const lines = ['const D = {'];
  for (const name of usedDomains) {
    const p = colorFor[name];
    lines.push(`  ${name.padEnd(12)}: { hex: ${p.hex}, css: '${p.css}' },`);
  }
  lines.push('};');
  return lines.join('\n');
}

// ── HTML template (shell of erd3d.html without data blocks) ───────────────────

function generateHTML(title, domainColorsBlock, tBlock, levelsBlock, levelArraysBlock) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${title} — ERD 3D</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #020617; overflow: hidden; }
canvas { display: block; }
#title { position: fixed; top: 14px; left: 14px; color: #1e3a5f; font: bold 13px monospace; pointer-events: none; }
#info  { position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); color: #1e3a5f; font: 11px monospace; pointer-events: none; white-space: nowrap; }
#tip   { position: fixed; background: rgba(15,23,42,0.95); border: 1px solid #334155; color: #e2e8f0; padding: 4px 10px; border-radius: 4px; font: 11px monospace; pointer-events: none; display: none; z-index: 10; }
#history { position: fixed; top: 36px; left: 14px; background: rgba(2,6,23,0.88); border: 1px solid #1e293b; border-radius: 4px; font: 11px monospace; min-width: 170px; z-index: 10; display: none; }
#history-header { padding: 3px 8px; color: #334155; border-bottom: 1px solid #1e293b; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; pointer-events: none; }
.history-item { padding: 3px 8px; cursor: pointer; white-space: nowrap; transition: filter 0.12s; }
.history-item:hover { filter: brightness(1.8); }
#infopanel { position: fixed; top: 36px; left: 14px; background: rgba(2,6,23,0.88); border: 1px solid #1e293b; border-radius: 4px; font: 11px monospace; min-width: 170px; max-height: calc(100vh - 80px); overflow-y: auto; z-index: 9; display: none; }
#infopanel-header { padding: 5px 8px; border-bottom: 1px solid #1e293b; font: bold 12px monospace; white-space: nowrap; }
#infopanel-section { padding: 2px 0; }
.infopanel-label { padding: 3px 8px; color: #334155; font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; pointer-events: none; }
.infopanel-item { padding: 3px 8px; cursor: pointer; white-space: nowrap; transition: filter 0.12s; }
.infopanel-item:hover { filter: brightness(1.8); }
#zoom-ctrl { position: fixed; bottom: 48px; left: 14px; display: flex; flex-direction: column; align-items: center; gap: 4px; z-index: 10; }
#zoom-ctrl button { width: 22px; height: 22px; border: 1px solid #334155; border-radius: 4px; background: rgba(15,23,42,0.9); color: #94a3b8; font: bold 13px monospace; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; line-height: 1; }
#zoom-ctrl button:hover { border-color: #64748b; color: #e2e8f0; }
#zoom-slider { writing-mode: vertical-lr; direction: rtl; width: 22px; height: 80px; accent-color: #334155; cursor: pointer; }
#zoom-label { color: #334155; font: 9px monospace; pointer-events: none; }
</style>
</head>
<body>
<div id="title">${title} — ERD 3D</div>
<div id="info">drag to rotate · scroll to zoom · right-drag to pan · click to select · click again to fly in · click empty space to deselect</div>
<div id="tip"></div>
<div id="history"><div id="history-header">Recent</div><div id="history-list"></div></div>
<div id="infopanel"><div id="infopanel-header"></div><div id="infopanel-section"></div></div>
<div id="zoom-ctrl">
  <button id="zoom-plus">+</button>
  <input id="zoom-slider" type="range" min="5" max="200" value="35">
  <button id="zoom-minus">−</button>
  <div id="zoom-label">scroll</div>
</div>

<script type="importmap">
{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.158.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.158.0/examples/jsm/"}}
</script>

<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── DOMAIN COLORS ─────────────────────────────────────────────────────────
${domainColorsBlock}

// ── TABLE DATA ────────────────────────────────────────────────────────────
${tBlock}

const tblMap = {};
T.forEach(t => tblMap[t.id] = t);

// ── LEVEL LAYOUT ─────────────────────────────────────────────────────────
${levelsBlock}

${levelArraysBlock}

LEVELS.forEach((names, lvl) => {
  const n = names.length, r = LEVEL_RAD[lvl], z = LEVEL_Z[lvl];
  names.forEach((name, i) => {
    if (!tblMap[name]) return;
    const a = n === 1 ? Math.PI / 2 : (i / n) * Math.PI * 2 + (lvl * 0.4);
    tblMap[name]._pos = new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, z);
  });
});

// ── CARD TEXTURE ─────────────────────────────────────────────────────────
const _mCanvas = document.createElement('canvas');
const _mCtx = _mCanvas.getContext('2d');

function makeCardTexture(tbl) {
  const HDR = 38, ROW = 20, PAD_B = 4;
  const PAD_L = 6, BADGE_W = 22, GAP = 8, PAD_R = 8;

  let maxNameW = 0, maxTypeW = 0, maxDefW = 0;
  let hasNull = false, hasDef = false;
  tbl.fields.forEach(f => {
    _mCtx.font = f.pk ? 'bold 12px monospace' : '12px monospace';
    maxNameW = Math.max(maxNameW, _mCtx.measureText(f.n.trim()).width);
    _mCtx.font = '10px monospace';
    maxTypeW = Math.max(maxTypeW, _mCtx.measureText(f.t).width);
    if (f.null) hasNull = true;
    if (f.def) {
      hasDef = true;
      _mCtx.font = '8px monospace';
      maxDefW = Math.max(maxDefW, _mCtx.measureText(f.def).width);
    }
  });

  _mCtx.font = 'bold 8px monospace';
  const nullW = Math.ceil(_mCtx.measureText('null').width);
  maxNameW = Math.ceil(maxNameW);
  maxTypeW = Math.ceil(maxTypeW);
  maxDefW  = Math.ceil(maxDefW);

  const xBadge = PAD_L;
  const xName  = PAD_L + BADGE_W;
  const xType  = xName + maxNameW + GAP;
  let xNull = -1, xDef = -1, CW;

  if (hasNull && hasDef) {
    xNull = xType + maxTypeW + GAP;
    xDef  = xNull + nullW + GAP;
    CW    = xDef + maxDefW + PAD_R;
  } else if (hasNull) {
    xNull = xType + maxTypeW + GAP;
    CW    = xNull + nullW + PAD_R;
  } else if (hasDef) {
    xDef = xType + maxTypeW + GAP;
    CW   = xDef + maxDefW + PAD_R;
  } else {
    CW = xType + maxTypeW + PAD_R;
  }

  _mCtx.font = 'bold 16px monospace';
  const hdrNameW = _mCtx.measureText(tbl.id).width;
  _mCtx.font = '10px monospace';
  const hdrRightW = _mCtx.measureText(tbl.fields.length + ' cols').width;
  CW = Math.max(CW, Math.ceil(10 + hdrNameW + 8 + hdrRightW + 8));

  const CH = HDR + tbl.fields.length * ROW + PAD_B;
  const canvas = document.createElement('canvas');
  canvas.width = CW; canvas.height = CH;
  const ctx = canvas.getContext('2d');
  const dc = D[tbl.domain].css;

  ctx.fillStyle = '#0a1628';
  ctx.beginPath(); ctx.roundRect(0, 0, CW, CH, 8); ctx.fill();

  ctx.strokeStyle = dc; ctx.lineWidth = 2.5;
  ctx.shadowColor = dc; ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.roundRect(1, 1, CW-2, CH-2, 8); ctx.stroke();
  ctx.shadowBlur = 0;

  const grad = ctx.createLinearGradient(0, 0, CW, 0);
  grad.addColorStop(0, dc);
  grad.addColorStop(1, dc + '88');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.roundRect(0, 0, CW, HDR, [8, 8, 0, 0]); ctx.fill();

  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 4;
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 16px monospace';
  ctx.fillText(tbl.id, 10, 25);
  ctx.shadowBlur = 0;

  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '10px monospace';
  ctx.textAlign = 'right'; ctx.fillText(tbl.fields.length + ' cols', CW-8, 25);
  ctx.textAlign = 'left';

  ctx.strokeStyle = dc + '44'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, HDR); ctx.lineTo(CW, HDR); ctx.stroke();

  tbl.fields.forEach((f, i) => {
    const y = HDR + i * ROW;
    if (i % 2 === 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, y, CW, ROW);
    }

    if (f.pk) {
      ctx.fillStyle = '#fbbf24'; ctx.font = 'bold 8px monospace';
      ctx.fillText('PK', xBadge, y + 13);
    } else if (f.fk) {
      ctx.fillStyle = '#34d399'; ctx.font = 'bold 8px monospace';
      ctx.fillText('FK', xBadge, y + 13);
    }

    ctx.fillStyle = f.pk ? '#fbbf24' : f.fk ? '#86efac' : '#94a3b8';
    ctx.font = (f.pk ? 'bold ' : '') + '12px monospace';
    ctx.fillText(f.n.trim(), xName, y + 14);

    ctx.fillStyle = '#e2e8f0'; ctx.font = '10px monospace';
    ctx.fillText(f.t, xType, y + 14);

    if (f.null && xNull >= 0) {
      ctx.fillStyle = '#f59e0b'; ctx.font = 'bold 8px monospace';
      ctx.fillText('null', xNull, y + 14);
    }

    const def = f.def;
    if (def && xDef >= 0) {
      ctx.fillStyle = '#7dd3fc'; ctx.font = '8px monospace';
      ctx.fillText(def, xDef, y + 14);
    }
  });

  return new THREE.CanvasTexture(canvas);
}

// ── THREE.JS SETUP ────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020617);
scene.fog = new THREE.FogExp2(0x020617, 0.0035);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 800);
camera.position.set(0, 18, 95);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.zoomSpeed = 0.35;
controls.minDistance = 3;
controls.maxDistance = 250;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.25;
controls.addEventListener('start', () => { controls.autoRotate = false; });

// ── ZOOM SENSITIVITY SLIDER ──────────────────────────────────────────────
const zoomSlider = document.getElementById('zoom-slider');
const zoomPlus   = document.getElementById('zoom-plus');
const zoomMinus  = document.getElementById('zoom-minus');
function applyZoom(val) { controls.zoomSpeed = val / 100; zoomSlider.value = val; }
zoomSlider.addEventListener('input', () => applyZoom(Number(zoomSlider.value)));
zoomPlus.addEventListener('click',  () => applyZoom(Math.min(200, Number(zoomSlider.value) + 15)));
zoomMinus.addEventListener('click', () => applyZoom(Math.max(5,   Number(zoomSlider.value) - 15)));

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ── STARS ─────────────────────────────────────────────────────────────────
{
  const n = 5000, pos = new Float32Array(n * 3), sizes = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = 150 + Math.random() * 200;
    const th = Math.acos(2 * Math.random() - 1);
    const ph = Math.random() * Math.PI * 2;
    pos[i*3]   = r * Math.sin(th) * Math.cos(ph);
    pos[i*3+1] = r * Math.sin(th) * Math.sin(ph);
    pos[i*3+2] = r * Math.cos(th);
    sizes[i] = Math.random() * 1.2 + 0.2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffffff, size: 0.35, transparent: true, opacity: 0.55, sizeAttenuation: true
  })));
}

// ── TABLE CARDS ───────────────────────────────────────────────────────────
const cardMeshes = [];
const cardMap = {};

const SCALE_PX = 100;
T.forEach(tbl => {
  if (!tbl._pos) return;
  const tex = makeCardTexture(tbl);
  const W = tex.image.width / SCALE_PX;
  const H = tex.image.height / SCALE_PX;
  tbl._cardH = H;
  const geo = new THREE.PlaneGeometry(W, H);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(tbl._pos);
  mesh.userData.id = tbl.id;
  mesh.userData.domain = tbl.domain;
  mesh.userData.origOpacity = 1;
  mesh.userData.W = W;
  scene.add(mesh);
  cardMeshes.push(mesh);
  cardMap[tbl.id] = mesh;
});

// ── FK LINES ──────────────────────────────────────────────────────────────
const allLines = [];
const dynamicLineData = [];
const linesByTable = {};
const CURVE_PTS = 48;

T.forEach(tbl => { linesByTable[tbl.id] = []; });

function rowLocalY(tblId, fieldIdx) {
  const tbl = tblMap[tblId];
  if (!tbl) return 0;
  const HDR = 38, ROW = 20, PAD_B = 4;
  const CH = HDR + tbl.fields.length * ROW + PAD_B;
  const H = tbl._cardH;
  const yCanvas = HDR + fieldIdx * ROW + ROW / 2;
  return H / 2 - (yCanvas / CH) * H;
}

function addLine(hex, opacity, tblA, fieldIdxA, fieldName, tblB) {
  const arr = new Float32Array((CURVE_PTS + 1) * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  geo.attributes.position.usage = THREE.DynamicDrawUsage;

  const mat = new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity, linewidth: 1 });
  const line = new THREE.Line(geo, mat);
  line.userData.tblA = tblA;
  line.userData.tblB = tblB;
  line.userData.fieldName = fieldName;
  line.frustumCulled = false;
  scene.add(line);
  allLines.push(line);
  linesByTable[tblA]?.push(line);
  linesByTable[tblB]?.push(line);

  dynamicLineData.push({ tblA, fieldIdxA, tblB, geo });
  return line;
}

T.forEach(tbl => {
  if (!tbl._pos) return;
  tbl.fields.forEach((f, fi) => {
    if (!f.fk || !tblMap[f.fk]?._pos) return;
    addLine(D[tbl.domain].hex, 0.35, tbl.id, fi, f.n.trim(), f.fk);
  });
});

const _camRight = new THREE.Vector3();
const _camUp    = new THREE.Vector3();
const _ep0 = new THREE.Vector3(), _ep2 = new THREE.Vector3();
const _mid = new THREE.Vector3(), _ctrl = new THREE.Vector3(), _outDir = new THREE.Vector3();

function updateDynamicLines() {
  _camRight.setFromMatrixColumn(camera.matrixWorld, 0);
  _camUp.setFromMatrixColumn(camera.matrixWorld, 1);

  dynamicLineData.forEach(d => {
    const meshA = cardMap[d.tblA], meshB = cardMap[d.tblB];
    if (!meshA || !meshB) return;

    const posA = meshA.position, posB = meshB.position;
    const sideA = posB.clone().sub(posA).dot(_camRight) >= 0 ? 1 : -1;
    const sideB = posA.clone().sub(posB).dot(_camRight) >= 0 ? 1 : -1;

    _ep0.copy(posA)
      .addScaledVector(_camRight, sideA * (meshA.userData.W / 2))
      .addScaledVector(_camUp, rowLocalY(d.tblA, d.fieldIdxA));
    _ep2.copy(posB)
      .addScaledVector(_camRight, sideB * (meshB.userData.W / 2))
      .addScaledVector(_camUp, rowLocalY(d.tblB, 0));

    _mid.addVectors(_ep0, _ep2).multiplyScalar(0.5);
    if (_mid.length() > 0.5) _outDir.copy(_mid).normalize();
    else _outDir.set(0, 1, 0);
    const zDiff = Math.abs(posA.z - posB.z);
    const arc = Math.max(2, zDiff * 0.15) + 1.5;
    _ctrl.copy(_mid).addScaledVector(_outDir, arc);

    const curve = new THREE.QuadraticBezierCurve3(_ep0, _ctrl, _ep2);
    const pts = curve.getPoints(CURVE_PTS);
    const pos = d.geo.attributes.position;
    pts.forEach((p, i) => pos.setXYZ(i, p.x, p.y, p.z));
    pos.needsUpdate = true;
  });
}

// ── VISIT HISTORY ──────────────────────────────────────────────────────────
let visitHistory = [];
function recordVisit(id) {
  if (visitHistory[0] === id) return;
  visitHistory = [id, ...visitHistory.filter(x => x !== id)].slice(0, 10);
  const panel = document.getElementById('history');
  const list = document.getElementById('history-list');
  panel.style.display = 'block';
  list.innerHTML = '';
  for (const hid of visitHistory) {
    const tbl = tblMap[hid];
    const color = tbl ? (D[tbl.domain]?.css ?? '#64748b') : '#64748b';
    const div = document.createElement('div');
    div.className = 'history-item';
    div.style.color = color;
    div.textContent = hid;
    div.addEventListener('click', () => selectTable(hid));
    list.appendChild(div);
  }
}

// ── INFO PANEL ────────────────────────────────────────────────────────────
function updateInfoPanel(id) {
  const panel   = document.getElementById('infopanel');
  const header  = document.getElementById('infopanel-header');
  const section = document.getElementById('infopanel-section');
  if (!id) { panel.style.display = 'none'; return; }

  const tbl = tblMap[id];
  if (!tbl) { panel.style.display = 'none'; return; }
  const dc = D[tbl.domain]?.css ?? '#64748b';

  header.innerHTML = 'Table: ' + id;
  header.style.color = '#e2e8f0';

  const references = [];
  const referencedBy = [];
  tbl.fields.forEach(f => {
    if (f.fk && tblMap[f.fk]) references.push(f.fk);
  });
  T.forEach(other => {
    if (other.id === id) return;
    other.fields.forEach(f => {
      if (f.fk === id) referencedBy.push(other.id);
    });
  });
  const refsUniq = [...new Set(references)];
  const refByUniq = [...new Set(referencedBy)];

  section.innerHTML = '';

  if (refsUniq.length) {
    const lbl = document.createElement('div');
    lbl.className = 'infopanel-label';
    lbl.textContent = 'References';
    section.appendChild(lbl);
    for (const rid of refsUniq) {
      const rt = tblMap[rid];
      const div = document.createElement('div');
      div.className = 'infopanel-item';
      div.style.color = rt ? (D[rt.domain]?.css ?? '#64748b') : '#64748b';
      div.textContent = rid;
      div.addEventListener('click', () => selectTable(rid));
      section.appendChild(div);
    }
  }

  if (refByUniq.length) {
    const lbl = document.createElement('div');
    lbl.className = 'infopanel-label';
    lbl.textContent = 'Referenced by';
    section.appendChild(lbl);
    for (const rid of refByUniq) {
      const rt = tblMap[rid];
      const div = document.createElement('div');
      div.className = 'infopanel-item';
      div.style.color = rt ? (D[rt.domain]?.css ?? '#64748b') : '#64748b';
      div.textContent = rid;
      div.addEventListener('click', () => selectTable(rid));
      section.appendChild(div);
    }
  }

  const histPanel = document.getElementById('history');
  const histRect = histPanel.getBoundingClientRect();
  if (histPanel.style.display !== 'none' && histRect.height > 0) {
    panel.style.top = (histRect.bottom + 4) + 'px';
  } else {
    panel.style.top = '36px';
  }
  panel.style.display = 'block';
}

function selectTable(id) {
  setHighlight(id);
  recordVisit(id);
  updateInfoPanel(id);
}

function updateInfoPanelLink(line) {
  const panel   = document.getElementById('infopanel');
  const header  = document.getElementById('infopanel-header');
  const section = document.getElementById('infopanel-section');

  const { tblA, tblB, fieldName } = line.userData;

  header.textContent = 'Relationship';
  header.style.color = '#e2e8f0';

  section.innerHTML = '';

  for (const tid of [tblA, tblB]) {
    const t = tblMap[tid];
    const div = document.createElement('div');
    div.className = 'infopanel-item';
    div.style.color = t ? (D[t.domain]?.css ?? '#64748b') : '#64748b';
    div.textContent = tid;
    div.addEventListener('click', () => selectTable(tid));
    section.appendChild(div);
  }

  const histPanel = document.getElementById('history');
  const histRect = histPanel.getBoundingClientRect();
  if (histPanel.style.display !== 'none' && histRect.height > 0) {
    panel.style.top = (histRect.bottom + 4) + 'px';
  } else {
    panel.style.top = '36px';
  }
  panel.style.display = 'block';
}

// ── CAMERA FLY-TO ──────────────────────────────────────────────────────────
let fly = null;
function easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

function flyTo(tableId, record = true) {
  const mesh = cardMap[tableId];
  if (!mesh) return;
  if (record) recordVisit(tableId);
  const toTarget = mesh.position.clone();
  const outDir = toTarget.clone().normalize();
  if (outDir.length() < 0.01) outDir.set(0, 0, 1);
  const toPos = toTarget.clone().addScaledVector(outDir, 6).add(new THREE.Vector3(0, 1, 0));
  fly = {
    fromPos: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toPos, toTarget, t: 0
  };
  controls.autoRotate = false;
}

// ── CLICK HIGHLIGHT ────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let selectedId = null;
let selectedLine = null;

function clearSelection() {
  selectedId = null;
  selectedLine = null;
  allLines.forEach(line => {
    line.material.opacity = 0.35;
    line.material.color.setHex(line.userData.origColor ?? 0xffffff);
  });
  cardMeshes.forEach(mesh => { mesh.material.opacity = 1; });
  updateInfoPanel(null);
}

function setHighlight(id) {
  selectedId = id;
  selectedLine = null;
  const connectedIds = new Set();
  if (id) {
    connectedIds.add(id);
    linesByTable[id]?.forEach(line => {
      if (line.userData.tblA) connectedIds.add(line.userData.tblA);
      if (line.userData.tblB) connectedIds.add(line.userData.tblB);
    });
  }
  const activeLines = id ? new Set(linesByTable[id]) : null;
  allLines.forEach(line => {
    const active = !id || activeLines?.has(line);
    line.material.opacity = active ? (id ? 0.85 : 0.35) : 0.04;
    line.material.color.setHex(active && id ? 0xffffff : line.userData.origColor ?? 0xffffff);
  });
  cardMeshes.forEach(mesh => {
    const active = !id || connectedIds.has(mesh.userData.id);
    mesh.material.opacity = active ? 1 : 0.12;
  });
}

function setHighlightLink(line) {
  selectedId = null;
  selectedLine = line;
  const pairIds = new Set([line.userData.tblA, line.userData.tblB]);
  allLines.forEach(l => {
    const active = l === line;
    l.material.opacity = active ? 1 : 0.04;
    l.material.color.setHex(active ? 0xffffff : l.userData.origColor ?? 0xffffff);
  });
  cardMeshes.forEach(mesh => {
    mesh.material.opacity = pairIds.has(mesh.userData.id) ? 1 : 0.12;
  });
}

function selectLink(line) {
  setHighlightLink(line);
  updateInfoPanelLink(line);
}

allLines.forEach(line => {
  line.userData.origColor = line.material.color.getHex();
});

raycaster.params.Line = { threshold: 0.25 };

renderer.domElement.addEventListener('click', e => {
  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  const cardHits = raycaster.intersectObjects(cardMeshes);
  if (cardHits.length) {
    const hit = cardHits[0];
    const id = hit.object.userData.id;
    const tbl = tblMap[id];

    // Clicking an FK row selects the referenced table
    if (hit.uv && tbl) {
      const HDR = 38, ROW = 20, PAD = 4;
      const CH = HDR + tbl.fields.length * ROW + PAD;
      const canvasY = (1 - hit.uv.y) * CH;
      const fi = Math.floor((canvasY - HDR) / ROW);
      if (fi >= 0 && fi < tbl.fields.length) {
        const field = tbl.fields[fi];
        if (field.fk && tblMap[field.fk]?._pos) {
          selectTable(field.fk);
          return;
        }
      }
    }

    // Already selected → fly in close
    if (id === selectedId) { flyTo(id); return; }
    // First click → select only
    selectTable(id);
    return;
  }

  const lineHits = raycaster.intersectObjects(allLines);
  if (lineHits.length) {
    selectLink(lineHits[0].object);
    return;
  }

  clearSelection();
});

// ── RIGHT-CLICK HIGHLIGHT (no fly-to) ──────────────────────────────────────
let _rightDownX = 0, _rightDownY = 0;
renderer.domElement.addEventListener('mousedown', e => {
  if (e.button === 2) { _rightDownX = e.clientX; _rightDownY = e.clientY; }
});
renderer.domElement.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (Math.abs(e.clientX - _rightDownX) > 4 || Math.abs(e.clientY - _rightDownY) > 4) return;

  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  const cardHits = raycaster.intersectObjects(cardMeshes);
  if (cardHits.length) {
    const id = cardHits[0].object.userData.id;
    if (id === selectedId) clearSelection();
    else selectTable(id);
    return;
  }

  const lineHits = raycaster.intersectObjects(allLines);
  if (lineHits.length) {
    selectLink(lineHits[0].object);
    return;
  }

  clearSelection();
});

// ── TOOLTIP ────────────────────────────────────────────────────────────────
const tip = document.getElementById('tip');
renderer.domElement.addEventListener('mousemove', e => {
  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const cardHits = raycaster.intersectObjects(cardMeshes);
  if (cardHits.length) {
    tip.textContent = cardHits[0].object.userData.id;
    tip.style.display = 'block';
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top  = (e.clientY - 6) + 'px';
    renderer.domElement.style.cursor = 'pointer';
    return;
  }
  const lineHits = raycaster.intersectObjects(allLines);
  if (lineHits.length) {
    const { tblA, tblB } = lineHits[0].object.userData;
    tip.textContent = \`\${tblA} → \${tblB}\`;
    tip.style.display = 'block';
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top  = (e.clientY - 6) + 'px';
    renderer.domElement.style.cursor = 'pointer';
    return;
  }
  tip.style.display = 'none';
  renderer.domElement.style.cursor = '';
});

// ── RENDER LOOP ────────────────────────────────────────────────────────────
const _lookTarget = new THREE.Vector3();
function animate() {
  requestAnimationFrame(animate);
  if (fly) {
    fly.t = Math.min(fly.t + 0.016, 1);
    const e = easeInOut(fly.t);
    camera.position.lerpVectors(fly.fromPos, fly.toPos, e);
    _lookTarget.lerpVectors(fly.fromTarget, fly.toTarget, e);
    camera.lookAt(_lookTarget);
    if (fly.t >= 1) {
      controls.target.copy(fly.toTarget);
      controls.update();
      fly = null;
    }
  } else {
    controls.update();
  }
  camera.updateMatrixWorld();
  cardMeshes.forEach(m => m.lookAt(camera.position));
  updateDynamicLines();
  renderer.render(scene, camera);
}
animate();
</script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (isMain) {
  const outputBase = process.argv[3] ? path.resolve(process.argv[3]) : process.cwd();

  // Derive project title from tables.json directory name
  const jsonDir = path.dirname(path.resolve(jsonPath));
  const title = path.basename(jsonDir).replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const domainMap = autoDomains(tables);
  const levels = computeLevels(tables);

  const domainColorsBlock = generateDomainColors(domainMap);
  const tBlock = generateT(tables, domainMap);
  const levelsBlock = generateLEVELS(levels);
  const levelArraysBlock = generateLevelArrays(levels);

  const html = generateHTML(title, domainColorsBlock, tBlock, levelsBlock, levelArraysBlock);
  const outPath = path.join(outputBase, 'erd3d.html');
  fs.writeFileSync(outPath, html, 'utf8');

  console.log(`Generated ${outPath}`);
  console.log(`  ${tables.length} tables across ${levels.length} levels`);
  const domainCounts = {};
  for (const d of Object.values(domainMap)) domainCounts[d] = (domainCounts[d] || 0) + 1;
  for (const [d, c] of Object.entries(domainCounts)) console.log(`  ${d}: ${c} tables`);
}

module.exports = { buildFields, computeLevels, autoDomains, generateHTML };
