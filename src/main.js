'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCore, escapeCommandData } = require('./core');
const {
  INSTALL_DIR_PREFIX,
  IOS_AGENT_ASSET,
  IOS_RUNNER_ASSET,
  SYSTEM_RUNNER_ASSET,
  cliAssetName,
  digestOf,
  downloadAsset,
  extractZip,
  fetchRelease,
  findAssets,
  normalizeSha256,
  stripVersionPrefix,
  verifyHash,
} = require('./lib');

const DEFAULT_REPOSITORY = 'jakala-germany/gekko';
function requireExists(target, what) {
  if (!fs.existsSync(target)) {
    throw new Error(`${what} is missing after unpacking: ${target}`);
  }
}

/**
 * Installs gekko into a fresh directory below RUNNER_TEMP: every asset is downloaded and verified first, only then
 * is anything put in place or exported, so a hash mismatch leaves PATH and the environment untouched.
 */
async function run({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  write,
} = {}) {
  const core = createCore({ env, write });

  const repository = core.getInput('repository') || DEFAULT_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error(`Input 'repository' must look like owner/name, was '${repository}'`);
  }
  const requestedVersion = core.getInput('version') || 'latest';
  const token = core.getInput('token');
  const ios = core.getBooleanInput('ios');
  if (ios && platform !== 'darwin') {
    throw new Error(`Input 'ios' needs a macOS runner, this one is ${platform}`);
  }
  const apiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

  const cliName = cliAssetName(platform, arch);
  const wanted = [
    {
      key: 'cli',
      name: cliName,
      input: 'cli-sha256',
      pinned: normalizeSha256(core.getInput('cli-sha256'), 'cli-sha256'),
    },
    {
      key: 'systemRunner',
      name: SYSTEM_RUNNER_ASSET,
      input: 'system-runner-sha256',
      pinned: normalizeSha256(core.getInput('system-runner-sha256'), 'system-runner-sha256'),
    },
  ];
  if (ios) {
    wanted.push(
      {
        key: 'iosRunner',
        name: IOS_RUNNER_ASSET,
        input: 'ios-runner-sha256',
        pinned: normalizeSha256(core.getInput('ios-runner-sha256'), 'ios-runner-sha256'),
      },
      {
        key: 'iosAgent',
        name: IOS_AGENT_ASSET,
        input: 'ios-agent-sha256',
        pinned: normalizeSha256(core.getInput('ios-agent-sha256'), 'ios-agent-sha256'),
      },
    );
  }

  const release = await fetchRelease({ apiUrl, repository, version: requestedVersion, token });
  const version = stripVersionPrefix(release.tag_name);
  const assets = findAssets(
    release,
    wanted.map((item) => item.name),
  );
  core.info(`Installing gekko ${version} from ${repository}`);

  const installDir = path.join(
    env.RUNNER_TEMP || os.tmpdir(),
    `${INSTALL_DIR_PREFIX}${env.GITHUB_RUN_ID || process.pid}`,
  );
  fs.rmSync(installDir, { recursive: true, force: true });
  const staging = path.join(installDir, 'download');
  fs.mkdirSync(staging, { recursive: true });
  // Saved before anything is downloaded, so the post step removes the directory even when this step fails
  core.saveState('dir', installDir);

  const staged = {};
  for (const [index, item] of wanted.entries()) {
    const asset = assets[index];
    const destination = path.join(staging, item.name);
    const actual = await downloadAsset({ apiUrl, repository, asset, token, destination });
    core.info(
      verifyHash({ name: item.name, input: item.input, actual, pinned: item.pinned, digest: digestOf(asset) }),
    );
    staged[item.key] = destination;
  }

  const binDir = path.join(installDir, 'bin');
  fs.mkdirSync(binDir);
  const cliPath = path.join(binDir, 'gekko');
  fs.renameSync(staged.cli, cliPath);
  fs.chmodSync(cliPath, 0o755);
  const runnerApk = path.join(installDir, SYSTEM_RUNNER_ASSET);
  fs.renameSync(staged.systemRunner, runnerApk);

  const exports = { GEKKO_RUNNER_APK: runnerApk };
  if (ios) {
    extractZip(staged.iosRunner, installDir);
    extractZip(staged.iosAgent, installDir);
    exports.GEKKO_IOS_RUNNER_DIR = path.join(installDir, 'gekko-ios-runner');
    exports.GEKKO_IOS_AGENT = path.join(installDir, 'gekko-ios-agent', 'GekkoAgent.framework');
    requireExists(exports.GEKKO_IOS_RUNNER_DIR, 'The iOS system runner');
    requireExists(exports.GEKKO_IOS_AGENT, 'The iOS agent framework');
  }
  fs.rmSync(staging, { recursive: true, force: true });

  core.addPath(binDir);
  for (const [name, value] of Object.entries(exports)) {
    core.exportVariable(name, value);
  }
  core.setOutput('version', version);
  core.setOutput('path', cliPath);
  core.info(`gekko ${version} is installed at ${cliPath}; it is removed again when the job ends`);
}

if (require.main === module) {
  run().catch((error) => {
    process.stdout.write(`::error::${escapeCommandData(error.message)}${os.EOL}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
