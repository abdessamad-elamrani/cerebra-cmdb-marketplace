#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  compareSemver,
  formatBytes,
  isSafeRelativePath,
  isSemver,
  isUuid,
  normalizePackId,
  normalizeSemver,
  pad,
  parseFlags,
  readBooleanFlag,
  readJson,
  readStringFlag,
  sha256FileHex,
  truncate,
  listFilesRecursive,
} from './_lib.mjs';

const COLOR_REGEX = /^#[0-9a-f]{6}$/i;

function printUsageAndExit(code = 1) {
  console.log('Usage: node scripts/validate-pack.mjs [options]');
  console.log('');
  console.log('Options:');
  console.log('  --all=true                 Validate all catalog packs (recommended for CI)');
  console.log('  --packId=<publisher.slug>   Validate one pack by id');
  console.log('  --version=<semver>          Validate one specific version folder');
  console.log('  --allVersions=true          Validate all versions found on disk for each pack');
  console.log('  --catalog=catalog/index.v1.json   Catalog path (default: catalog/index.v1.json)');
  console.log('  --strict=true               Treat warnings as failures (default: false)');
  console.log('  --json=true                 Print machine-readable issue list');
  process.exit(code);
}

function addIssue(issues, level, message) {
  issues.push({ level, message });
}

function validateCommandShape(command, issues, prefix) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    addIssue(issues, 'error', `${prefix} must be an object.`);
    return;
  }

  if (typeof command.id !== 'string' || !isUuid(command.id)) {
    addIssue(issues, 'error', `${prefix}.id must be a UUID string.`);
  }
  if (typeof command.label !== 'string' || !command.label.trim()) {
    addIssue(issues, 'error', `${prefix}.label must be a non-empty string.`);
  }
  if (typeof command.command !== 'string' || !command.command.trim()) {
    addIssue(issues, 'error', `${prefix}.command must be a non-empty string.`);
  }
  if (typeof command.description !== 'string') {
    addIssue(issues, 'error', `${prefix}.description must be a string (may be empty).`);
  }
  if (!Array.isArray(command.tags) || !command.tags.every((tag) => typeof tag === 'string')) {
    addIssue(issues, 'error', `${prefix}.tags must be an array of strings.`);
  }
  if (command.color !== undefined) {
    if (typeof command.color !== 'string' || !COLOR_REGEX.test(command.color)) {
      addIssue(issues, 'error', `${prefix}.color must be a hex string like #3b82f6.`);
    }
  }
}

function validateProfile(profilePath, issues) {
  let profile;
  try {
    profile = readJson(profilePath);
  } catch (error) {
    addIssue(issues, 'error', `Profile is not valid JSON: ${profilePath}`);
    return { commandIds: new Set() };
  }

  if (!Array.isArray(profile)) {
    addIssue(issues, 'error', `Profile must be a JSON array: ${profilePath}`);
    return { commandIds: new Set() };
  }

  const commandIds = new Set();
  const seen = new Set();

  for (const [index, command] of profile.entries()) {
    const prefix = `${path.basename(profilePath)}[${index}]`;
    validateCommandShape(command, issues, prefix);

    if (command && typeof command === 'object' && typeof command.id === 'string') {
      const id = command.id;
      if (seen.has(id)) {
        addIssue(issues, 'error', `Duplicate command id in profile: ${id}`);
      } else {
        seen.add(id);
      }
      if (isUuid(id)) {
        commandIds.add(id);
      }
    }
  }

  return { commandIds };
}

