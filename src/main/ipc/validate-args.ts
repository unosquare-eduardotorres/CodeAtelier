/**
 * Lightweight runtime validation for IPC handler arguments.
 *
 * Electron IPC hands us `unknown` from the renderer. TypeScript types at the
 * call site give us compile-time guarantees, but the main process is still a
 * security boundary — a malformed renderer call (or an attacker with access to
 * DevTools) would previously forward garbage directly into the SDK and produce
 * obscure failures.
 *
 * These helpers surface clear errors the moment a required field is missing or
 * has the wrong type, and they live in one place so every IPC module validates
 * the same way.
 */

/**
 * Narrow `unknown` to a non-null plain object, throwing otherwise.
 * Use this as the entry gate before calling field-level validators.
 */
export function requireObject(
  args: unknown,
  channel: string
): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${channel}: expected an object argument, got ${describe(args)}`)
  }
  return args as Record<string, unknown>
}

/**
 * Assert that `obj` has `field` as a non-empty string and return it.
 */
export function requireString(
  obj: Record<string, unknown>,
  field: string,
  channel: string
): string {
  const value = obj[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${channel}: field '${field}' must be a non-empty string`)
  }
  return value
}

/**
 * Assert that `obj[field]` is either a string or absent. Returns `undefined`
 * when the field is missing. Throws if present but not a string.
 */
export function optionalString(
  obj: Record<string, unknown>,
  field: string,
  channel: string
): string | undefined {
  const value = obj[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`${channel}: field '${field}' must be a string when provided`)
  }
  return value
}

/**
 * Assert that `obj[field]` is either a finite number or absent.
 */
export function optionalNumber(
  obj: Record<string, unknown>,
  field: string,
  channel: string
): number | undefined {
  const value = obj[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${channel}: field '${field}' must be a finite number when provided`)
  }
  return value
}

/**
 * Assert that `obj[field]` is either a boolean or absent.
 */
export function optionalBoolean(
  obj: Record<string, unknown>,
  field: string,
  channel: string
): boolean | undefined {
  const value = obj[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`${channel}: field '${field}' must be a boolean when provided`)
  }
  return value
}

/**
 * Assert that `obj[field]` is a string, null, or absent. Returns the value
 * (including null) when present.
 */
export function optionalNullableString(
  obj: Record<string, unknown>,
  field: string,
  channel: string
): string | null | undefined {
  const value = obj[field]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new Error(`${channel}: field '${field}' must be a string, null, or omitted`)
  }
  return value
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
