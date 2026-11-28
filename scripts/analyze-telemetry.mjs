#!/usr/bin/env node
/**
 * Compact NDJSON / .ndjson.gz telemetry & anti-cheat log analyzer.
 *
 * Usage:
 *   node scripts/analyze-telemetry.mjs [--dir=/opt/cs2-web/logs/telemetry] [--days=1] [--top=15]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { percentiles } from '../server/telemetry-store.js';

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const dir = path.resolve(getArg('dir', process.env.PERF_TELEMETRY_DIR || '/opt/cs2-web/logs/telemetry'));
const days = Math.max(1, Number(getArg('days', '1')) || 1);
const topN = Math.max(5, Number(getArg('top', '15')) || 15);

if (!fs.existsSync(dir)) {
  console.log(`Telemetry directory not found: ${dir}`);
  process.exit(0);
}

const cutoffSec = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000);
const entries = fs.readdirSync(dir).filter((f) => /^events-.*\.ndjson(?:\.gz)?$/.test(f)).sort();

let totalDiskBytes = 0;
let gzCount = 0;
const sessions = [];
const anomalies = [];
const netSnaps = [];

for (const name of entries) {
  const full = path.join(dir, name);
  const st = fs.statSync(full);
  totalDiskBytes += st.size;
  if (name.endsWith('.gz')) gzCount++;
  if (st.mtimeMs < cutoffSec * 1000 - 24 * 3600 * 1000) continue;
  const rawBuf = fs.readFileSync(full);
  const text = name.endsWith('.gz') ? zlib.gunzipSync(rawBuf).toString('utf8') : rawBuf.toString('utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if ((ev.t || 0) < cutoffSec) continue;
    if (ev.k === 'sess') sessions.push(ev);
    else if (ev.k === 'ac') anomalies.push(ev);
    else if (ev.k === 'net') netSnaps.push(ev);
  }
}

const allRtts = [], udpRtts = [], wsRtts = [], jitters = [], fpsList = [];
const byMap = new Map();
const byPlayer = new Map();

for (const s of sessions) {
  const rtt = s.net?.p50 ?? s.net?.srvP50 ?? null;
  if (Number.isFinite(rtt)) {
    allRtts.push(rtt);
    if (s.tr === 'udp') udpRtts.push(rtt);
    else wsRtts.push(rtt);
  }
  if (Number.isFinite(s.net?.jit)) jitters.push(s.net.jit);
  if (Number.isFinite(s.net?.fps)) fpsList.push(s.net.fps);
  const m = byMap.get(s.m) || { sess: 0, udp: 0, ws: 0, rtts: [] };
  m.sess++;
  if (s.tr === 'udp') m.udp++; else m.ws++;
  if (Number.isFinite(rtt)) m.rtts.push(rtt);
  byMap.set(s.m, m);

  const key = s.uid && s.uid !== 'anon' ? s.uid : `ip:${s.iph || 'unknown'}`;
  const p = byPlayer.get(key) || {
    uid: s.uid || 'anon', iph: s.iph || '', name: s.nm || 'Player',
    sessions: 0, dur: 0, k: 0, d: 0, hs: 0, sh: 0, hit: 0, dmg: 0,
    wb: 0, smk: 0, rej: 0, snapHs: 0, snapMax: 0, hzMax: 0, ac: 0,
  };
  p.sessions++;
  p.name = s.nm || p.name;
  p.dur += s.dur || 0;
  p.k += s.cmb?.k || 0;
  p.d += s.cmb?.d || 0;
  p.hs += s.cmb?.hs || 0;
  p.sh += s.cmb?.sh || 0;
  p.hit += s.cmb?.hit || 0;
  p.dmg += s.cmb?.dmg || 0;
  p.wb += s.cmb?.wb || 0;
  p.smk += s.cmb?.smk || 0;
  p.rej += s.cmb?.rej || 0;
  p.snapHs += s.cmb?.snapHs || 0;
  p.snapMax = Math.max(p.snapMax, s.cmb?.snapMax || 0);
  p.hzMax = Math.max(p.hzMax, s.mov?.hzMax || 0);
  p.ac += s.ac || 0;
  byPlayer.set(key, p);
}

const acByRule = {};
for (const a of anomalies) acByRule[a.rule] = (acByRule[a.rule] || 0) + 1;

console.log(`=== CS2 Telemetry Summary (last ${days}d) ===`);
console.log(`Storage: ${entries.length} files (${gzCount} gz), ${(totalDiskBytes / 1048576).toFixed(2)} MiB total`);
console.log(`Events: ${sessions.length} sessions, ${anomalies.length} anti-cheat alerts, ${netSnaps.length} 1-min net rollups`);
console.log('\n--- Real Player Latency (Session p50 RTT ms) ---');
console.log('ALL:', percentiles(allRtts) || 'no samples');
console.log('UDP:', percentiles(udpRtts) || 'no samples');
console.log('WS :', percentiles(wsRtts) || 'no samples');
console.log('Jitter p50/p95:', percentiles(jitters) || 'no samples');
console.log('Client FPS p50:', percentiles(fpsList)?.p50 ?? 'n/a');

if (byMap.size) {
  console.log('\n--- Per-Map Breakdown ---');
  for (const [mapId, m] of [...byMap.entries()].sort((a, b) => b[1].sess - a[1].sess)) {
    const p = percentiles(m.rtts);
    const udpPct = m.sess ? Math.round((m.udp / m.sess) * 100) : 0;
    console.log(`${mapId.padEnd(11)} sess=${String(m.sess).padStart(4)} udp=${udpPct}% rtt=${p ? `p50=${p.p50}ms p95=${p.p95}ms` : 'n/a'}`);
  }
}

console.log('\n--- Anti-Cheat Alerts by Rule ---');
console.log(Object.keys(acByRule).length ? acByRule : 'none');

const suspects = [...byPlayer.values()]
  .filter((p) => p.ac > 0 || (p.k >= 6 && p.hs / Math.max(1, p.k) >= 0.7) || p.rej >= 10 || p.hzMax >= 80)
  .sort((a, b) => (b.ac - a.ac) || (b.snapHs - a.snapHs) || ((b.hs / Math.max(1, b.k)) - (a.hs / Math.max(1, a.k))))
  .slice(0, topN);

if (suspects.length) {
  console.log(`\n--- Top ${suspects.length} Flagged / High-Outlier Accounts (Server-Side Only) ---`);
  for (const p of suspects) {
    const hsPct = p.k ? Math.round((p.hs / p.k) * 100) : 0;
    const accPct = p.sh ? Math.round((p.hit / p.sh) * 100) : 0;
    console.log(
      `ac=${p.ac} uid=${p.uid} iph=${p.iph} name="${p.name}" K/D=${p.k}/${p.d} HS=${hsPct}% acc=${accPct}% snapHs=${p.snapHs}(max=${p.snapMax}°) rej=${p.rej} hzMax=${p.hzMax} wb=${p.wb} smk=${p.smk}`
    );
  }
}
