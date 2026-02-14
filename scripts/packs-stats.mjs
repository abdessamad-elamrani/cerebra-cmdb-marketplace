#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  formatBytes,
  pad,
  parseFlags,
  readBooleanFlag,
  readJson,
  readStringFlag,
  truncate,
} from './_lib.mjs';

function printUsageAndExit(code = 1) {
  console.log('Usage: node scripts/packs-stats.mjs [options]');
  console.log('');
  console.log('Options:');
  console.log('  --catalog=catalog/index.v1.json   Catalog path (default: catalog/index.v1.json)');
  console.log('  --json=true                       Print JSON instead of table');
  process.exit(code);
}

function safeStatBytes(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function safeReadJson(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (readStringFlag(flags, 'help') || readStringFlag(flags, 'h')) {
    printUsageAndExit(0);
  }

  const catalogPath = readStringFlag(flags, 'catalog') || path.join('catalog', 'index.v1.json');
  const json = readBooleanFlag(flags, 'json') === true;

  if (!fs.existsSync(catalogPath)) {
    console.error(`Catalog not found: ${catalogPath}`);
    process.exit(1);
  }

  const catalog = readJson(catalogPath);
  const packs = Array.isArray(catalog?.packs) ? catalog.packs : [];

  const rows = [];

  for (const entry of packs) {
    if (!entry || typeof entry !== 'object') continue;
    const packId = typeof entry.packId === 'string' ? entry.packId.trim() : '';
    const latestVersion = typeof entry.latestVersion === 'string' ? entry.latestVersion.trim() : '';
    const displayName = typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
    if (!packId || !latestVersion) continue;

    const versionDir = path.join('packs', packId, 'versions', latestVersion);
    const manifestPath = path.join(versionDir, 'manifest.v1.json');

    const out = {
      packId,
      latestVersion,
      displayName: displayName || packId,
      commandCount: 0,
      uniqueTags: 0,
      assetsCount: 0,
      graphsCount: 0,
      profileBytes: 0,
      assetsBytes: 0,
      graphsBytes: 0,
      totalBytes: 0,
      status: 'ok',
      error: null,
    };

    try {
      const manifest = safeReadJson(manifestPath);
      if (!manifest) throw new Error(`Missing or invalid manifest: ${manifestPath}`);

      const profileRel = (manifest && typeof manifest === 'object' && manifest.profile && typeof manifest.profile === 'object' && typeof manifest.profile.file === 'string')
        ? manifest.profile.file.trim()
        : 'profile.json';
      const profilePath = path.join(versionDir, profileRel);

      const profile = safeReadJson(profilePath);
      if (!Array.isArray(profile)) throw new Error(`Missing or invalid profile: ${profilePath}`);

      out.commandCount = profile.length;

      const tags = new Set();
      for (const command of profile) {
        if (!command || typeof command !== 'object') continue;
        if (Array.isArray(command.tags)) {
          for (const tag of command.tags) {
            if (typeof tag === 'string' && tag.trim()) tags.add(tag.trim());
          }
        }
      }
      out.uniqueTags = tags.size;

      out.profileBytes = safeStatBytes(profilePath);

      const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
      const graphs = Array.isArray(manifest.graphs) ? manifest.graphs : [];

      out.assetsCount = assets.length;
      out.graphsCount = graphs.length;

      for (const ref of assets) {
        if (!ref || typeof ref !== 'object' || typeof ref.file !== 'string') continue;
        out.assetsBytes += safeStatBytes(path.join(versionDir, ref.file));
      }
      for (const ref of graphs) {
        if (!ref || typeof ref !== 'object' || typeof ref.file !== 'string') continue;
        out.graphsBytes += safeStatBytes(path.join(versionDir, ref.file));
      }

      out.totalBytes = out.profileBytes + out.assetsBytes + out.graphsBytes;
    } catch (error) {
      out.status = 'error';
      out.error = error instanceof Error ? error.message : String(error);
    }

    rows.push(out);
  }

  rows.sort((a, b) => a.packId.localeCompare(b.packId));

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`Pack stats (${rows.length})`);
  console.log('');
  const header = [
    pad('PACK', 30),
    pad('VER', 10),
    pad('CMD', 4),
    pad('TAGS', 4),
    pad('ASSET', 5),
    pad('GRAPH', 5),
    pad('SIZE', 10),
    'STATUS',
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const row of rows) {
    const status = row.status === 'ok'
      ? 'ok'
      : `error: ${row.error || 'unknown'}`;
    console.log(
      [
        pad(truncate(row.packId, 30), 30),
        pad(truncate(row.latestVersion, 10), 10),
        pad(String(row.commandCount), 4),
        pad(String(row.uniqueTags), 4),
        pad(String(row.assetsCount), 5),
        pad(String(row.graphsCount), 5),
        pad(formatBytes(row.totalBytes), 10),
        truncate(status, 80),
      ].join(' | ')
    );
  }
}

main();
