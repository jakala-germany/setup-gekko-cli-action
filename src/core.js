'use strict';

const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

/** Escapes a message for a workflow command (`::error::...`). */
function escapeCommandData(message) {
  return String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Formats `name=value` for a file command; values with line breaks use the heredoc form. */
function fileCommandEntry(name, value) {
  const text = String(value);
  if (!text.includes('\n') && !text.includes('\r')) {
    return `${name}=${text}${os.EOL}`;
  }
  const delimiter = `ghadelimiter_${crypto.randomUUID()}`;
  return `${name}<<${delimiter}${os.EOL}${text}${os.EOL}${delimiter}${os.EOL}`;
}

/**
 * The few runner interactions the action needs: inputs, outputs, state, PATH/env exports and log commands. [env] and
 * [write] are injectable so the logic can be tested without touching the real process.
 */
function createCore({ env = process.env, write = (text) => process.stdout.write(text) } = {}) {
  function appendToFile(variable, text) {
    const file = env[variable];
    if (!file) {
      write(`::warning::${variable} is not set, skipped: ${escapeCommandData(text.trim())}${os.EOL}`);
      return;
    }
    fs.appendFileSync(file, text);
  }

  return {
    getInput(name) {
      return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || '').trim();
    },

    getBooleanInput(name) {
      const value = this.getInput(name);
      if (value === '') {
        return false;
      }
      if (['true', 'True', 'TRUE'].includes(value)) {
        return true;
      }
      if (['false', 'False', 'FALSE'].includes(value)) {
        return false;
      }
      throw new Error(`Input '${name}' must be true or false, was '${value}'`);
    },

    getState(name) {
      return env[`STATE_${name}`] || '';
    },

    saveState(name, value) {
      appendToFile('GITHUB_STATE', fileCommandEntry(name, value));
    },

    setOutput(name, value) {
      appendToFile('GITHUB_OUTPUT', fileCommandEntry(name, value));
    },

    exportVariable(name, value) {
      appendToFile('GITHUB_ENV', fileCommandEntry(name, value));
    },

    addPath(directory) {
      appendToFile('GITHUB_PATH', `${directory}${os.EOL}`);
    },

    info(message) {
      write(`${message}${os.EOL}`);
    },

    warning(message) {
      write(`::warning::${escapeCommandData(message)}${os.EOL}`);
    },

    error(message) {
      write(`::error::${escapeCommandData(message)}${os.EOL}`);
    },
  };
}

module.exports = { createCore, escapeCommandData, fileCommandEntry };
