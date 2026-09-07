/**
 * CJS module that provides mock electron-log exports.
 * Replaces electron-log/main with no-op loggers that support .scope().
 */
'use strict'

const noop = function () {
  /* no-op logger method */
}

/**
 * Bounded ring of warn/error calls, so a test can assert that a diagnostic
 * actually fired. Everything else stays a true no-op.
 *
 * Only warn/error are recorded and the buffer is capped, because every scoped
 * logger in the suite shares it — an uncapped record of info/debug would grow
 * without bound across a full run. Tests must call `__resetRecords()` first;
 * the ring is shared state.
 */
const MAX_RECORDS = 200
const records = []

/**
 * Stringify one logger argument without ever throwing.
 *
 * `String(x)` throws a TypeError for null-prototype objects and for symbols, and
 * a logger call is allowed to pass anything. Before this mock recorded
 * arguments every method was a true no-op, so such a call was harmless — making
 * it throw would turn a diagnostic into a failure in unrelated code.
 */
function safeString(value) {
  try {
    return String(value)
  } catch (err) {
    return '[unstringifiable]'
  }
}

function record(level) {
  return function () {
    let message
    try {
      message = Array.prototype.map.call(arguments, safeString).join(' ')
    } catch (err) {
      message = '[unrecordable]'
    }
    if (records.length >= MAX_RECORDS) records.shift()
    records.push({ level: level, message: message })
  }
}

function createScopedLogger() {
  return {
    info: noop,
    warn: record('warn'),
    error: record('error'),
    debug: noop,
    verbose: noop,
    log: noop,
    silly: noop,
    scope: function () {
      return createScopedLogger()
    }
  }
}

const logger = {
  info: noop,
  warn: record('warn'),
  error: record('error'),
  debug: noop,
  verbose: noop,
  log: noop,
  silly: noop,
  scope: function () {
    return createScopedLogger()
  },
  /** Recorded warn/error calls, newest last. */
  __records: records,
  __resetRecords: function () {
    records.length = 0
  },
  /** Recorded messages at `level` containing `substring`. */
  __findRecords: function (level, substring) {
    return records.filter(function (r) {
      return r.level === level && r.message.indexOf(substring) !== -1
    })
  },
  transports: {
    file: { level: false, maxSize: 0, format: '' },
    console: { level: false, format: '' }
  },
  errorHandler: { startCatching: noop }
}

// Support both default and named exports
logger.default = logger
module.exports = logger