function validateManifestFile(versionDir, manifestPath, issues, strictMode) {
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch {
    addIssue(issues, 'error', `Manifest is not valid JSON: ${manifestPath}`);
    return null;
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    addIssue(issues, 'error', `Manifest root must be an object: ${manifestPath}`);
    return null;
  }

  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion <= 0) {
    addIssue(issues, 'error', `manifest.schemaVersion must be a positive integer: ${manifestPath}`);
  }
  if (typeof manifest.packId !== 'string' || !manifest.packId.trim()) {
    addIssue(issues, 'error', `manifest.packId is required: ${manifestPath}`);
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    addIssue(issues, 'error', `manifest.version is required: ${manifestPath}`);
  }
  if (!manifest.profile || typeof manifest.profile !== 'object') {
    addIssue(issues, 'error', `manifest.profile is required: ${manifestPath}`);
  } else {
    if (typeof manifest.profile.file !== 'string' || !manifest.profile.file.trim()) {
      addIssue(issues, 'error', `manifest.profile.file is required: ${manifestPath}`);
    }
    if (typeof manifest.profile.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(manifest.profile.sha256)) {
      addIssue(issues, 'error', `manifest.profile.sha256 must be a 64-hex string: ${manifestPath}`);
    }
  }

  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  for (const [i, asset] of assets.entries()) {
    const prefix = `manifest.assets[${i}]`;
    if (!asset || typeof asset !== 'object') {
      addIssue(issues, 'error', `${prefix} must be an object: ${manifestPath}`);
      continue;
    }
    if (typeof asset.file !== 'string' || !asset.file.trim()) {
      addIssue(issues, 'error', `${prefix}.file is required: ${manifestPath}`);
    }
    if (typeof asset.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(asset.sha256)) {
      addIssue(issues, 'error', `${prefix}.sha256 must be a 64-hex string: ${manifestPath}`);
    }
  }

  const graphs = Array.isArray(manifest.graphs) ? manifest.graphs : [];
  for (const [i, graph] of graphs.entries()) {
    const prefix = `manifest.graphs[${i}]`;
    if (!graph || typeof graph !== 'object') {
      addIssue(issues, 'error', `${prefix} must be an object: ${manifestPath}`);
      continue;
    }
    if (typeof graph.commandId !== 'string' || !isUuid(graph.commandId)) {
      addIssue(issues, 'error', `${prefix}.commandId must be a UUID string: ${manifestPath}`);
    }
    if (typeof graph.file !== 'string' || !graph.file.trim()) {
      addIssue(issues, 'error', `${prefix}.file is required: ${manifestPath}`);
    }
    if (typeof graph.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(graph.sha256)) {
      addIssue(issues, 'error', `${prefix}.sha256 must be a 64-hex string: ${manifestPath}`);
    }

    if (strictMode && typeof graph.file === 'string' && isUuid(graph.commandId)) {
      const base = path.posix.basename(graph.file, '.json');
      if (base !== graph.commandId) {
        addIssue(
          issues,
          'warn',
          `Graph filename should match commandId (${graph.commandId}) but got ${graph.file}`
        );
      }
    }
  }

  const referenced = {
    profile: manifest.profile,
    assets,
    graphs,
  };

  const referencedFiles = new Set();
  const addRef = (ref, context) => {
    if (!ref || typeof ref.file !== 'string') return;
    const rel = ref.file.trim();
    if (!rel) return;
    if (!isSafeRelativePath(rel)) {
      addIssue(issues, 'error', `Unsafe referenced path in manifest (${context}): ${rel}`);
      return;
    }
    referencedFiles.add(rel);
  };

  addRef(manifest.profile, 'profile');
  for (const asset of assets) addRef(asset, 'asset');
  for (const graph of graphs) addRef(graph, 'graph');

  // Verify that every referenced file exists and matches sha256.
  for (const entry of [
    { kind: 'profile', items: [manifest.profile] },
    { kind: 'asset', items: assets },
    { kind: 'graph', items: graphs },
  ]) {
    for (const ref of entry.items) {
      if (!ref || typeof ref.file !== 'string' || typeof ref.sha256 !== 'string') continue;
      const rel = ref.file.trim();
      if (!rel) continue;

      const abs = path.join(versionDir, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        addIssue(issues, 'error', `Manifest references missing ${entry.kind} file: ${abs}`);
        continue;
      }

      const digest = sha256FileHex(abs);
      if (digest.toLowerCase() !== ref.sha256.toLowerCase()) {
        addIssue(issues, 'error', `SHA256 mismatch for ${entry.kind} file: ${rel}`);
      }
    }
  }

  // Profile schema + graph command mapping
  const profilePath = manifest?.profile?.file ? path.join(versionDir, manifest.profile.file) : null;
  const { commandIds } = profilePath && fs.existsSync(profilePath)
    ? validateProfile(profilePath, issues)
    : { commandIds: new Set() };

  for (const graph of graphs) {
    if (!graph || typeof graph !== 'object') continue;
    if (typeof graph.commandId === 'string' && isUuid(graph.commandId)) {
      if (!commandIds.has(graph.commandId)) {
        addIssue(issues, 'error', `Graph commandId not found in profile: ${graph.commandId}`);
      }
    }
    if (typeof graph.file === 'string') {
      const abs = path.join(versionDir, graph.file);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        let parsed;
        try {
          parsed = readJson(abs);
        } catch {
          addIssue(issues, 'error', `Graph payload is not valid JSON: ${abs}`);
          continue;
        }
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
          addIssue(issues, 'error', `Graph payload must be a JSON object: ${abs}`);
        }
      }
    }
  }

  // Extra file detection: files present in version dir but not referenced by manifest
  const allFiles = listFilesRecursive(versionDir)
    .filter((rel) => rel !== 'manifest.v1.json')
    .filter((rel) => rel !== '.DS_Store');

  const extras = allFiles.filter((rel) => !referencedFiles.has(rel));
  if (extras.length > 0) {
    addIssue(
      issues,
      strictMode ? 'warn' : 'info',
      `Version folder contains ${extras.length} unreferenced file(s): ${extras.slice(0, 5).join(', ')}${extras.length > 5 ? ', ...' : ''}`
    );
  }

  return manifest;
}

