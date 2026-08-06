/**
 * SEC-04: Shared utility for encrypting/decrypting API key settings fields.
 *
 * Uses Electron's safeStorage (OS keychain-backed) to encrypt API keys
 * before they are written to the SQLite settings_json column. Decryption
 * restores the original plaintext when the key is read back.
 *
 * Each key gets a companion `${key}Encrypted` boolean flag so the reader
 * can distinguish legacy plaintext values from encrypted ones.
 */
// Lazy Electron import — this module gets bundled into a shared chunk that
// MCP server child processes load transitively. `safeStorage` is only called
// from the Electron main process, never from standalone servers.
function getSafeStorage(): typeof import('electron').safeStorage {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy so this module loads without Electron (unit tests)
  return require('electron').safeStorage
}

/** All settings keys that contain API secrets and must be encrypted at rest. */
const ENCRYPTED_SETTINGS_KEYS = ['anthropicApiKey', 'openCodeApiKey', 'localApiKey'] as const

/**
 * Encrypt any plaintext API key fields in a settings object before DB storage.
 * Mutates nothing — returns a new object with encrypted values.
 *
 * Fields that are already encrypted (have a truthy `${key}Encrypted` companion)
 * are left untouched to avoid double-encryption.
 */
export function encryptSettingsKeys(settings: Record<string, unknown>): Record<string, unknown> {
  const result = { ...settings }
  for (const key of ENCRYPTED_SETTINGS_KEYS) {
    const value = result[key]
    const alreadyEncrypted = result[`${key}Encrypted`]
    if (typeof value === 'string' && value.length > 0 && !alreadyEncrypted) {
      result[key] = getSafeStorage().encryptString(value).toString('base64')
      result[`${key}Encrypted`] = true
    }
  }
  return result
}

/**
 * Decrypt a single API key value using its companion encrypted flag.
 * Returns the plaintext key, handling both legacy (unencrypted) and
 * encrypted storage transparently.
 */
export function decryptSettingsKey(
  value: string | undefined | null,
  isEncrypted: boolean | undefined
): string | undefined {
  if (!value) return undefined
  if (isEncrypted) {
    try {
      return getSafeStorage().decryptString(Buffer.from(value, 'base64'))
    } catch (_err) {
      // SEC-04b: Decryption failed — the flag/value pair is inconsistent.
      // This happens when:
      //   1. The value was stored as plaintext but the flag was set to true
      //   2. The OS keychain was re-keyed (password change, migration)
      //   3. The encrypted data is corrupt
      // Log the failure so it's diagnosable, and fall back to the raw value.
      // A short non-base64 string is likely plaintext that was flagged incorrectly.
      const looksLikePlaintext = value.length < 100 && !/^[A-Za-z0-9+/]+=*$/.test(value)
      if (looksLikePlaintext) {
        console.warn(
          `[SEC-04b] decryptSettingsKey: encrypted flag set but value appears to be plaintext ` +
            `(len=${value.length}). Returning raw value as fallback.`
        )
        return value
      }
      console.warn(
        `[SEC-04b] decryptSettingsKey: decryption failed for encrypted value (len=${value.length}). ` +
          `Key is lost — user must re-enter it.`
      )
      return undefined
    }
  }
  return value // Legacy plaintext — returned as-is
}
