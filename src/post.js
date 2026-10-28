'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCore } = require('./core');
const { INSTALL_DIR_PREFIX } = require('./lib');

/** Removes what main installed. Never fails the job: a leftover directory is only a warning. */
function cleanup({ env = process.env, write } = {}) {
  const core = createCore({ env, write });
  const dir = core.getState('dir');
  if (!dir) {
    core.info('Nothing to remove, gekko was not installed by this action');
    return;
  }
  // The state comes from the runner, but a directory that was not created by main is never deleted
  if (!path.basename(dir).startsWith(INSTALL_DIR_PREFIX)) {
    core.warning(`Not removing ${dir}: it is not a ${INSTALL_DIR_PREFIX}* directory`);
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    core.info(`Removed ${dir}`);
  } catch (error) {
    core.warning(`Could not remove ${dir}: ${error.message}`);
  }
}

if (require.main === module) {
  cleanup();
}

module.exports = { cleanup };
