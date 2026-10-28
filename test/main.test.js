'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../src/main');
const { buildRelease, defaultFiles, makeStepEnvironment, sha256, startFakeGitHub } = require('./helpers');

/** Starts the fake API and a step environment; [inputs] are given without the INPUT_ prefix. */
async function setup(t, { releases = [buildRelease()], inputs = {}, ...options } = {}) {
  const github = await startFakeGitHub({ releases, ...options });
  const step = makeStepEnvironment({
    GITHUB_API_URL: github.apiUrl,
    ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value])),
  });
  t.after(async () => {
    await github.close();
    step.cleanup();
  });
  return { github, step };
}

const linux = { platform: 'linux', arch: 'x64' };
const mac = { platform: 'darwin', arch: 'arm64' };

function installDir(step) {
  return path.join(step.runnerTemp, 'setup-gekko-4242');
}

function assertNothingExported(step) {
  assert.equal(step.read('GITHUB_PATH'), '');
  assert.equal(step.read('GITHUB_ENV'), '');
  assert.equal(step.read('GITHUB_OUTPUT'), '');
  assert.equal(fs.existsSync(path.join(installDir(step), 'bin')), false);
}

test('latest installs the CLI and the runner APK and exports them', async (t) => {
  const { github, step } = await setup(t, { inputs: { token: 'secret-token' } });
  await run({ env: step.env, write: step.write, ...linux });

  const dir = installDir(step);
  const cli = path.join(dir, 'bin', 'gekko');
  assert.equal(fs.readFileSync(cli, 'utf8'), '#!/bin/sh\necho gekko linux\n');
  assert.ok(fs.statSync(cli).mode & 0o100, 'the binary is executable');
  assert.equal(fs.readFileSync(path.join(dir, 'gekko-system-runner.apk'), 'utf8'), 'apk bytes');
  assert.equal(fs.existsSync(path.join(dir, 'download')), false, 'the staging directory is removed');

  assert.equal(step.read('GITHUB_PATH'), `${path.join(dir, 'bin')}\n`);
  assert.deepEqual(step.entries('GITHUB_ENV'), { GEKKO_RUNNER_APK: path.join(dir, 'gekko-system-runner.apk') });
  assert.deepEqual(step.entries('GITHUB_OUTPUT'), { version: '0.1.0', path: cli });
  assert.deepEqual(step.entries('GITHUB_STATE'), { dir });

  assert.equal(github.requests[0].url, '/repos/jakala-germany/gekko/releases/latest');
  assert.ok(github.requests.every((request) => request.headers.authorization === 'Bearer secret-token'));
  const downloads = github.requests.filter((request) => request.url.includes('/releases/assets/'));
  assert.equal(downloads.length, 2);
  assert.ok(downloads.every((request) => request.headers.accept === 'application/octet-stream'));
});

test('macOS arm64 gets the macOS binary', async (t) => {
  const { step } = await setup(t);
  await run({ env: step.env, write: step.write, ...mac });
  assert.equal(fs.readFileSync(path.join(installDir(step), 'bin', 'gekko'), 'utf8'), '#!/bin/sh\necho gekko macos\n');
});

test('a pinned version is looked up by tag, with or without a leading v', async (t) => {
  for (const version of ['0.1.0', 'v0.1.0']) {
    const { github, step } = await setup(t, {
      releases: [buildRelease({ tag: '0.2.0' }), buildRelease({ tag: '0.1.0' })],
      inputs: { version },
    });
    await run({ env: step.env, write: step.write, ...linux });
    assert.equal(github.requests[0].url, '/repos/jakala-germany/gekko/releases/tags/0.1.0');
    assert.deepEqual(step.entries('GITHUB_OUTPUT').version, '0.1.0');
  }
});

test('a release tagged with a v is found through the fallback and reported without it', async (t) => {
  const { github, step } = await setup(t, {
    releases: [buildRelease({ tag: 'v0.3.0' })],
    inputs: { version: '0.3.0' },
  });
  await run({ env: step.env, write: step.write, ...linux });
  assert.deepEqual(
    github.requests.slice(0, 2).map((request) => request.url),
    ['/repos/jakala-germany/gekko/releases/tags/0.3.0', '/repos/jakala-germany/gekko/releases/tags/v0.3.0'],
  );
  assert.equal(step.entries('GITHUB_OUTPUT').version, '0.3.0');
});

