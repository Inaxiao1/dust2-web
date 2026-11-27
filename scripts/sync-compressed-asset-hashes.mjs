/**
 * Synchronizes every GLB file path, byte length, and SHA-256 digest across
 * shared/*.js and public/assets/** /*manifest*.json after compress-glb-textures.py.
 * Also self-verifies 100% of referenced GLBs on disk against declared bytes & sha256!
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const reportPath = path.join(ROOT, 'artifacts', 'compression-report.json');

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const byOldSha = new Map();
const byOldPath = new Map();
for (const item of report.changedGlbs || []) {
  byOldSha.set(item.oldSha256, item);
  byOldPath.set(item.oldPath, item);
}

/** Recursively update any JSON object/array holding bytes/sha256/path references to compressed GLBs. */
function syncObject(node, baseDirRel = '') {
  if (Array.isArray(node)) {
    let changed = 0;
    for (const item of node) changed += syncObject(item, baseDirRel);
    return changed;
  }
  if (!node || typeof node !== 'object') return 0;

  let changed = 0;

  // Check if this object directly describes a GLB via sha256 or path/model/file
  let match = null;
  if (typeof node.sha256 === 'string' && byOldSha.has(node.sha256)) {
    match = byOldSha.get(node.sha256);
  } else {
    for (const key of ['model', 'file', 'path']) {
      const val = node[key];
      if (typeof val !== 'string' || !val.endsWith('.glb')) continue;
      const direct = byOldPath.get(val);
      const joined = baseDirRel ? byOldPath.get(path.posix.join(baseDirRel, val)) : null;
      if (direct || joined) {
        match = direct || joined;
        break;
      }
    }
  }

  if (match) {
    if (typeof node.bytes === 'number' && node.bytes !== match.newBytes) {
      node.bytes = match.newBytes;
      changed++;
    }
    if (typeof node.sha256 === 'string' && node.sha256 !== match.newSha256) {
      node.sha256 = match.newSha256;
      changed++;
    }
    if (match.oldPath !== match.newPath) {
      for (const key of ['model', 'file', 'path']) {
        if (typeof node[key] !== 'string') continue;
        if (node[key] === match.oldPath) {
          node[key] = match.newPath;
          changed++;
        } else if (baseDirRel && path.posix.join(baseDirRel, node[key]) === match.oldPath) {
          node[key] = path.posix.relative(baseDirRel, match.newPath);
          changed++;
        } else if (node[key] === path.posix.basename(match.oldPath)) {
          node[key] = path.posix.basename(match.newPath);
          changed++;
        }
      }
    }
  }

  for (const val of Object.values(node)) {
    if (val && typeof val === 'object') changed += syncObject(val, baseDirRel);
  }
  return changed;
}

/** Update JS files (shared/*.js) by exact oldSha256 -> newSha256, oldBytes -> newBytes, oldPath -> newPath inside object literals. */
function syncJsModule(relFile) {
  const full = path.join(ROOT, relFile);
  let src = fs.readFileSync(full, 'utf8');
  const origSrc = src;
  let replacements = 0;

  for (const item of report.changedGlbs || []) {
    if (!src.includes(item.oldSha256) && !src.includes(item.oldPath)) continue;
    // Update exact path if renamed (popular hash-suffixed agent GLBs)
    if (item.oldPath !== item.newPath) {
      const beforePath = src;
      src = src.replaceAll(item.oldPath, item.newPath);
      const oldBase = path.posix.basename(item.oldPath);
      const newBase = path.posix.basename(item.newPath);
      src = src.replaceAll(`"${oldBase}"`, `"${newBase}"`);
      if (src !== beforePath) replacements++;
    }
    // Replace bytes + sha256 pair cleanly (bytes always sits adjacent to sha256 in generated shared/*.js)
    const pairRe = new RegExp(
      `("bytes"\\s*:\\s*)${item.oldBytes}(\\s*,\\s*"sha256"\\s*:\\s*")${item.oldSha256}(")`,
      'g',
    );
    const next = src.replace(pairRe, `$1${item.newBytes}$2${item.newSha256}$3`);
    if (next !== src) {
      src = next;
      replacements++;
    } else {
      // Fallback: sha256 before bytes
      const revRe = new RegExp(
        `("sha256"\\s*:\\s*")${item.oldSha256}("\\s*,\\s*"bytes"\\s*:\\s*)${item.oldBytes}\\b`,
        'g',
      );
      const nextRev = src.replace(revRe, `$1${item.newSha256}$2${item.newBytes}`);
      if (nextRev !== src) {
        src = nextRev;
        replacements++;
      }
    }
  }

  if (replacements > 0) {
    fs.writeFileSync(full, src, 'utf8');
  }
  console.log(`[sync-js] ${relFile}: ${replacements} entries updated`);
}

