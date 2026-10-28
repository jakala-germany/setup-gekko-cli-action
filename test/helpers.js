'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip with stored (uncompressed) entries: enough for unzip/ditto and free of dependencies. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** The files of a gekko release; the CLI is built per platform, so both names are present. */
function defaultFiles() {
  return {
    'gekko-macos-arm64': Buffer.from('#!/bin/sh\necho gekko macos\n'),
    'gekko-linux-x64': Buffer.from('#!/bin/sh\necho gekko linux\n'),
    'gekko-system-runner.apk': Buffer.from('apk bytes'),
    'gekko-ios-runner.zip': makeZip({ 'gekko-ios-runner/GekkoRunner.xctestrun': '<plist/>' }),
    'gekko-ios-agent.zip': makeZip({ 'gekko-ios-agent/GekkoAgent.framework/GekkoAgent': 'agent' }),
  };
}

let nextAssetId = 1000;

/** A release as the API returns it, plus the bytes behind its assets. */
function buildRelease({ tag = '0.1.0', files = defaultFiles(), digests = true } = {}) {
  const blobs = new Map();
  const assets = Object.entries(files).map(([name, content]) => {
    const id = nextAssetId++;
    blobs.set(id, content);
    const asset = { id, name, size: content.length };
    if (digests) {
      asset.digest = `sha256:${sha256(content)}`;
    }
    return asset;
  });
  return { json: { tag_name: tag, assets }, blobs, files };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/**
 * A GitHub API that serves [releases] (latest = the first one). With [requiredToken] anything else is a 404, like a
 * private repository; with [redirect] assets are served from a second origin after a 302.
 */
async function startFakeGitHub({ releases, requiredToken = null, redirect = false }) {
  const requests = [];
  const blobRequests = [];
  const blobs = new Map();
  releases.forEach((release) => release.blobs.forEach((blob, id) => blobs.set(id, blob)));

  const blobServer = http.createServer((request, response) => {
    blobRequests.push({ url: request.url, headers: request.headers });
    const blob = blobs.get(Number(request.url.split('/').pop()));
    response.writeHead(blob ? 200 : 404, { 'Content-Type': 'application/octet-stream' });
    response.end(blob);
  });
  const blobPort = await listen(blobServer);

  const apiServer = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (requiredToken && request.headers.authorization !== `Bearer ${requiredToken}`) {
      json(404, { message: 'Not Found' });
      return;
    }
    const latest = /^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.exec(request.url);
    const tag = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.exec(request.url);
    const asset = /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(request.url);
    if (latest) {
      json(200, releases[0].json);
    } else if (tag) {
      const found = releases.find((release) => release.json.tag_name === decodeURIComponent(tag[1]));
      found ? json(200, found.json) : json(404, { message: 'Not Found' });
    } else if (asset) {
      const blob = blobs.get(Number(asset[1]));
      if (!blob) {
        json(404, { message: 'Not Found' });
      } else if (redirect) {
        response.writeHead(302, { Location: `http://127.0.0.1:${blobPort}/blob/${asset[1]}` });
        response.end();
      } else {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        response.end(blob);
      }
    } else {
      json(404, { message: 'Not Found' });
    }
  });
  const apiPort = await listen(apiServer);

  return {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    requests,
    blobRequests,
    close: async () => {
      apiServer.closeAllConnections();
      blobServer.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => apiServer.close(resolve)),
        new Promise((resolve) => blobServer.close(resolve)),
      ]);
    },
  };
}

/** A scratch workspace with the GITHUB_* files of a step and an env object for [run]. */
function makeStepEnvironment(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-gekko-test-'));
  const files = {
    GITHUB_PATH: path.join(root, 'path'),
    GITHUB_ENV: path.join(root, 'env'),
    GITHUB_OUTPUT: path.join(root, 'output'),
    GITHUB_STATE: path.join(root, 'state'),
  };
  Object.values(files).forEach((file) => fs.writeFileSync(file, ''));
  const runnerTemp = path.join(root, 'temp');
  fs.mkdirSync(runnerTemp);
  const logs = [];
  return {
    root,
    runnerTemp,
    logs,
    write: (text) => logs.push(text),
    env: { ...files, RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: '4242', ...extra },
    read: (name) => fs.readFileSync(files[name], 'utf8'),
    /** `name=value` lines of a file command as an object. */
    entries: (name) =>
      Object.fromEntries(
        fs
          .readFileSync(files[name], 'utf8')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      ),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

module.exports = { buildRelease, defaultFiles, makeStepEnvironment, makeZip, sha256, startFakeGitHub };
