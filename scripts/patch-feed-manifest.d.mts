/** Read the `version:` field from an electron-builder channel manifest. */
export declare function parseManifestVersion(text: string): string | null

/**
 * Rewrite every `url:` / `path:` value to `<version>/<platform>/<basename>`.
 * Throws when the manifest does not describe `version`. Idempotent: values that
 * already contain `/` are left untouched.
 *
 * `sizes` maps a referenced path to the byte count the manifest declares for it,
 * so the publish step can verify artifacts by size rather than mere existence.
 * A path whose block carries no `size:` is absent from the map.
 */
export declare function rewriteManifest(
  text: string,
  version: string,
  platform: string
): { text: string; files: string[]; sizes: Record<string, number> }
