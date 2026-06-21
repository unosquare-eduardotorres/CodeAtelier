/**
 * CJS module that provides mock electron-log exports.
 * Replaces electron-log/main with no-op loggers that support .scope().
 */
'use strict'

const noop = function() {}

function createScopedLogger() {
  return {
    info: noop, warn: noop, error: noop, debug: noop,
    verbose: noop, log: noop, silly: noop,
    scope: function() { return createScopedLogger() },
  }
}

const logger = {
  info: noop, warn: noop, error: noop, debug: noop,
  verbose: noop, log: noop, silly: noop,
  scope: function(_name) { return createScopedLogger() },
  transports: {
    file: { level: false, maxSize: 0, format: '' },
    console: { level: false, format: '' },
  },
  errorHandler: { startCatching: noop },
}

// Support both default and named exports
logger.default = logger
module.exports = logger