test('an unknown version fails with a hint about the token', async (t) => {
  const { step } = await setup(t, { inputs: { version: '9.9.9' } });
  await assert.rejects(
    run({ env: step.env, write: step.write, ...linux }),
    /release '9\.9\.9' was not found in jakala-germany\/gekko.*token/s,
  );
  assertNothingExported(step);
});

test('a private repository is a 404 without the right token', async (t) => {
  const { step } = await setup(t, { requiredToken: 'right-token', inputs: { token: 'wrong' } });
  await assert.rejects(run({ env: step.env, write: step.write, ...linux }), /was not found/);
});

test('the repository input selects another repository', async (t) => {
  const { github, step } = await setup(t, { inputs: { repository: 'acme/gekko-fork' } });
  await run({ env: step.env, write: step.write, ...linux });
  assert.equal(github.requests[0].url, '/repos/acme/gekko-fork/releases/latest');
});

test('a malformed repository is rejected', async (t) => {
  const { step } = await setup(t, { inputs: { repository: 'not a repo' } });
  await assert.rejects(run({ env: step.env, write: step.write, ...linux }), /must look like owner\/name/);
});

test('a pinned hash that matches is verified (bare, sha256: prefix, uppercase)', async (t) => {
  const files = defaultFiles();
  const cliHash = sha256(files['gekko-linux-x64']);
  const apkHash = sha256(files['gekko-system-runner.apk']);
  const { step } = await setup(t, {
    releases: [buildRelease({ files, digests: false })],
    inputs: { 'cli-sha256': cliHash, 'system-runner-sha256': `sha256:${apkHash.toUpperCase()}` },
  });
  await run({ env: step.env, write: step.write, ...linux });
  const log = step.logs.join('');
  assert.match(log, new RegExp(`Verified gekko-linux-x64 sha256:${cliHash} \\(pinned input\\)`));
  assert.match(log, new RegExp(`Verified gekko-system-runner.apk sha256:${apkHash} \\(pinned input\\)`));
  assert.doesNotMatch(log, /::warning::/);
});

test('a pinned hash that does not match fails before anything is installed or exported', async (t) => {
  const { step } = await setup(t, { inputs: { 'cli-sha256': 'a'.repeat(64) } });
  await assert.rejects(
    run({ env: step.env, write: step.write, ...linux }),
    new RegExp(`SHA-256 mismatch for gekko-linux-x64: expected ${'a'.repeat(64)} \\(pinned input\\), got [0-9a-f]{64}`),
  );
  assertNothingExported(step);
});

test('a wrong runner APK hash also stops the install', async (t) => {
  const { step } = await setup(t, { inputs: { 'system-runner-sha256': 'b'.repeat(64) } });
  await assert.rejects(run({ env: step.env, write: step.write, ...linux }), /mismatch for gekko-system-runner\.apk/);
  assertNothingExported(step);
});

test('the pinned hash wins over the digest of the release', async (t) => {
  const files = defaultFiles();
  const release = buildRelease({ files });
  release.json.assets.find((asset) => asset.name === 'gekko-linux-x64').digest = `sha256:${'c'.repeat(64)}`;
  const { step } = await setup(t, { releases: [release], inputs: { 'cli-sha256': sha256(files['gekko-linux-x64']) } });
  await run({ env: step.env, write: step.write, ...linux });
  assert.match(step.logs.join(''), /Verified gekko-linux-x64 .*\(pinned input\)/);
});

test('without a pinned hash the digest of the release is checked', async (t) => {
  const { step } = await setup(t);
  await run({ env: step.env, write: step.write, ...linux });
  assert.match(step.logs.join(''), /Verified gekko-linux-x64 sha256:[0-9a-f]{64} \(release digest\)/);
});

test('a digest of the release that does not match fails', async (t) => {
  const release = buildRelease();
  release.json.assets.find((asset) => asset.name === 'gekko-linux-x64').digest = `sha256:${'d'.repeat(64)}`;
  const { step } = await setup(t, { releases: [release] });
  await assert.rejects(
    run({ env: step.env, write: step.write, ...linux }),
    /mismatch for gekko-linux-x64: expected d{64} \(release digest\)/,
  );
  assertNothingExported(step);
});

