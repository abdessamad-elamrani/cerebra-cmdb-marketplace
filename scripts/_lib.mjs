import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg) continue;

    if (arg.startsWith('--')) {
      const raw = arg.slice(2);
      if (!raw) continue;
      const eq = raw.indexOf('=');
      if (eq === -1) {
        flags[raw] = 'true';
      } else {
        const key = raw.slice(0, eq);
        const value = raw.slice(eq + 1);
        if (!key) continue;
        flags[key] = value;
      }
      continue;
    }

    // Minimal short-flag support: "-h" -> { h: "true" }
    if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1);
      if (key) flags[key] = 'true';
    }
  }
  return flags;
}

export function readStringFlag(flags, key) {
  if (!flags || typeof flags !== 'object') return null;
  const value = flags[key];
  if (value === undefined || value === null) return null;
  return String(value);
}

export function readBooleanFlag(flags, key) {
  const raw = readStringFlag(flags, key);
  if (raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'y' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'n' || v === 'off') return false;
  return undefined;
}

export function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON (${filePath}): ${message}`);
  }
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function safeUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

export function normalizePackId(packId) {
  if (typeof packId !== 'string') return '';
  return packId.trim().toLowerCase();
}

export function isValidPublisherOrSlug(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  if (v.length > 64) return false;
  // Lowercase, digits, hyphen. Keep it URL-friendly.
  return /^[a-z0-9][a-z0-9-]*$/.test(v);
}

export function normalizeSemver(version) {
  if (typeof version !== 'string') return '';
  const v = version.trim();
  if (!v) return '';
  if (v.startsWith('v') || v.startsWith('V')) return v.slice(1);
  return v;
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isSemver(version) {
  if (typeof version !== 'string') return false;
  const v = normalizeSemver(version);
  return SEMVER_RE.test(v);
}

function parseSemver(version) {
  const v = normalizeSemver(version);
  const match = SEMVER_RE.exec(v);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const pre = match[4] ? match[4].split('.') : [];
  return { major, minor, patch, pre };
}

function compareIdentifiers(a, b) {
  const aNum = /^[0-9]+$/.test(a);
  const bNum = /^[0-9]+$/.test(b);
  if (aNum && bNum) {
    const diff = Number(a) - Number(b);
    return diff === 0 ? 0 : diff > 0 ? 1 : -1;
  }
  if (aNum && !bNum) return -1;
  if (!aNum && bNum) return 1;
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  const aPre = pa.pre;
  const bPre = pb.pre;

  // No pre-release means higher precedence.
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    const ai = aPre[i];
    const bi = bPre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const cmp = compareIdentifiers(ai, bi);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function isUuid(value) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

export function sha256FileHex(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function isSafeRelativePath(relPath) {
  if (typeof relPath !== 'string') return false;
  const raw = relPath.trim();
  if (!raw) return false;
  if (raw.includes('\u0000')) return false;
  if (raw.includes('\\')) return false;
  if (path.isAbsolute(raw)) return false;

  const normalized = path.posix.normalize(raw);
  if (normalized === '.' || normalized.startsWith('..') || normalized.includes('/../')) return false;
  if (normalized.startsWith('/')) return false;
  return true;
}

export function listFilesRecursive(rootDir) {
  const out = [];

  function walk(absDir, relDir) {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? path.posix.join(relDir, entry.name) : entry.name;

      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }

  walk(rootDir, '');
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

export function pad(value, width) {
  const s = String(value);
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

export function truncate(value, max) {
  const s = String(value);
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return `${s.slice(0, max - 3)}...`;
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = n;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  const decimals = idx === 0 ? 0 : val >= 10 ? 1 : 2;
  return `${val.toFixed(decimals)} ${units[idx]}`;
}
