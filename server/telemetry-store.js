import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

function dateStampCST(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function timeStampCST(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export function normalizeClientIp(raw) {
  if (typeof raw !== 'string') return '';
  let first = raw.split(',')[0].trim();
  if (first.startsWith('::ffff:')) first = first.slice(7);
  if (first.startsWith('[') && first.includes(']')) first = first.slice(1, first.indexOf(']'));
  return first.slice(0, 64);
}

export function percentiles(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: Math.round(sorted[0]),
    p25: Math.round(at(0.25)),
    p50: Math.round(at(0.5)),
    p75: Math.round(at(0.75)),
    p90: Math.round(at(0.9)),
    p95: Math.round(at(0.95)),
    max: Math.round(sorted[sorted.length - 1]),
    avg: Math.round(sum / sorted.length),
  };
}

function loadOrCreateSalt(dir, explicitSalt) {
  if (typeof explicitSalt === 'string' && explicitSalt.length >= 8) return explicitSalt;
  const saltPath = path.join(dir, '.telemetry-salt');
  try {
    const existing = fs.readFileSync(saltPath, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {}
  const fresh = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(saltPath, fresh + '\n', { mode: 0o600 });
  } catch {}
  return fresh;
}

/**
 * Low-overhead, space-capped NDJSON telemetry & anti-cheat log writer.
 * - Buffers lines in RAM and flushes asynchronously every 5s or 16 KB (zero tick blocking).
 * - Rotates daily (CST) or at maxFileBytes (default 8 MB) and compresses rotated files to .ndjson.gz.
 * - Automatically prunes archives older than maxDays (default 14) or above maxTotalBytes (default 200 MB).
 */
export function createTelemetryStore({
  dir = process.env.PERF_TELEMETRY_DIR || '',
  maxFileBytes = Math.max(256 * 1024, Number(process.env.PERF_TELEMETRY_MAX_FILE_BYTES) || 8 * 1024 * 1024),
  maxDays = Math.max(1, Number(process.env.PERF_TELEMETRY_MAX_DAYS) || 14),
  maxTotalBytes = Math.max(5 * 1024 * 1024, (Number(process.env.PERF_TELEMETRY_MAX_MB) || 200) * 1024 * 1024),
  flushIntervalMs = 5000,
  salt = process.env.PERF_TELEMETRY_SALT || '',
} = {}) {
  const enabled = Boolean(dir && typeof dir === 'string');
  const resolvedDir = enabled ? path.resolve(dir) : '';
  if (enabled) fs.mkdirSync(resolvedDir, { recursive: true });
  const hmacKey = enabled ? loadOrCreateSalt(resolvedDir, salt) : (salt || crypto.randomBytes(16).toString('hex'));

  let buffer = [];
  let bufferBytes = 0;
  let activeDate = dateStampCST();
  let activeBytes = 0;
  let flushing = null;
  let rotating = false;
  let closed = false;

  const recentAnomalies = [];
  const acCounts = Object.create(null);
  const counters = { sessions: 0, udpSessions: 0, wsSessions: 0, anomalies: 0, netSnapshots: 0, writtenBytes: 0, dropped: 0 };

  if (enabled) {
    try {
      const existing = path.join(resolvedDir, `events-${activeDate}.ndjson`);
      if (fs.existsSync(existing)) activeBytes = fs.statSync(existing).size;
    } catch {}
  }

  function hashIp(rawIp) {
    const clean = normalizeClientIp(rawIp);
    if (!clean) return '';
    return crypto.createHmac('sha256', hmacKey).update(clean).digest('hex').slice(0, 12);
  }

  function activeFilePath(dateStr = activeDate) {
    return path.join(resolvedDir, `events-${dateStr}.ndjson`);
  }

  async function compressAndPrune(rotatedPath) {
    try {
      const gzPath = rotatedPath + '.gz';
      await pipeline(
        fs.createReadStream(rotatedPath),
        zlib.createGzip({ level: 6 }),
        fs.createWriteStream(gzPath)
      );
      await fsp.unlink(rotatedPath).catch(() => {});
    } catch {}
    await pruneOldArchives();
  }

  async function pruneOldArchives() {
    if (!enabled) return;
    try {
      const entries = await fsp.readdir(resolvedDir);
      const now = Date.now();
      const maxAgeMs = maxDays * 24 * 3600 * 1000;
      const archives = [];
      for (const name of entries) {
        if (!/^events-\d{4}-\d{2}-\d{2}(?:-\d{6})?\.ndjson(?:\.gz)?$/.test(name)) continue;
        const full = path.join(resolvedDir, name);
        if (name === `events-${activeDate}.ndjson`) continue;
        const st = await fsp.stat(full).catch(() => null);
        if (!st || !st.isFile()) continue;
        // Compress any leftover old raw .ndjson from a previous day or crash.
        if (name.endsWith('.ndjson') && !name.includes(activeDate)) {
          void compressAndPrune(full);
          continue;
        }
        if (now - st.mtimeMs > maxAgeMs) {
          await fsp.unlink(full).catch(() => {});
          continue;
        }
        archives.push({ full, mtimeMs: st.mtimeMs, size: st.size });
      }
      archives.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let total = archives.reduce((s, f) => s + f.size, 0) + activeBytes;
      while (archives.length && total > maxTotalBytes) {
        const oldest = archives.shift();
        await fsp.unlink(oldest.full).catch(() => {});
        total -= oldest.size;
      }
    } catch {}
  }

  async function maybeRotate(nowMs) {
    if (!enabled || rotating) return;
    const today = dateStampCST(nowMs);
    const needDateRotate = today !== activeDate;
    const needSizeRotate = activeBytes >= maxFileBytes;
    if (!needDateRotate && !needSizeRotate) return;
    rotating = true;
    try {
      const prevPath = activeFilePath(activeDate);
      if (fs.existsSync(prevPath) && activeBytes > 0) {
        const rotatedName = `events-${activeDate}-${timeStampCST(nowMs)}.ndjson`;
        const rotatedPath = path.join(resolvedDir, rotatedName);
        await fsp.rename(prevPath, rotatedPath);
        activeBytes = 0;
        activeDate = today;
        void compressAndPrune(rotatedPath);
      } else {
        activeDate = today;
        activeBytes = 0;
      }
    } catch {
      activeDate = today;
    } finally {
      rotating = false;
    }
  }

  function record(event) {
    if (!event || typeof event !== 'object') return;
    const tsSec = typeof event.t === 'number' ? Math.floor(event.t) : Math.floor(Date.now() / 1000);
    const clean = { t: tsSec, ...event };
    if (clean.k === 'sess') {
      counters.sessions++;
      if (clean.tr === 'udp') counters.udpSessions++;
      else counters.wsSessions++;
    } else if (clean.k === 'ac') {
      counters.anomalies++;
      const rule = String(clean.rule || 'UNKNOWN');
      acCounts[rule] = (acCounts[rule] || 0) + 1;
      recentAnomalies.push(clean);
      if (recentAnomalies.length > 50) recentAnomalies.shift();
    } else if (clean.k === 'net') {
      counters.netSnapshots++;
    }
    if (!enabled || closed) return;
    if (bufferBytes > 2 * 1024 * 1024) {
      counters.dropped++;
      return;
    }
    const line = JSON.stringify(clean) + '\n';
    buffer.push(line);
    bufferBytes += Buffer.byteLength(line);
    if (bufferBytes >= 16384) void flush();
  }

  async function flush() {
    if (!enabled || !buffer.length) return;
    if (flushing) {
      await flushing;
      if (!buffer.length) return;
    }
    const batch = buffer.join('');
    const bytes = bufferBytes;
    buffer = [];
    bufferBytes = 0;
    flushing = (async () => {
      try {
        await maybeRotate(Date.now());
        await fsp.appendFile(activeFilePath(), batch);
        activeBytes += bytes;
        counters.writtenBytes += bytes;
        if (activeBytes >= maxFileBytes) await maybeRotate(Date.now());
      } catch {
        counters.dropped++;
      } finally {
        flushing = null;
      }
    })();
    await flushing;
  }

  const flushTimer = enabled ? setInterval(() => { void flush(); }, flushIntervalMs) : null;
  flushTimer?.unref?.();
  if (enabled) void pruneOldArchives();

  async function diskUsage() {
    if (!enabled) return { enabled: false, files: 0, totalBytes: 0, maxMB: Math.round(maxTotalBytes / 1048576), maxDays };
    try {
      const entries = await fsp.readdir(resolvedDir);
      let files = 0, totalBytes = 0, gzFiles = 0;
      for (const name of entries) {
        if (!name.startsWith('events-')) continue;
        const st = await fsp.stat(path.join(resolvedDir, name)).catch(() => null);
        if (!st?.isFile()) continue;
        files++;
        totalBytes += st.size;
        if (name.endsWith('.gz')) gzFiles++;
      }
      return {
        enabled: true,
        dir: resolvedDir,
        files,
        gzFiles,
        totalBytes,
        totalMB: Number((totalBytes / 1048576).toFixed(2)),
        maxMB: Math.round(maxTotalBytes / 1048576),
        maxDays,
      };
    } catch {
      return { enabled: true, files: 0, totalBytes: 0, maxMB: Math.round(maxTotalBytes / 1048576), maxDays };
    }
  }

  return {
    enabled,
    dir: resolvedDir,
    hashIp,
    record,
    flush,
    async summary() {
      return {
        counters: { ...counters },
        acCounts: { ...acCounts },
        recentAnomalies: [...recentAnomalies],
        storage: await diskUsage(),
      };
    },
    async close() {
      if (closed) return;
      if (flushTimer) clearInterval(flushTimer);
      await flush();
      closed = true;
    },
  };
}
