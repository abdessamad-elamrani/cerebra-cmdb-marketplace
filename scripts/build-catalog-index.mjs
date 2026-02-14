#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  isSafeRelativePath,
  isSemver,
  normalizePackId,
  normalizeSemver,
  parseFlags,
  readBooleanFlag,
  readJson,
  readStringFlag,
  safeUrl,
  writeJson,
} from './_lib.mjs';

const DEFAULT_OWNER = 'abdessamad-elamrani';
const DEFAULT_REPO = 'cerebra-cmdb-marketplace';
const DEFAULT_BRANCH = 'main';

function printUsageAndExit(code = 1) {
  console.log('Usage: node scripts/build-catalog-index.mjs [options]');
  console.log('');
  console.log('Options:');
  console.log('  --write=true                 Write catalog/index.v1.json (default: false, prints to stdout)');
  console.log('  --preserveUrls=true          Preserve existing manifestUrl host/prefix when possible (default: true)');
  console.log(`  --repoOwner=${DEFAULT_OWNER}         GitHub owner for manifestUrl generation fallback`);
  console.log(`  --repoName=${DEFAULT_REPO}    GitHub repo name for manifestUrl generation fallback`);
  console.log(`  --branch=${DEFAULT_BRANCH}           GitHub branch for manifestUrl generation fallback`);
  process.exit(code);
}

function splitPackId(packId) {
  const raw = String(packId).trim();
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const publisher = raw.slice(0, dot);
  const slug = raw.slice(dot + 1);
  if (!publisher || !slug) return null;
  return { publisher, slug };
}

function buildRawManifestUrl(owner, repo, branch, packId, version) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/packs/${encodeURIComponent(packId)}/versions/${encodeURIComponent(version)}/manifest.v1.json`;
}

function tryPreserveManifestUrl(existingUrl, packId, version) {
  if (typeof existingUrl !== 'string' || !existingUrl.trim()) return null;
  const parsed = safeUrl(existingUrl);
  if (!parsed) return null;

  const needle = `/packs/${packId}/versions/`;
  const full = parsed.toString();
  const idx = full.indexOf(needle);
  if (idx === -1) return null;

  return `${full.slice(0, idx)}${needle}${version}/manifest.v1.json`;
}

function readManifestMinAppVersion(packId, version) {
  const manifestPath = path.join('packs', packId, 'versions', version, 'manifest.v1.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = readJson(manifestPath);
    if (manifest && typeof manifest === 'object' && typeof manifest.minAppVersion === 'string' && manifest.minAppVersion.trim()) {
      return manifest.minAppVersion.trim();
    }
  } catch {
    // ignore; validator covers schema
  }
  return null;
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (readStringFlag(flags, 'help') || readStringFlag(flags, 'h')) {
    printUsageAndExit(0);
  }

  const write = readBooleanFlag(flags, 'write') === true;
  const preserveUrls = readBooleanFlag(flags, 'preserveUrls');
  const preserve = preserveUrls === undefined ? true : preserveUrls;

  const repoOwner = readStringFlag(flags, 'repoOwner') || DEFAULT_OWNER;
  const repoName = readStringFlag(flags, 'repoName') || DEFAULT_REPO;
  const branch = readStringFlag(flags, 'branch') || DEFAULT_BRANCH;

  let existingCatalog = null;
  const catalogPath = path.join('catalog', 'index.v1.json');
  if (fs.existsSync(catalogPath)) {
    try {
      existingCatalog = readJson(catalogPath);
    } catch {
      existingCatalog = null;
    }
  }

  const existingByPackId = new Map();
  if (existingCatalog && Array.isArray(existingCatalog.packs)) {
    for (const entry of existingCatalog.packs) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.packId !== 'string' || !entry.packId.trim()) continue;
      existingByPackId.set(normalizePackId(entry.packId), entry);
    }
  }

  const packsRoot = 'packs';
  if (!fs.existsSync(packsRoot) || !fs.statSync(packsRoot).isDirectory()) {
    throw new Error('Missing packs/ directory.');
  }

  const packDirs = fs.readdirSync(packsRoot)
    .filter((name) => fs.existsSync(path.join(packsRoot, name, 'pack.json')))
    .sort((a, b) => a.localeCompare(b));

  const packs = [];

  for (const packId of packDirs) {
    const packPath = path.join(packsRoot, packId, 'pack.json');
    let packJson;
    try {
      packJson = readJson(packPath);
    } catch {
      continue;
    }

    const packMeta = splitPackId(packId);
    if (!packMeta) continue;

    const publisher = packMeta.publisher;
    const slug = packMeta.slug;

    const latestVersionRaw = typeof packJson.latestVersion === 'string' ? packJson.latestVersion.trim() : '';
    const latestVersion = normalizeSemver(latestVersionRaw);
    if (!latestVersion || !isSemver(latestVersion)) continue;

    const existing = existingByPackId.get(normalizePackId(packId));
    const displayName =
      (typeof packJson.displayName === 'string' && packJson.displayName.trim())
        ? packJson.displayName.trim()
        : (existing && typeof existing.displayName === 'string' && existing.displayName.trim())
          ? existing.displayName.trim()
          : slug;

    const description =
      (typeof packJson.description === 'string' && packJson.description.trim())
        ? packJson.description.trim()
        : (existing && typeof existing.description === 'string' && existing.description.trim())
          ? existing.description.trim()
          : undefined;

    const tags =
      Array.isArray(packJson.tags) && packJson.tags.every((t) => typeof t === 'string' && t.trim())
        ? packJson.tags
        : (existing && Array.isArray(existing.tags) ? existing.tags : undefined);

    const minAppVersion = readManifestMinAppVersion(packId, latestVersion);

    let manifestUrl = buildRawManifestUrl(repoOwner, repoName, branch, packId, latestVersion);
    if (preserve && existing && typeof existing.manifestUrl === 'string') {
      const preserved = tryPreserveManifestUrl(existing.manifestUrl, packId, latestVersion);
      if (preserved) manifestUrl = preserved;
    }

    packs.push({
      packId,
      publisher,
      slug,
      displayName,
      latestVersion: latestVersion,
      ...(minAppVersion ? { minAppVersion } : {}),
      manifestUrl,
      ...(tags ? { tags } : {}),
      ...(description ? { description } : {}),
    });
  }

  packs.sort((a, b) => a.packId.localeCompare(b.packId));

  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packs,
  };

  if (write) {
    writeJson(catalogPath, catalog);
    console.log(`Wrote catalog: ${catalogPath} (${packs.length} packs)`);
    return;
  }

  console.log(JSON.stringify(catalog, null, 2));
}

main();