function validatePack(packId, options) {
  const issues = [];
  const packDir = path.join('packs', packId);
  const packJsonPath = path.join(packDir, 'pack.json');
  const strictMode = Boolean(options.strict);

  if (!fs.existsSync(packJsonPath)) {
    addIssue(issues, 'error', `Missing pack.json: ${packJsonPath}`);
    return issues;
  }

  let packJson;
  try {
    packJson = readJson(packJsonPath);
  } catch {
    addIssue(issues, 'error', `pack.json is not valid JSON: ${packJsonPath}`);
    return issues;
  }

  if (!packJson || typeof packJson !== 'object' || Array.isArray(packJson)) {
    addIssue(issues, 'error', `pack.json root must be an object: ${packJsonPath}`);
    return issues;
  }

  if (typeof packJson.packId !== 'string' || !packJson.packId.trim()) {
    addIssue(issues, 'error', `pack.json.packId is required: ${packJsonPath}`);
  } else if (packJson.packId.trim() !== packId) {
    addIssue(issues, 'error', `pack.json.packId must equal directory packId (${packId}).`);
  }

  if (typeof packJson.publisher !== 'string' || !packJson.publisher.trim()) {
    addIssue(issues, 'error', `pack.json.publisher is required: ${packJsonPath}`);
  }

  const latestVersion = typeof packJson.latestVersion === 'string' ? packJson.latestVersion.trim() : '';
  if (!latestVersion) {
    addIssue(issues, 'error', `pack.json.latestVersion is required: ${packJsonPath}`);
  } else {
    const normalized = normalizeSemver(latestVersion);
    if (!isSemver(normalized)) {
      addIssue(issues, 'error', `pack.json.latestVersion must be valid semver (got ${latestVersion}).`);
    }
    if (normalized !== latestVersion) {
      addIssue(
        issues,
        strictMode ? 'warn' : 'info',
        `pack.json.latestVersion includes a leading "v" (recommended to use strict semver): ${latestVersion}`
      );
    }
  }

  if (typeof packJson.license !== 'string' || !packJson.license.trim()) {
    addIssue(issues, 'error', `pack.json.license is required: ${packJsonPath}`);
  }

  const versionsDir = path.join(packDir, 'versions');
  if (!fs.existsSync(versionsDir) || !fs.statSync(versionsDir).isDirectory()) {
    addIssue(issues, 'error', `Missing versions directory: ${versionsDir}`);
    return issues;
  }

  const versionDirs = fs.readdirSync(versionsDir)
    .filter((name) => fs.existsSync(path.join(versionsDir, name)) && fs.statSync(path.join(versionsDir, name)).isDirectory())
    .sort((a, b) => a.localeCompare(b));

  if (versionDirs.length === 0) {
    addIssue(issues, 'error', `No versions found in ${versionsDir}`);
    return issues;
  }

  const selectedVersions = [];
  if (options.version) {
    selectedVersions.push(options.version);
  } else if (options.allVersions) {
    selectedVersions.push(...versionDirs);
  } else {
    selectedVersions.push(latestVersion);
  }

  for (const version of selectedVersions) {
    const versionDir = path.join(versionsDir, version);
    if (!fs.existsSync(versionDir) || !fs.statSync(versionDir).isDirectory()) {
      addIssue(issues, 'error', `Missing version directory: ${versionDir}`);
      continue;
    }

    const manifestPath = path.join(versionDir, 'manifest.v1.json');
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
      addIssue(issues, 'error', `Missing manifest: ${manifestPath}`);
      continue;
    }

    const manifest = validateManifestFile(versionDir, manifestPath, issues, strictMode);
    if (manifest) {
      if (typeof manifest.packId === 'string' && manifest.packId.trim() !== packId) {
        addIssue(issues, 'error', `manifest.packId mismatch for ${packId}@${version} (got ${manifest.packId}).`);
      }
      if (typeof manifest.version === 'string' && manifest.version.trim() !== version) {
        addIssue(issues, 'error', `manifest.version mismatch for ${packId}@${version} (got ${manifest.version}).`);
      }
    }
  }

  // Optional: check that pack.json.latestVersion is the greatest semver present on disk.
  const semverVersions = versionDirs
    .map((v) => ({ raw: v, normalized: normalizeSemver(v) }))
    .filter((entry) => isSemver(entry.normalized));
  if (semverVersions.length > 0 && latestVersion) {
    let max = semverVersions[0].raw;
    for (const entry of semverVersions.slice(1)) {
      const cmp = compareSemver(entry.raw, max);
      if (cmp !== null && cmp > 0) max = entry.raw;
    }
    const cmpLatest = compareSemver(latestVersion, max);
    if (cmpLatest !== null && cmpLatest < 0) {
      addIssue(
        issues,
        strictMode ? 'warn' : 'info',
        `pack.json.latestVersion (${latestVersion}) is behind the greatest version found on disk (${max}).`
      );
    }
  }

  return issues;
}

