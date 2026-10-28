'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cleanup } = require('../src/post');
const { makeStepEnvironment } = require('./helpers');

function installedDirectory(step) {
  const dir = path.join(step.runnerTemp, 'setup-gekko-77');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'gekko'), 'binary');
  fs.writeFileSync(path.join(dir, 'gekko-system-runner.apk'), 'apk');
  return dir;
}

test('post removes the install directory with everything in it', (t) => {
  const step = makeStepEnvironment();
  t.after(step.cleanup);
  const dir = installedDirectory(step);
  cleanup({ env: { ...step.env, STATE_dir: dir }, write: step.write });
  assert.equal(fs.existsSync(dir), false);
  assert.match(step.logs.join(''), new RegExp(`Removed ${dir}`));
});

test('post leaves the rest of RUNNER_TEMP alone', (t) => {
  const step = makeStepEnvironment();
  t.after(step.cleanup);
  const dir = installedDirectory(step);
  const other = path.join(step.runnerTemp, 'something-else.txt');
  fs.writeFileSync(other, 'keep');
  cleanup({ env: { ...step.env, STATE_dir: dir }, write: step.write });
  assert.equal(fs.readFileSync(other, 'utf8'), 'keep');
});

test('post does nothing when main did not run', (t) => {
  const step = makeStepEnvironment();
  t.after(step.cleanup);
  cleanup({ env: step.env, write: step.write });
  assert.match(step.logs.join(''), /Nothing to remove/);
});

test('post is fine with a directory that is already gone', (t) => {
  const step = makeStepEnvironment();
  t.after(step.cleanup);
  const dir = path.join(step.runnerTemp, 'setup-gekko-gone');
  cleanup({ env: { ...step.env, STATE_dir: dir }, write: step.write });
  assert.doesNotMatch(step.logs.join(''), /::warning::/);
});

test('post never removes a directory that main would not have created', (t) => {
  const step = makeStepEnvironment();
  t.after(step.cleanup);
  const foreign = path.join(step.runnerTemp, 'my-data');
  fs.mkdirSync(foreign);
  cleanup({ env: { ...step.env, STATE_dir: foreign }, write: step.write });
  assert.equal(fs.existsSync(foreign), true);
  assert.match(step.logs.join(''), /::warning::Not removing/);
});

test('post cleans up after a main that failed halfway', async (t) => {
  const { run } = require('../src/main');
  const { buildRelease, startFakeGitHub } = require('./helpers');
  const github = await startFakeGitHub({ releases: [buildRelease()] });
  const step = makeStepEnvironment({
    GITHUB_API_URL: github.apiUrl,
    'INPUT_CLI-SHA256': 'a'.repeat(64),
  });
  t.after(async () => {
    await github.close();
    step.cleanup();
  });
  await assert.rejects(run({ env: step.env, write: step.write, platform: 'linux', arch: 'x64' }), /mismatch/);
  const dir = step.entries('GITHUB_STATE').dir;
  assert.ok(fs.existsSync(dir), 'the failed step left its directory behind');
  cleanup({ env: { ...step.env, STATE_dir: dir }, write: step.write });
  assert.equal(fs.existsSync(dir), false);
});
