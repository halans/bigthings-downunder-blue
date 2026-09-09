'use strict';
/**
 * Zero-dependency test runner. `node test/run.js` runs every *.test.js in this
 * directory and exits non-zero on the first failing assertion.
 */

const fs = require('fs');
const path = require('path');

const state = { pass: 0, fail: 0, failures: [], suite: '' };

function test(name, fn) {
  try {
    fn();
    state.pass++;
    process.stdout.write('.');
  } catch (e) {
    state.fail++;
    state.failures.push({ suite: state.suite, name, message: e.message, stack: e.stack });
    process.stdout.write('F');
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'not equal'}\n    expected: ${b}\n    actual:   ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }
function close(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${msg || 'not close'}: ${actual} vs ${expected} (±${tol})`);
}

module.exports = { test, eq, ok, close };

if (require.main === module) {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
  const t0 = Date.now();
  for (const f of files) {
    state.suite = f;
    process.stdout.write(`\n${f.replace('.test.js', '').padEnd(16)} `);
    try {
      require(path.join(dir, f));
    } catch (e) {
      // A suite that cannot even load is one failure, not a stack trace dump.
      state.fail++;
      state.failures.push({ suite: f, name: 'suite failed to load', message: e.message, stack: e.stack });
      process.stdout.write('F');
    }
  }
  const ms = Date.now() - t0;
  process.stdout.write(`\n\n${state.pass} passed, ${state.fail} failed  (${ms} ms)\n`);
  if (state.fail) {
    for (const f of state.failures) process.stdout.write(`\nFAIL  ${f.suite} › ${f.name}\n      ${f.message.split('\n').join('\n      ')}\n`);
    process.exit(1);
  }
}
