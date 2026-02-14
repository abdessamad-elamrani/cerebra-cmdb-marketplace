#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  isSemver,
  isValidPublisherOrSlug,
  normalizePackId,
  pad,
  parseFlags,
  readBooleanFlag,
  readJson,
  readStringFlag,
  safeUrl,
  truncate,
} from './_lib.mjs';

function printUsageAndExit(code = 1) {
  console.log('Usage: node scripts/validate-catalog.mjs [options]');
  console.log('');
  console.log('Options:');
  console.log('  --file=catalog/index.v1.json   Catalog path (default: catalog/index.v1.json)');
  console.log('  --strict=true                  Treat warnings as failures (default: false)');
  console.log('  --json=true                    Print machine-readable issue list');
  process.exit(code);
}

function addIssue(issues, level, message) {
  issues.push({ level, message });
}

function validateCatalog(catalog, strictMode) {
  const issues = [];

  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    addIssue(issues, 'error', 'Catalog root must be a JSON object.');
    return issues;
  }

  const schemaVersion = catalog.schemaVersion;
  if (!Number.isInteger(schemaVersion) || schemaVersion <= 0) {
    addIssue(issues, 'error', 'catalog.schemaVersion must be a positive integer.');
  }

  const generatedAt = catalog.generatedAt;
  if (typeof generatedAt !== 'string' || !generatedAt.trim()) {
    addIssue(issues, 'error', 'catalog.generatedAt must be a non-empty string.');
  } else {
    const asDate = new Date(generatedAt);
    if (Number.isNaN(asDate.getTime())) {
      addIssue(issues, 'error', `catalog.generatedAt is not a parseable timestamp: ${generatedAt}`);
    }
  }

  if (!Array.isArray(catalog.packs)) {
    addIssue(issues, 'error', 'catalog.packs must be an array.');
    return issues;
  }

  const seen = new Map();

  for (const [index, pack] of catalog.packs.entries()) {
    const prefix = `catalog.packs[${index}]`;

    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
      addIssue(issues, 'error', `${prefix} must be an object.`);
      continue;
    }

    const packId = typeof pack.packId === 'string' ? pack.packId.trim() : '';
    const publisher = typeof pack.publisher === 'string' ? pack.publisher.trim() : '';
    const slug = typeof pack.slug === 'string' ? pack.slug.trim() : '';
    const displayName = typeof pack.displayName === 'string' ? pack.displayName.trim() : '';
    const latestVersion = typeof pack.latestVersion === 'string' ? pack.latestVersion.trim() : '';
    const manifestUrl = typeof pack.manifestUrl === 'string' ? pack.manifestUrl.trim() : '';

    if (!packId) addIssue(issues, 'error', `${prefix}.packId is required.`);
    if (!publisher) addIssue(issues, 'error', `${prefix}.publisher is required.`);
    if (!slug) addIssue(issues, 'error', `${prefix}.slug is required.`);
    if (!displayName) addIssue(issues, 'error', `${prefix}.displayName is required.`);
    if (!latestVersion) addIssue(issues, 'error', `${prefix}.latestVersion is required.`);
    if (!manifestUrl) addIssue(issues, 'error', `${prefix}.manifestUrl is required.`);

    if (publisher && !isValidPublisherOrSlug(publisher)) {
      addIssue(issues, 'error', `${prefix}.publisher contains invalid characters: ${publisher}`);
    }
    if (slug && !isValidPublisherOrSlug(slug)) {
      addIssue(issues, 'error', `${prefix}.slug contains invalid characters: ${slug}`);
    }

    if (packId && publisher && slug) {
      const expectedPackId = `${publisher}.${slug}`;
      if (packId !== expectedPackId) {
        addIssue(issues, 'error', `${prefix}.packId must equal publisher.slug (${expectedPackId}).`);
      }
    }

    if (latestVersion && !isSemver(latestVersion)) {
      addIssue(issues, 'error', `${prefix}.latestVersion must be valid semver (got ${latestVersion}).`);
    }

    if (typeof pack.minAppVersion === 'string' && pack.minAppVersion.trim()) {
      if (!isSemver(pack.minAppVersion.trim())) {
        addIssue(issues, 'error', `${prefix}.minAppVersion must be valid semver (got ${pack.minAppVersion}).`);
      }
    }

    if (pack.tags !== undefined) {
      if (!Array.isArray(pack.tags) || !pack.tags.every((tag) => typeof tag === 'string' && tag.trim())) {
        addIssue(issues, 'error', `${prefix}.tags must be an array of non-empty strings.`);
      }
    }

    if (pack.description !== undefined) {
      if (typeof pack.description !== 'string') {
        addIssue(issues, 'error', `${prefix}.description must be a string when present.`);
      }
    }

    if (manifestUrl) {
      const parsed = safeUrl(manifestUrl);
      if (!parsed) {
        addIssue(issues, 'error', `${prefix}.manifestUrl must be a valid URL.`);
      } else {
        const expectedSuffix = `/packs/${encodeURIComponent(packId)}/versions/${encodeURIComponent(latestVersion)}/manifest.v1.json`;
        const pathname = decodeURIComponent(parsed.pathname);
        if (packId && latestVersion && !pathname.endsWith(`/packs/${packId}/versions/${latestVersion}/manifest.v1.json`)) {
          addIssue(
            issues,
            strictMode ? 'warn' : 'info',
            `${prefix}.manifestUrl does not end with the expected path for packId/version (got ${pathname}).`
          );
        }
      }
    }

    const normalizedId = normalizePackId(packId);
    if (normalizedId) {
      const existing = seen.get(normalizedId);
      if (existing) {
        addIssue(
          issues,
          'error',
          `Duplicate packId (case-insensitive): "${packId}" conflicts with "${existing}".`
        );
      } else {
        seen.set(normalizedId, packId);
      }
    }
  }

  // Optional: catalog should be stable-sorted by packId for review clarity.
  const packIds = catalog.packs
    .map((p) => (p && typeof p.packId === 'string' ? p.packId.trim() : ''))
    .filter(Boolean);
  const sorted = [...packIds].sort((a, b) => a.localeCompare(b));
  const isSorted = packIds.every((value, idx) => value === sorted[idx]);
  if (!isSorted) {
    addIssue(
      issues,
      strictMode ? 'warn' : 'info',
      'Catalog packs are not sorted by packId. (Recommended for clean diffs.)'
    );
  }

  return issues;
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (readStringFlag(flags, 'help') || readStringFlag(flags, 'h')) {
    printUsageAndExit(0);
  }

  const strict = readBooleanFlag(flags, 'strict') === true;
  const json = readBooleanFlag(flags, 'json') === true;
  const file = readStringFlag(flags, 'file') || path.join('catalog', 'index.v1.json');

  if (!fs.existsSync(file)) {
    console.error(`Catalog file not found: ${file}`);
    process.exit(1);
  }

  let catalog;
  try {
    catalog = readJson(file);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const issues = validateCatalog(catalog, strict);
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warn').length;
  const infos = issues.filter((i) => i.level === 'info').length;

  if (json) {
    console.log(JSON.stringify({ file, strict, errors, warnings, infos, issues }, null, 2));
  } else {
    console.log(`Catalog validation: ${file}`);
    console.log('');

    if (issues.length === 0) {
      console.log('OK: no issues found.');
    } else {
      const header = [pad('LEVEL', 7), 'MESSAGE'].join(' | ');
      console.log(header);
      console.log('-'.repeat(header.length));
      for (const issue of issues) {
        console.log([pad(issue.level.toUpperCase(), 7), truncate(issue.message, 160)].join(' | '));
      }
    }

    console.log('');
    console.log(`Summary: ${errors} errors, ${warnings} warnings, ${infos} info`);
  }

  if (errors > 0) process.exit(1);
  if (strict && warnings > 0) process.exit(1);
}

main();
