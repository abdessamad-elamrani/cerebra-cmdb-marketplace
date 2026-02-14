#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
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
  console.log('Usage: node scripts/packs-remove.mjs --packId=<publisher.slug> [options]');
  console.log('');
  console.log('Modes:');
  console.log('  --mode=delist     Remove from catalog only (default)');
  console.log('  --mode=purge      Delete files from packs/ (optionally a specific version)');
  console.log('');
  console.log('Options:');
  console.log('  --packId=<id>                 Pack id (required)');
  console.log('  --catalog=catalog/index.v1.json   Catalog path (default: catalog/index.v1.json)');
  console.log('  --yes=true                    Apply changes (default: false = dry-run)');
  console.log('');
  console.log('Purge-only:');
  console.log('  --version=<semver>            Purge a specific version folder instead of whole pack');
  console.log('  --nextLatestVersion=<semver>  Required when purging the current latestVersion');
  process.exit(code);
}

function die(message) {
  console.error(message);
  process.exit(1);
}

function buildRawManifestUrl(owner, repo, branch, packId, version) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/packs/${encodeURIComponent(packId)}/versions/${encodeURIComponent(version)}/manifest.v1.json`;
}

function tryRewriteManifestUrl(existingUrl, packId, nextVersion) {
  if (typeof existingUrl !== 'string' || !existingUrl.trim()) return null;
  const parsed = safeUrl(existingUrl);
  if (!parsed) return null;

  const needle = `/packs/${packId}/versions/`;
  const full = parsed.toString();
  const idx = full.indexOf(needle);
  if (idx === -1) return null;

  // Keep whatever prefix (host/cdn/raw) exists, just replace the version segment.
  const prefix = full.slice(0, idx + needle.length);
  return `${prefix}${nextVersion}/manifest.v1.json`;
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
    // validator covers schema
  }
  return null;
}

function loadCatalog(catalogPath) {
  if (!fs.existsSync(catalogPath)) die(`Catalog not found: ${catalogPath}`);
  const catalog = readJson(catalogPath);
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    die(`Catalog root must be an object: ${catalogPath}`);
  }
  if (!Array.isArray(catalog.packs)) catalog.packs = [];
  return catalog;
}

function findCatalogEntryIndex(catalog, packId) {
  const target = normalizePackId(packId);
  return catalog.packs.findIndex((p) => p && typeof p === 'object' && normalizePackId(p.packId) === target);
}

function ensureSafePackId(packId) {
  if (!packId || typeof packId !== 'string') die('Missing required --packId.');
  const trimmed = packId.trim();
  if (!trimmed) die('Missing required --packId.');
  if (trimmed.includes('/') || trimmed.includes('\\\\')) die(`Invalid packId (path separator): ${trimmed}`);
  if (trimmed.startsWith('.')) die(`Invalid packId: ${trimmed}`);
  return trimmed;
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (readStringFlag(flags, 'help') || readStringFlag(flags, 'h')) {
    printUsageAndExit(0);
  }

  const packId = ensureSafePackId(readStringFlag(flags, 'packId'));
  const mode = (readStringFlag(flags, 'mode') || 'delist').trim().toLowerCase();
  const catalogPath = readStringFlag(flags, 'catalog') || path.join('catalog', 'index.v1.json');
  const yes = readBooleanFlag(flags, 'yes') === true;

  const versionRaw = readStringFlag(flags, 'version');
  const version = versionRaw ? normalizeSemver(versionRaw) : null;
  const nextLatestRaw = readStringFlag(flags, 'nextLatestVersion');
  const nextLatestVersion = nextLatestRaw ? normalizeSemver(nextLatestRaw) : null;

  if (mode !== 'delist' && mode !== 'purge') {
    die(`Invalid --mode=${mode}. Expected "delist" or "purge".`);
  }

  if (mode === 'delist' && version) {
    die('Delist applies to the whole pack. Remove --version or use --mode=purge.');
  }

  if (version && !isSemver(version)) {
    die(`Invalid --version (expected semver): ${versionRaw}`);
  }
  if (nextLatestVersion && !isSemver(nextLatestVersion)) {
    die(`Invalid --nextLatestVersion (expected semver): ${nextLatestRaw}`);
  }

  const catalog = loadCatalog(catalogPath);
  const idx = findCatalogEntryIndex(catalog, packId);
  const wasListed = idx !== -1;
  const existingEntry = wasListed ? catalog.packs[idx] : null;

  const packDir = path.join('packs', packId);
  const packJsonPath = path.join(packDir, 'pack.json');

  let packJson = null;
  if (fs.existsSync(packJsonPath)) {
    try {
      packJson = readJson(packJsonPath);
    } catch {
      packJson = null;
    }
  }

  const plan = [];

  if (mode === 'delist') {
    if (!wasListed) {
      console.log(`Pack is not listed in catalog (nothing to delist): ${packId}`);
      return;
    }
    plan.push({ kind: 'catalog', action: 'removeEntry', packId });

    console.log(`Plan (${yes ? 'apply' : 'dry-run'}):`);
    console.log(`- Delist pack from catalog: ${packId}`);

    if (!yes) return;

    catalog.packs.splice(idx, 1);
    catalog.generatedAt = new Date().toISOString();
    writeJson(catalogPath, catalog);
  }

  if (mode === 'purge') {
    if (!fs.existsSync(packDir) || !fs.statSync(packDir).isDirectory()) {
      die(`Pack directory not found: ${packDir}`);
    }

    if (!version) {
      plan.push({ kind: 'catalog', action: 'removeEntry', packId, onlyIfListed: true });
      plan.push({ kind: 'fs', action: 'rmDir', path: packDir });

      console.log(`Plan (${yes ? 'apply' : 'dry-run'}):`);
      console.log(`- Purge pack directory: ${packDir}`);
      console.log(`- Delist pack from catalog (if present): ${packId}`);

      if (!yes) return;

      if (wasListed) {
        catalog.packs.splice(idx, 1);
        catalog.generatedAt = new Date().toISOString();
        writeJson(catalogPath, catalog);
      }

      fs.rmSync(packDir, { recursive: true, force: true });
    } else {
      const versionDir = path.join(packDir, 'versions', version);
      if (!fs.existsSync(versionDir) || !fs.statSync(versionDir).isDirectory()) {
        die(`Version directory not found: ${versionDir}`);
      }

      const currentLatest = packJson && typeof packJson.latestVersion === 'string'
        ? normalizeSemver(packJson.latestVersion)
        : null;

      const isLatest = currentLatest ? normalizeSemver(currentLatest) === version : false;

      if (isLatest && !nextLatestVersion) {
        die(`Refusing to purge latestVersion (${version}). Provide --nextLatestVersion=<semver>.`);
      }
      if (isLatest && nextLatestVersion) {
        const nextDir = path.join(packDir, 'versions', nextLatestVersion);
        if (!fs.existsSync(nextDir) || !fs.statSync(nextDir).isDirectory()) {
          die(`nextLatestVersion directory not found: ${nextDir}`);
        }
      }

      plan.push({ kind: 'fs', action: 'rmDir', path: versionDir });
      if (isLatest) {
        plan.push({ kind: 'pack.json', action: 'setLatestVersion', packId, from: currentLatest, to: nextLatestVersion });
        if (wasListed) {
          plan.push({ kind: 'catalog', action: 'setLatestVersion', packId, from: existingEntry?.latestVersion, to: nextLatestVersion });
        }
      }

      console.log(`Plan (${yes ? 'apply' : 'dry-run'}):`);
      console.log(`- Purge version directory: ${versionDir}`);
      if (isLatest) {
        console.log(`- Promote nextLatestVersion in pack.json: ${currentLatest} -> ${nextLatestVersion}`);
        if (wasListed) console.log(`- Update catalog entry latestVersion: ${existingEntry?.latestVersion} -> ${nextLatestVersion}`);
      }

      if (!yes) return;

      fs.rmSync(versionDir, { recursive: true, force: true });

      if (isLatest) {
        if (!packJson || typeof packJson !== 'object' || Array.isArray(packJson)) {
          die(`pack.json is missing or invalid (needed to update latestVersion): ${packJsonPath}`);
        }

        packJson.latestVersion = nextLatestVersion;
        writeJson(packJsonPath, packJson);

        if (wasListed) {
          const entry = catalog.packs[idx];
          // idx is still valid because we didn't splice catalog in this mode.
          entry.latestVersion = nextLatestVersion;
          const rewritten = tryRewriteManifestUrl(entry.manifestUrl, packId, nextLatestVersion);
          entry.manifestUrl = rewritten || buildRawManifestUrl(DEFAULT_OWNER, DEFAULT_REPO, DEFAULT_BRANCH, packId, nextLatestVersion);

          const minAppVersion = readManifestMinAppVersion(packId, nextLatestVersion);
          if (minAppVersion) entry.minAppVersion = minAppVersion;
          else delete entry.minAppVersion;

          catalog.generatedAt = new Date().toISOString();
          writeJson(catalogPath, catalog);
        }
      }
    }
  }

  if (!yes) return;

  // Post-condition: keep repo in a CI-passable state.
  // Run validators in strict mode so maintainers don't ship warnings.
  try {
    // eslint-disable-next-line no-console
    console.log('');
    console.log('Running validators (strict)...');
    execSync('node scripts/validate-catalog.mjs --strict=true', { stdio: 'inherit' });
    execSync('node scripts/validate-pack.mjs --all=true --strict=true', { stdio: 'inherit' });
  } catch {
    die('Validators failed after applying changes. Review output above and fix or revert the change.');
  }
}

main();