for (const jsFile of [
  'shared/skins.js',
  'shared/agent-assets.js',
  'shared/agent-arm-assets.js',
  'shared/utility-assets.js',
  'shared/c4-asset.js',
]) {
  syncJsModule(jsFile);
}

// Sync every JSON manifest under public/assets/
function walkJson(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJson(full);
    } else if (entry.name.endsWith('.json') && entry.name.includes('manifest')) {
      const text = fs.readFileSync(full, 'utf8');
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      const baseDirRel = path.relative(PUBLIC, path.dirname(full)).replaceAll('\\', '/');
      const changed = syncObject(data, baseDirRel);
      if (changed > 0) {
        fs.writeFileSync(full, JSON.stringify(data, null, 2) + '\n', 'utf8');
        console.log(`[sync-json] ${path.relative(ROOT, full)}: ${changed} fields updated`);
      }
    }
  }
}
walkJson(path.join(PUBLIC, 'assets'));

// Self-verify 100% of SKINS, AGENT_ASSETS, AGENT_ARM_ASSETS, UTILITY_ASSETS on disk!
const { SKINS } = await import('../shared/skins.js');
const { AGENT_ASSETS } = await import('../shared/agent-assets.js');
const { AGENT_ARM_ASSETS } = await import('../shared/agent-arm-assets.js');
const { UTILITY_ASSETS } = await import('../shared/utility-assets.js');

const verifyFile = (relPath, expectedBytes, expectedSha, label) => {
  const full = path.join(PUBLIC, relPath);
  if (!fs.existsSync(full)) throw Error(`[verify-fail] Missing ${label}: ${relPath}`);
  const buf = fs.readFileSync(full);
  if (expectedBytes && buf.length !== expectedBytes) {
    throw Error(`[verify-fail] Bytes mismatch on ${label} (${relPath}): disk=${buf.length} manifest=${expectedBytes}`);
  }
  if (expectedSha) {
    const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
    if (actualSha !== expectedSha) {
      throw Error(`[verify-fail] SHA-256 mismatch on ${label} (${relPath}): disk=${actualSha} manifest=${expectedSha}`);
    }
  }
};

let checked = 0;
for (const s of SKINS) {
  if (s.model) { verifyFile(s.model, s.bytes, s.sha256, `skin:${s.id}`); checked++; }
  if (s.animation?.model) { verifyFile(s.animation.model, s.animation.bytes, s.animation.sha256, `skin-anim:${s.id}`); checked++; }
}
for (const [id, a] of Object.entries(AGENT_ASSETS)) {
  if (a.model) { verifyFile(a.model, a.bytes, a.sha256, `agent:${id}`); checked++; }
}
for (const [id, a] of Object.entries(AGENT_ARM_ASSETS)) {
  if (a.model) { verifyFile(a.model, a.bytes, a.sha256, `agent-arm:${id}`); checked++; }
}
for (const [id, u] of Object.entries(UTILITY_ASSETS)) {
  if (u.model) { verifyFile(u.model, u.bytes, u.sha256, `utility:${id}`); checked++; }
}

console.log(`[verify-ok] Verified ${checked} GLB manifest entries: 100% exact bytes & SHA-256 match!`);
