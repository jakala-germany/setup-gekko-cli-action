'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createCore, escapeCommandData, fileCommandEntry } = require('../src/core');
const { makeStepEnvironment } = require('./helpers');

test('getInput reads INPUT_ variables, keeps hyphens and trims', () => {
  const core = createCore({ env: { 'INPUT_CLI-SHA256': '  abc  ', INPUT_VERSION: '0.1.0' } });
  assert.equal(core.getInput('cli-sha256'), 'abc');
  assert.equal(core.getInput('version'), '0.1.0');
  assert.equal(core.getInput('missing'), '');
});

test('getBooleanInput accepts the YAML spellings and rejects anything else', () => {
  const core = createCore({ env: { INPUT_A: 'true', INPUT_B: 'False', INPUT_C: '', INPUT_D: 'yes' } });
  assert.equal(core.getBooleanInput('a'), true);
  assert.equal(core.getBooleanInput('b'), false);
  assert.equal(core.getBooleanInput('c'), false);
  assert.throws(() => core.getBooleanInput('d'), /must be true or false/);
});

test('file commands append name=value and use a heredoc for multi-line values', () => {
  assert.match(fileCommandEntry('A', 'one'), /^A=one\n$/);
  assert.match(fileCommandEntry('B', 'x\ny'), /^B<<ghadelimiter_[0-9a-f-]+\nx\ny\nghadelimiter_[0-9a-f-]+\n$/);
});

test('output, env, path and state go to their files', (t) => {
  const step = makeStepEnvironment();
  t.after(step.cleanup);
  const core = createCore({ env: step.env, write: step.write });
  core.setOutput('version', '0.1.0');
  core.exportVariable('GEKKO_RUNNER_APK', '/tmp/a.apk');
  core.addPath('/tmp/bin');
  core.saveState('dir', '/tmp/setup-gekko-1');
  assert.deepEqual(step.entries('GITHUB_OUTPUT'), { version: '0.1.0' });
  assert.deepEqual(step.entries('GITHUB_ENV'), { GEKKO_RUNNER_APK: '/tmp/a.apk' });
  assert.equal(step.read('GITHUB_PATH'), '/tmp/bin\n');
  assert.deepEqual(step.entries('GITHUB_STATE'), { dir: '/tmp/setup-gekko-1' });
});

test('state saved by main is read back from STATE_ variables', () => {
  const core = createCore({ env: { STATE_dir: '/tmp/setup-gekko-1' } });
  assert.equal(core.getState('dir'), '/tmp/setup-gekko-1');
  assert.equal(core.getState('other'), '');
});

test('a missing file command variable warns instead of throwing', () => {
  const logs = [];
  const core = createCore({ env: {}, write: (text) => logs.push(text) });
  core.addPath('/tmp/bin');
  assert.match(logs.join(''), /::warning::GITHUB_PATH is not set/);
});

test('error and warning use workflow commands with escaped data', () => {
  const logs = [];
  const core = createCore({ env: {}, write: (text) => logs.push(text) });
  core.error('bad 100%\nnext');
  core.warning('careful');
  assert.equal(escapeCommandData('a%b\r\nc'), 'a%25b%0D%0Ac');
  assert.deepEqual(logs, ['::error::bad 100%25%0Anext\n', '::warning::careful\n']);
});

test('the files really are appended to, not replaced', (t) => {
  const step = makeStepEnvironment();
  t.after(step.cleanup);
  fs.writeFileSync(step.env.GITHUB_PATH, '/existing\n');
  createCore({ env: step.env, write: step.write }).addPath('/new');
  assert.equal(step.read('GITHUB_PATH'), '/existing\n/new\n');
});