test('without a pinned hash and without a digest it fails and names the input to pin', async (t) => {
  const files = defaultFiles();
  const { step } = await setup(t, { releases: [buildRelease({ files, digests: false })] });
  await assert.rejects(
    run({ env: step.env, write: step.write, ...linux }),
    new RegExp(
      `no SHA-256 digest for gekko-linux-x64.*sha256:${sha256(files['gekko-linux-x64'])}.*input cli-sha256`,
    ),
  );
  assertNothingExported(step);
});

test('the runner APK without a digest names its own input', async (t) => {
  const files = defaultFiles();
  const cliHash = sha256(files['gekko-linux-x64']);
  const { step } = await setup(t, {
    releases: [buildRelease({ files, digests: false })],
    inputs: { 'cli-sha256': cliHash },
  });
  await assert.rejects(
    run({ env: step.env, write: step.write, ...linux }),
    /no SHA-256 digest for gekko-system-runner\.apk.*input system-runner-sha256/,
  );
  assertNothingExported(step);
});

test('a malformed pinned hash fails before any request is made', async (t) => {
  const { github, step } = await setup(t, { inputs: { 'cli-sha256': 'not-a-hash' } });
  await assert.rejects(run({ env: step.env, write: step.write, ...linux }), /cli-sha256 is not a SHA-256/);
  assert.equal(github.requests.length, 0);
});

test('a release without the runner APK lists what it has', async (t) => {
  const files = defaultFiles();
  delete files['gekko-system-runner.apk'];
  const { step } = await setup(t, { releases: [buildRelease({ files })] });
  await assert.rejects(
    run({ env: step.env, write: step.write, ...linux }),
    /Release 0\.1\.0 has no asset gekko-system-runner\.apk; it has: gekko-macos-arm64, gekko-linux-x64/,
  );
  assertNothingExported(step);
});

test('an unsupported platform or architecture fails before any request is made', async (t) => {
  for (const target of [
    { platform: 'win32', arch: 'x64' },
    { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'arm64' },
  ]) {
    const { github, step } = await setup(t);
    await assert.rejects(
      run({ env: step.env, write: step.write, ...target }),
      new RegExp(`no CLI for ${target.platform}/${target.arch}`),
    );
    assert.equal(github.requests.length, 0);
  }
});

test('ios needs a macOS runner', async (t) => {
  const { github, step } = await setup(t, { inputs: { ios: 'true' } });
  await assert.rejects(run({ env: step.env, write: step.write, ...linux }), /'ios' needs a macOS runner/);
  assert.equal(github.requests.length, 0);
});

test('ios false downloads no iOS assets', async (t) => {
  const { github, step } = await setup(t, { inputs: { ios: 'false' } });
  await run({ env: step.env, write: step.write, ...mac });
  assert.equal(github.requests.filter((request) => request.url.includes('/releases/assets/')).length, 2);
  assert.deepEqual(Object.keys(step.entries('GITHUB_ENV')), ['GEKKO_RUNNER_APK']);
});

test('ios true unpacks the iOS runner and agent and exports their paths', async (t) => {
  const files = defaultFiles();
  const { github, step } = await setup(t, {
    releases: [buildRelease({ files })],
    inputs: {
      ios: 'true',
      'ios-runner-sha256': sha256(files['gekko-ios-runner.zip']),
      'ios-agent-sha256': sha256(files['gekko-ios-agent.zip']),
    },
  });
  await run({ env: step.env, write: step.write, ...mac });

  const dir = installDir(step);
  assert.equal(github.requests.filter((request) => request.url.includes('/releases/assets/')).length, 4);
  assert.deepEqual(step.entries('GITHUB_ENV'), {
    GEKKO_RUNNER_APK: path.join(dir, 'gekko-system-runner.apk'),
    GEKKO_IOS_RUNNER_DIR: path.join(dir, 'gekko-ios-runner'),
    GEKKO_IOS_AGENT: path.join(dir, 'gekko-ios-agent', 'GekkoAgent.framework'),
  });
  assert.equal(fs.readFileSync(path.join(dir, 'gekko-ios-runner', 'GekkoRunner.xctestrun'), 'utf8'), '<plist/>');
  assert.equal(fs.readFileSync(path.join(dir, 'gekko-ios-agent', 'GekkoAgent.framework', 'GekkoAgent'), 'utf8'), 'agent');
  assert.match(step.logs.join(''), /Verified gekko-ios-runner\.zip .*\(pinned input\)/);
});

