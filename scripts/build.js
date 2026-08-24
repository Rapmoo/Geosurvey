#!/usr/bin/env node
/* ===================================================================
   scripts/build.js
   -------------------------------------------------------------------
   GeoSurvey has no bundler/transpiler step (Backend is plain CommonJS,
   PWA is native ES modules loaded straight from the browser), so
   "build" here means: prove every file actually parses, prove the
   JSON config the app depends on is well-formed, and assemble a
   deploy-ready artifact under dist/ so the Deploy stage never has to
   re-derive what "the app" consists of.

   Exit code is non-zero on any failure, so this is safe to run as a
   CI gate.
   =================================================================== */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

let failed = false;

function fail(msg) {
  console.error(`✗ ${msg}`);
  failed = true;
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

function walk(dir, exts, ignore = []) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignore.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full, exts, ignore));
    } else if (exts.includes(path.extname(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

// --- 1. Syntax-check every backend source file (CommonJS) ---
console.log('\n--- Syntax check: Backend ---');
const backendFiles = walk(path.join(ROOT, 'Backend'), ['.js'], [
  'node_modules',
]);
for (const file of backendFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fail(`Syntax error in ${path.relative(ROOT, file)}\n${err.stderr}`);
  }
}
if (!failed) ok(`${backendFiles.length} Backend files parsed cleanly`);

// --- 2. Syntax-check PWA ES module sources ---
// `node --check` parses fine even though these files run in the
// browser, not Node — it never executes them, just verifies syntax.
// Module syntax (import/export) requires an .mjs extension or
// type:"module" for --check to treat the file as a module, so each
// file is check via a throwaway .mjs copy rather than in place.
console.log('\n--- Syntax check: PWA ---');
const os = require('os');
const pwaFiles = walk(path.join(ROOT, 'PWA', 'js'), ['.js'], ['node_modules']);
pwaFiles.push(path.join(ROOT, 'PWA', 'sw.js'));
let pwaChecked = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geosurvey-build-'));
for (const file of pwaFiles) {
  if (!fs.existsSync(file)) continue;
  const tmpFile = path.join(tmpDir, `check-${pwaChecked}.mjs`);
  fs.copyFileSync(file, tmpFile);
  try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
    pwaChecked += 1;
  } catch (err) {
    fail(`Syntax error in ${path.relative(ROOT, file)}\n${err.stderr}`);
  }
}
fs.rmSync(tmpDir, { recursive: true, force: true });
if (!failed) ok(`${pwaChecked} PWA files parsed cleanly`);

// --- 3. Validate JSON config the app/deploy depends on ---
console.log('\n--- Validating JSON config ---');
const jsonFiles = [
  'firebase.json',
  'firestore.indexes.json',
  '.firebaserc',
  path.join('PWA', 'manifest.json'),
];
for (const rel of jsonFiles) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  try {
    JSON.parse(fs.readFileSync(full, 'utf8'));
    ok(`${rel} is valid JSON`);
  } catch (err) {
    fail(`${rel} is not valid JSON: ${err.message}`);
  }
}

if (failed) {
  console.error('\nBuild failed — fix the errors above.\n');
  process.exit(1);
}

// --- 4. Assemble the deploy artifact ---
console.log('\n--- Packaging dist/ ---');
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

function copyDir(src, dest, ignore = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (ignore.includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to, ignore);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

// Cloud Function source, mirroring firebase.json's functions.ignore list
copyDir(path.join(ROOT, 'Backend'), path.join(DIST, 'functions'), [
  'node_modules',
  '__tests__',
  'scripts',
  'storage',
  '.env',
  '.env.example',
  '.gitignore',
  'serviceAccountKey.json',
]);

// Static hosting assets
copyDir(path.join(ROOT, 'PWA'), path.join(DIST, 'hosting'));

// Firestore config, needed alongside the functions/hosting deploy.
// firebase.json's rules path is relative to the repo root
// ("Firebase Authentication/firestore.rules"); flatten it to
// "firestore.rules" so the copy sitting next to it in dist/ resolves.
for (const rel of ['firestore.indexes.json', '.firebaserc']) {
  const full = path.join(ROOT, rel);
  if (fs.existsSync(full)) {
    fs.copyFileSync(full, path.join(DIST, rel));
  }
}
const firebaseConfigSrc = path.join(ROOT, 'firebase.json');
if (fs.existsSync(firebaseConfigSrc)) {
  const config = JSON.parse(fs.readFileSync(firebaseConfigSrc, 'utf8'));
  if (config.firestore && config.firestore.rules) {
    config.firestore.rules = 'firestore.rules';
  }
  // dist/Backend was renamed dist/functions above for clarity — point
  // the deploy config at the folder name that actually exists in dist/.
  if (Array.isArray(config.functions)) {
    config.functions = config.functions.map((fn) =>
      fn.source === 'Backend' ? { ...fn, source: 'functions' } : fn
    );
  }
  fs.writeFileSync(
    path.join(DIST, 'firebase.json'),
    JSON.stringify(config, null, 2)
  );
}
const rulesSrc = path.join(ROOT, 'Firebase Authentication', 'firestore.rules');
if (fs.existsSync(rulesSrc)) {
  fs.copyFileSync(rulesSrc, path.join(DIST, 'firestore.rules'));
}

ok(`Build artifact written to ${path.relative(ROOT, DIST)}/`);
console.log('\nBuild succeeded.\n');
