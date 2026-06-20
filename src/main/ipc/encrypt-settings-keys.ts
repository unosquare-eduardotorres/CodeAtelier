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
import { safeStorage } from 'electron'

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
      result[key] = safeStorage.encryptString(value).toString('base64')
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
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      // Corrupt or re-keyed — return undefined rather than crash
      return undefined
    }
  }
  return value // Legacy plaintext — returned as-is
}
