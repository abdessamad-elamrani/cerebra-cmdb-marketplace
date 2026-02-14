#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  normalizePackId,
  pad,
  parseFlags,
  readBooleanFlag,
  readJson,
  readStringFlag,
  truncate,
} from './_lib.mjs';

function printUsageAndExit(code = 1) {
  console.log('Usage: node scripts/packs-scan.mjs [options]');
  console.log('');
  console.log('Options:');
  console.log('  --catalog=catalog/index.v1.json   Catalog path (default: catalog/index.v1.json)');
  console.log('  --json=true                       Print JSON instead of table');
  process.exit(code);
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
  const catalog = fs.existsSync(catalogPath) ? safeReadJson(catalogPath) : null;
  const catalogPacks = Array.isArray(catalog?.packs) ? catalog.packs : [];
  const catalogIds = new Set(
    catalogPacks
      .map((p) => (p && typeof p === 'object' && typeof p.packId === 'string' ? p.packId.trim() : ''))
      .filter(Boolean)
      .map((id) => normalizePackId(id))
  );

  const packsRoot = 'packs';
  if (!fs.existsSync(packsRoot) || !fs.statSync(packsRoot).isDirectory()) {
    console.error('Missing packs/ directory.');
    process.exit(1);
  }

  const diskDirs = fs.readdirSync(packsRoot)
    .filter((name) => fs.existsSync(path.join(packsRoot, name)) && fs.statSync(path.join(packsRoot, name)).isDirectory())
    .sort((a, b) => a.localeCompare(b));

  const diskRows = [];
  for (const dirName of diskDirs) {
    const packJsonPath = path.join(packsRoot, dirName, 'pack.json');
    const versionsDir = path.join(packsRoot, dirName, 'versions');
    const versions = (fs.existsSync(versionsDir) && fs.statSync(versionsDir).isDirectory())
      ? fs.readdirSync(versionsDir)
        .filter((name) => fs.existsSync(path.join(versionsDir, name)) && fs.statSync(path.join(versionsDir, name)).isDirectory())
        .sort((a, b) => a.localeCompare(b))
      : [];

    if (!fs.existsSync(packJsonPath)) {
      diskRows.push({ packId: dirName, latestVersion: '-', versions, status: 'missing pack.json' });
      continue;
    }
    const packJson = safeReadJson(packJsonPath);
    const latestVersion = packJson && typeof packJson.latestVersion === 'string' ? packJson.latestVersion.trim() : '-';
    const status = catalogIds.has(normalizePackId(dirName)) ? 'listed' : 'delisted/orphan';
    diskRows.push({ packId: dirName, latestVersion, versions, status });
  }

  const catalogMissingOnDisk = catalogPacks
    .map((p) => (p && typeof p === 'object' && typeof p.packId === 'string' ? p.packId.trim() : ''))
    .filter(Boolean)
    .filter((packId) => !fs.existsSync(path.join(packsRoot, packId, 'pack.json')));

  if (json) {
    console.log(JSON.stringify({ catalog: catalogPath, disk: diskRows, catalogMissingOnDisk }, null, 2));
    return;
  }

  console.log(`Disk packs (${diskRows.length})`);
  console.log('');
  const header = [pad('PACK', 30), pad('LATEST', 12), pad('VERSIONS', 26), 'STATUS'].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of diskRows) {
    const versionsLabel = row.versions.length === 0 ? '-' : row.versions.join(', ');
    console.log(
      [
        pad(truncate(row.packId, 30), 30),
        pad(truncate(row.latestVersion, 12), 12),
        pad(truncate(versionsLabel, 26), 26),
        truncate(row.status, 40),
      ].join(' | ')
    );
  }

  console.log('');
  if (catalogMissingOnDisk.length === 0) {
    console.log('Catalog packs missing on disk: none');
  } else {
    console.log(`Catalog packs missing on disk (${catalogMissingOnDisk.length}):`);
    for (const packId of catalogMissingOnDisk.sort((a, b) => a.localeCompare(b))) {
      console.log(`- ${packId}`);
    }
  }
}

main();