function loadCatalogPacks(catalogPath, issues) {
  if (!fs.existsSync(catalogPath)) {
    addIssue(issues, 'error', `Catalog not found: ${catalogPath}`);
    return [];
  }

  let catalog;
  try {
    catalog = readJson(catalogPath);
  } catch {
    addIssue(issues, 'error', `Catalog is not valid JSON: ${catalogPath}`);
    return [];
  }

  const packs = Array.isArray(catalog?.packs) ? catalog.packs : [];
  return packs.filter((p) => p && typeof p === 'object' && typeof p.packId === 'string' && p.packId.trim());
}

function scanDiskPackIds() {
  const root = 'packs';
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const dirs = fs.readdirSync(root)
    .filter((name) => fs.existsSync(path.join(root, name)) && fs.statSync(path.join(root, name)).isDirectory());
  const out = [];
  for (const name of dirs) {
    const packJsonPath = path.join(root, name, 'pack.json');
    if (!fs.existsSync(packJsonPath)) continue;
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (readStringFlag(flags, 'help') || readStringFlag(flags, 'h')) {
    printUsageAndExit(0);
  }

  const strict = readBooleanFlag(flags, 'strict') === true;
  const json = readBooleanFlag(flags, 'json') === true;
  const all = readBooleanFlag(flags, 'all') === true;
  const allVersions = readBooleanFlag(flags, 'allVersions') === true;
  const packIdFlag = readStringFlag(flags, 'packId');
  const versionFlag = readStringFlag(flags, 'version');
  const catalogPath = readStringFlag(flags, 'catalog') || path.join('catalog', 'index.v1.json');

  if (!all && !packIdFlag) {
    console.error('Missing required --all=true or --packId=<id>.');
    printUsageAndExit(1);
  }

  const issues = [];
  const catalogPacks = all ? loadCatalogPacks(catalogPath, issues) : [];

  const selectedPackIds = [];
  if (all) {
    for (const pack of catalogPacks) {
      selectedPackIds.push(String(pack.packId).trim());
    }
  } else if (packIdFlag) {
    selectedPackIds.push(packIdFlag.trim());
  }

  // Informational: show delisted packs present on disk.
  if (all) {
    const catalogSet = new Set(selectedPackIds.map((id) => normalizePackId(id)));
    const disk = scanDiskPackIds();
    const orphans = disk.filter((id) => !catalogSet.has(normalizePackId(id)));
    if (orphans.length > 0) {
      addIssue(
        issues,
        'info',
        `Found ${orphans.length} pack(s) on disk not present in catalog (delisted/orphan): ${orphans.join(', ')}`
      );
    }
  }

  for (const packId of selectedPackIds) {
    const packIssues = validatePack(packId, {
      strict,
      allVersions,
      version: versionFlag,
    });

    // Cross-check catalog latestVersion against pack.json latestVersion (when validating via catalog).
    if (all) {
      const catalogEntry = catalogPacks.find((p) => normalizePackId(p.packId) === normalizePackId(packId));
      if (catalogEntry) {
        try {
          const packJson = readJson(path.join('packs', packId, 'pack.json'));
          const packLatest = typeof packJson.latestVersion === 'string' ? packJson.latestVersion.trim() : '';
          const catalogLatest = typeof catalogEntry.latestVersion === 'string' ? String(catalogEntry.latestVersion).trim() : '';
          if (packLatest && catalogLatest && packLatest !== catalogLatest) {
            addIssue(
              packIssues,
              'error',
              `Catalog latestVersion (${catalogLatest}) does not match pack.json latestVersion (${packLatest}) for ${packId}.`
            );
          }
        } catch {
          // pack.json parse errors are reported elsewhere.
        }
      }
    }

    for (const issue of packIssues) {
      addIssue(issues, issue.level, `${packId}: ${issue.message}`);
    }
  }

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warn').length;
  const infos = issues.filter((i) => i.level === 'info').length;

  if (json) {
    console.log(JSON.stringify({ strict, all, packId: packIdFlag, version: versionFlag, errors, warnings, infos, issues }, null, 2));
  } else {
    console.log('Pack validation');
    console.log('');

    if (issues.length === 0) {
      console.log('OK: no issues found.');
    } else {
      const header = [pad('LEVEL', 7), pad('PACK', 28), 'MESSAGE'].join(' | ');
      console.log(header);
      console.log('-'.repeat(header.length));
      for (const issue of issues) {
        const [pack, ...rest] = String(issue.message).split(': ');
        const msg = rest.length > 0 ? rest.join(': ') : issue.message;
        console.log(
          [
            pad(issue.level.toUpperCase(), 7),
            pad(truncate(pack, 28), 28),
            truncate(msg, 160),
          ].join(' | ')
        );
      }
    }

    console.log('');
    console.log(`Summary: ${errors} errors, ${warnings} warnings, ${infos} info`);
  }

  if (errors > 0) process.exit(1);
  if (strict && warnings > 0) process.exit(1);
}

main();
