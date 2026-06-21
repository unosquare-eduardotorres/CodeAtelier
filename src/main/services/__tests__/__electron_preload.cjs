/**
 * Preload script for coverage runs.
 * Loaded via --require BEFORE tsx processes any file.
 * Redirects require('electron') and require('electron-log/main') to mock files.
 * 
 * This must be CJS because --require runs before ESM loaders.
 */
'use strict'

const Module = require('node:module')
const path = require('node:path')

const electronMockPath = path.resolve(__dirname, '__electron_mock.cjs')
const electronLogMockPath = path.resolve(__dirname, '__electron_log_mock.cjs')

const origResolve = Module._resolveFilename
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request === 'electron') {
    return electronMockPath
  }
  if (request === 'electron-log/main' || request === 'electron-log') {
    return electronLogMockPath
  }
  return origResolve.call(this, request, parent, isMain, options)
}
