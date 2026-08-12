/** Read the `version:` field from an electron-builder channel manifest. */
export declare function parseManifestVersion(text: string): string | null

/**
 * Rewrite every `url:` / `path:` value to `<version>/<platform>/<basename>`.
 * Throws when the manifest does not describe `version`. Idempotent: values that
 * already contain `/` are left untouched.
 */
export declare function rewriteManifest(
  text: string,
  version: string,
  platform: string
): { text: string; files: string[] }
