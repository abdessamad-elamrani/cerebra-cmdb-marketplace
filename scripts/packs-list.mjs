#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import {
  pad,
  parseFlags,
  readBooleanFlag,
  readJson,
  readStringFlag,
  truncate,
} from './_lib.mjs';

function printUsageAndExit(code = 1) {
  console.log('Usage: node scripts/packs-list.mjs [options]');
  console.log('');
  console.log('Options:');
  console.log('  --file=catalog/index.v1.json   Catalog path (default: catalog/index.v1.json)');
  console.log('  --json=true                    Print JSON instead of table');
  process.exit(code);
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (readStringFlag(flags, 'help') || readStringFlag(flags, 'h')) {
    printUsageAndExit(0);
  }

  const file = readStringFlag(flags, 'file') || path.join('catalog', 'index.v1.json');
  const json = readBooleanFlag(flags, 'json') === true;

  if (!fs.existsSync(file)) {
    console.error(`Catalog not found: ${file}`);
    process.exit(1);
  }

  const catalog = readJson(file);
  const packs = Array.isArray(catalog?.packs) ? catalog.packs : [];

  const rows = packs
    .filter((p) => p && typeof p === 'object' && typeof p.packId === 'string')
    .map((p) => ({
      packId: String(p.packId).trim(),
      latestVersion: typeof p.latestVersion === 'string' ? p.latestVersion.trim() : '',
      displayName: typeof p.displayName === 'string' ? p.displayName.trim() : '',
    }))
    .filter((row) => row.packId)
    .sort((a, b) => a.packId.localeCompare(b.packId));

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`Marketplace packs (${rows.length})`);
  console.log('');

  const header = [pad('PACK', 34), pad('LATEST', 12), 'DISPLAY'].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const row of rows) {
    console.log(
      [
        pad(truncate(row.packId, 34), 34),
        pad(truncate(row.latestVersion || '-', 12), 12),
        truncate(row.displayName || '-', 60),
      ].join(' | ')
    );
  }
}

main();

