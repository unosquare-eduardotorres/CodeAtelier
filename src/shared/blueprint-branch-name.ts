/**
 * What a blueprint's branch is called.
 *
 * Lives in `shared/` because both sides need the same answer: main resolves the
 * name when the run starts, and the draft UI previews it before anything is
 * created. Two implementations would drift, and the drift would only be visible
 * as a branch named something other than what the user was shown.
 *
 * A Jira blueprint is named after its ticket — `feature/MUL-2336-…` — because
 * the ticket key is the identifier everything else in the team's workflow is
 * keyed on. Everything else keeps the historical `blueprint/<slug>-<id8>` shape.
 */

/** Longest description tail on a Jira branch, before word-boundary trimming. */
const JIRA_DESC_MAX = 40

/** Longest slug on a non-Jira branch. Unchanged from the original naming. */
const AUTO_SLUG_MAX = 50

/** Lowercase, hyphen-separated, git-safe. Empty when the input has no letters. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Cut a slug to `max` without splitting a word.
 *
 * A blind `.slice(0, n)` is what produced names like `…-heading-to-b`: the
 * truncation reads as a typo rather than as a shortening.
 */
function truncateOnWordBoundary(slug: string, max: number): string {
  if (slug.length <= max) return slug
  // The character we would drop is already a separator, so the cut is clean.
  if (slug[max] === '-') return slug.slice(0, max).replace(/-+$/, '')
  const cut = slug.slice(0, max)
  const lastDash = cut.lastIndexOf('-')
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '')
}

/**
 * Drop a leading ticket key from a title.
 *
 * Jira blueprints are titled `MUL-2336: Rename hotel billing detail`, and the
 * key is already the first thing in the branch name — repeating it would give
 * `feature/MUL-2336-mul-2336-rename-…`. Handles the three shapes the importer
 * and hand-written titles produce: `KEY:`, `KEY -`, `[KEY]`.
 */
function stripLeadingKey(title: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return title.replace(new RegExp(`^\\s*\\[?${escaped}\\]?\\s*[:\\-–—]?\\s*`, 'i'), '')
}

/**
 * The branch name persisted on a blueprint, if it has been resolved yet.
 *
 * `settingsJson` is free-form storage shared with `branchChoice`,
 * `referenceDocuments` and the Jira keys, written by several code paths — so it
 * is shape-checked rather than cast. Null means "not reserved yet", which every
 * blueprint created before reservation existed reports.
 */
export function readBlueprintBranchName(
  settings: Record<string, unknown> | null | undefined
): string | null {
  const raw = settings?.branchName
  return typeof raw === 'string' && raw ? raw : null
}

/** The Jira ticket key a blueprint was imported from, if any. */
export function readJiraIssueKey(
  settings: Record<string, unknown> | null | undefined
): string | undefined {
  const raw = settings?.jiraIssueKey
  return typeof raw === 'string' && raw ? raw : undefined
}

export interface BlueprintBranchNameParams {
  title: string
  /** Present only for blueprints imported from a Jira ticket. */
  jiraIssueKey?: string
  blueprintId: string
  /** Branch names already in use — local refs plus branches held by tracks. */
  taken?: ReadonlySet<string>
}

/**
 * The branch name a blueprint should run on.
 *
 * Resolved once and persisted by the caller, never recomputed: `ensureTrack`
 * treats a different branch name for the same owner as a stale track and tears
 * it down, so a title edit mid-run would silently relocate the work.
 */
export function buildBlueprintBranchName(params: BlueprintBranchNameParams): string {
  const { title, jiraIssueKey, blueprintId, taken } = params

  let base: string
  if (jiraIssueKey && jiraIssueKey.trim()) {
    // Verbatim and uppercase — this is the string people search Jira with.
    const key = slugifyKey(jiraIssueKey)
    const desc = truncateOnWordBoundary(
      slugify(stripLeadingKey(title, jiraIssueKey)),
      JIRA_DESC_MAX
    )
    base = desc ? `feature/${key}-${desc}` : `feature/${key}`
  } else {
    const slug = slugify(title || 'blueprint').slice(0, AUTO_SLUG_MAX)
    base = `blueprint/${slug || 'run'}-${blueprintId.slice(0, 8)}`
  }

  return disambiguate(base, taken)
}

/** Uppercase the key and force it into git-safe characters. */
function slugifyKey(key: string): string {
  return (
    key
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'TICKET'
  )
}

/**
 * Make the name unique against branches that already exist.
 *
 * A Jira branch carries no id suffix, so re-importing a ticket collides — and a
 * collision is not benign: `ensureTrack` throws `TrackConflictError` on a held
 * branch, which the blueprint path swallows into a silent fallback to the
 * shared checkout.
 */
function disambiguate(base: string, taken?: ReadonlySet<string>): string {
  if (!taken || !taken.has(base)) return base
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return base
}
