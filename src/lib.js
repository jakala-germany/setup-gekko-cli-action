'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const CLI_ASSETS = {
  'darwin-arm64': 'gekko-macos-arm64',
  'linux-x64': 'gekko-linux-x64',
};
const SYSTEM_RUNNER_ASSET = 'gekko-system-runner.apk';
const IOS_RUNNER_ASSET = 'gekko-ios-runner.zip';
const IOS_AGENT_ASSET = 'gekko-ios-agent.zip';

/** Prefix of the directory below RUNNER_TEMP that main installs into and post removes. */
const INSTALL_DIR_PREFIX = 'setup-gekko-';

const API_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** The CLI binary of a release for this runner; gekko is only built for macOS arm64 and Linux x64. */
function cliAssetName(platform, arch) {
  const asset = CLI_ASSETS[`${platform}-${arch}`];
  if (!asset) {
    throw new Error(
      `gekko has no CLI for ${platform}/${arch}; supported: ${Object.keys(CLI_ASSETS).join(', ')}`,
    );
  }
  return asset;
}

/** `v0.1.0` and `0.1.0` both mean the release 0.1.0. */
function stripVersionPrefix(version) {
  return version.startsWith('v') ? version.slice(1) : version;
}

/** Accepts a bare hex hash or `sha256:<hex>`; an empty value means "not pinned". */
function normalizeSha256(value, label) {
  const text = (value || '').trim();
  if (text === '') {
    return null;
  }
  const hex = text.replace(/^sha256:/i, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`${label} is not a SHA-256 (64 hex characters): '${text}'`);
  }
  return hex.toLowerCase();
}

/** The hash GitHub reports for a release asset (`sha256:<hex>`), if it reports one. */
function digestOf(asset) {
  if (typeof asset.digest !== 'string') {
    return null;
  }
  const match = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest);
  return match ? match[1].toLowerCase() : null;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

function requestHeaders(token, accept) {
  const headers = {
    Accept: accept,
    'User-Agent': 'setup-gekko-cli-action',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function request(url, token, accept, timeoutMs) {
  try {
    return await fetch(url, {
      headers: requestHeaders(token, accept),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Request to ${url} failed: ${error.cause?.message || error.message}`);
  }
}

function accessHint(status) {
  return status === 401 || status === 403 || status === 404
    ? ' Check that the token can read the repository and that its Actions access setting allows this repository.'
    : '';
}

/** Looks up a release by tag (with or without v) or the latest one. */
async function fetchRelease({ apiUrl, repository, version, token }) {
  const base = `${apiUrl}/repos/${repository}/releases`;
  const wanted = version === '' || version.toLowerCase() === 'latest' ? 'latest' : stripVersionPrefix(version);
  const urls =
    wanted === 'latest'
      ? [`${base}/latest`]
      : [`${base}/tags/${encodeURIComponent(wanted)}`, `${base}/tags/${encodeURIComponent(`v${wanted}`)}`];
  let lastStatus = 404;
  for (const url of urls) {
    const response = await request(url, token, 'application/vnd.github+json', API_TIMEOUT_MS);
    lastStatus = response.status;
    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Reading ${url} failed with HTTP ${response.status}.${accessHint(response.status)}`,
      );
    }
    return response.json();
  }
  throw new Error(`gekko release '${wanted}' was not found in ${repository}.${accessHint(lastStatus)}`);
}

/** The assets of a release by name; every missing name is reported at once. */
function findAssets(release, names) {
  const available = (release.assets || []).map((asset) => asset.name);
  const missing = names.filter((name) => !available.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `Release ${release.tag_name} has no asset ${missing.join(', ')}; it has: ${available.join(', ') || 'none'}`,
    );
  }
  return names.map((name) => release.assets.find((asset) => asset.name === name));
}

/**
 * Downloads one asset through the API, which also works for private repositories. The API answers with a redirect to
 * signed storage; fetch drops the Authorization header when that redirect leaves the API's origin.
 */
async function downloadAsset({ apiUrl, repository, asset, token, destination }) {
  const url = `${apiUrl}/repos/${repository}/releases/assets/${asset.id}`;
  const response = await request(url, token, 'application/octet-stream', DOWNLOAD_TIMEOUT_MS);
  if (!response.ok || !response.body) {
    throw new Error(`Downloading ${asset.name} failed with HTTP ${response.status}.${accessHint(response.status)}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
  return sha256File(destination);
}

/**
 * Compares the downloaded hash with the pinned input, or else with the digest of the release. Throws on a mismatch and
 * when there is nothing to compare with; returns a log line describing what was checked.
 */
function verifyHash({ name, input, actual, pinned, digest }) {
  const expected = pinned || digest;
  if (!expected) {
    throw new Error(
      `The release reports no SHA-256 digest for ${name}, so it cannot be verified; downloaded sha256:${actual}. ` +
        `Pin it with the input ${input} or publish the release with a GitHub release that reports digests.`,
    );
  }
  const source = pinned ? 'pinned input' : 'release digest';
  if (expected !== actual) {
    throw new Error(`SHA-256 mismatch for ${name}: expected ${expected} (${source}), got ${actual}`);
  }
  return `Verified ${name} sha256:${actual} (${source})`;
}

/** `ditto` keeps symlinks and signatures of frameworks on macOS; `unzip` everywhere else. */
function extractZip(zipPath, destination) {
  if (process.platform === 'darwin') {
    execFileSync('ditto', ['-x', '-k', zipPath, destination]);
  } else {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', destination]);
  }
}

module.exports = {
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
  sha256File,
  stripVersionPrefix,
  verifyHash,
};
