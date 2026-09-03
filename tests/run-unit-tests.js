#!/usr/bin/env node
/**
 * Test runner for GMS unit tests.
 * Uses Node's built-in `node:test` runner — no external dependencies.
 *
 * Usage:
 *   npm test                 — run all unit tests
 *   node --test tests/unit/  — run all unit tests directly
 *   node --test tests/unit/mappings.test.js  — run a specific test file
 */
const { run } = require('node:test');
const { spec } = require('node:test/reporters');
const path = require('path');
const fs = require('fs');

const testDir = path.join(__dirname, 'unit');
const files = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .map(f => path.join(testDir, f));

if (files.length === 0) {
  console.error('No test files found in tests/unit/');
  process.exit(1);
}

console.log(`Running ${files.length} test file(s):`);
files.forEach(f => console.log(`  - ${path.basename(f)}`));
console.log('');

run({ files })
  .compose(spec)
  .pipe(process.stdout)
  .on('error', (err) => {
    console.error('Test runner error:', err);
    process.exit(1);
  });