test('a wrong iOS runner hash stops the install', async (t) => {
  const { step } = await setup(t, { inputs: { ios: 'true', 'ios-runner-sha256': 'e'.repeat(64) } });
  await assert.rejects(run({ env: step.env, write: step.write, ...mac }), /mismatch for gekko-ios-runner\.zip/);
  assertNothingExported(step);
});

test('an iOS zip with the wrong layout is reported', async (t) => {
  const files = defaultFiles();
  files['gekko-ios-agent.zip'] = require('./helpers').makeZip({ 'somewhere/else.txt': 'x' });
  const { step } = await setup(t, { releases: [buildRelease({ files })], inputs: { ios: 'true' } });
  await assert.rejects(run({ env: step.env, write: step.write, ...mac }), /iOS agent framework is missing after unpacking/);
});

test('the Authorization header is not sent to the storage the API redirects to', async (t) => {
  const { github, step } = await setup(t, { redirect: true, inputs: { token: 'secret-token' } });
  await run({ env: step.env, write: step.write, ...linux });
  assert.equal(github.blobRequests.length, 2);
  assert.ok(github.blobRequests.every((request) => request.headers.authorization === undefined));
  assert.equal(fs.readFileSync(path.join(installDir(step), 'gekko-system-runner.apk'), 'utf8'), 'apk bytes');
});

test('without a token no Authorization header is sent', async (t) => {
  const { github, step } = await setup(t);
  await run({ env: step.env, write: step.write, ...linux });
  assert.ok(github.requests.every((request) => request.headers.authorization === undefined));
});

test('an earlier install in the same run is replaced, not mixed in', async (t) => {
  const { step } = await setup(t);
  const leftover = path.join(installDir(step), 'leftover.txt');
  fs.mkdirSync(installDir(step), { recursive: true });
  fs.writeFileSync(leftover, 'old');
  await run({ env: step.env, write: step.write, ...linux });
  assert.equal(fs.existsSync(leftover), false);
});

test('the entry point installs, and post removes it again', async (t) => {
  const target = { platform: process.platform, arch: process.arch };
  if (!(target.platform === 'linux' && target.arch === 'x64') && !(target.platform === 'darwin' && target.arch === 'arm64')) {
    t.skip(`no gekko CLI for ${target.platform}/${target.arch}`);
    return;
  }
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const { step } = await setup(t, { inputs: { token: 'secret-token' } });
  const root = path.resolve(__dirname, '..');
  const spawnEnv = { PATH: process.env.PATH, ...step.env };

  const main = await promisify(execFile)(process.execPath, [path.join(root, 'src', 'main.js')], { env: spawnEnv });
  assert.match(main.stdout, /is installed at/);
  const dir = step.entries('GITHUB_STATE').dir;
  assert.equal(path.basename(dir), 'setup-gekko-4242');
  assert.ok(fs.existsSync(path.join(dir, 'bin', 'gekko')));

  const post = await promisify(execFile)(process.execPath, [path.join(root, 'src', 'post.js')], {
    env: { ...spawnEnv, STATE_dir: dir },
  });
  assert.match(post.stdout, /Removed/);
  assert.equal(fs.existsSync(dir), false);
});

test('the entry point reports a failure as an error annotation and a non-zero exit', async (t) => {
  const { execFile } = require('node:child_process');
  const { step } = await setup(t, { inputs: { version: '9.9.9' } });
  const root = path.resolve(__dirname, '..');
  const result = await new Promise((resolve) =>
    execFile(process.execPath, [path.join(root, 'src', 'main.js')], { env: { PATH: process.env.PATH, ...step.env } }, (error, stdout) =>
      resolve({ code: error?.code, stdout }),
    ),
  );
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^::error::gekko release '9\.9\.9' was not found/m);
});
