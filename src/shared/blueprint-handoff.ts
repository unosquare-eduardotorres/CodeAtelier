/**
 * Blueprint → Chat handoff intents.
 *
 * A finished blueprint leaves a branch, a worktree and a pile of files behind.
 * "Pass it over to a chat" is almost never open-ended — the next step is one of
 * a small set: look it over, get it running, or ship it. Making the user say
 * which one turns a generic context dump into a first instruction the agent can
 * actually act on, and picks the right conversation mode for it.
 *
 * Shared so main composes the seed message and the renderer labels the picker
 * from the same table — the two drifting apart is how the button ends up
 * promising something the prompt does not ask for.
 */

export type BlueprintHandoffIntent = 'continue' | 'review' | 'run' | 'ship'

/**
 * What to do about the blueprint's branch.
 *
 * `take` moves the branch and its working tree to the new chat. `none` leaves
 * it where it is and the chat works in the workspace checkout instead.
 *
 * A choice rather than a default because after the first handoff the branch
 * belongs to another chat, and seizing it silently is exactly the surprise the
 * track system exists to prevent.
 */
export type BlueprintBranchMode = 'take' | 'none'

/** Who is holding the blueprint's branch right now. */
export interface BlueprintBranchHolder {
  kind: string
  ownerId: string | null
  label: string | null
  /** Set when the holder is a chat that still exists — lets the UI offer to open it. */
  conversationId: string | null
}

/**
 * Everything the handoff UI needs to offer a truthful choice, resolved before
 * anything is created.
 */
export interface BlueprintHandoffOptions {
  /** The blueprint's branch, when one can be evidenced. Null = workspace checkout. */
  branchName: string | null
  /** Null when the blueprint still owns its own branch. */
  holder: BlueprintBranchHolder | null
  /** Non-null when taking the branch would be refused right now, and why. */
  busyReason: string | null
  /** Earlier blueprint → chat handoffs, newest first. */
  priorHandoffs: { conversationId: string; intent: string; createdAt: string }[]
}

export interface BlueprintHandoffIntentSpec {
  id: BlueprintHandoffIntent
  /** Button label in the picker. */
  label: string
  /** One line under the label — what the chat will actually do. */
  description: string
  /**
   * Conversation mode.
   *
   * `plan` for intents that read and report; `build` for intents that have to
   * write, install or push. A read-only intent opened in build mode invites the
   * agent to start editing code the user only asked it to look at.
   */
  mode: 'plan' | 'build'
  /** Prefix for the generated conversation title. */
  titlePrefix: string
  /** The first instruction handed to the agent, after the handoff context. */
  instruction: string
}

export const BLUEPRINT_HANDOFF_INTENTS: readonly BlueprintHandoffIntentSpec[] = [
  {
    id: 'continue',
    label: 'Continue the work',
    description: 'Pick up where the blueprint stopped and keep going.',
    mode: 'plan',
    titlePrefix: 'Continue',
    instruction:
      'Pick up this work where the blueprint left off. Start by reading the files listed above ' +
      'to see what actually landed — the blueprint summary describes intent, the working tree is ' +
      'the truth. Then tell me what you found and what you propose to do next, before changing anything.'
  },
  {
    id: 'review',
    label: 'Review & audit',
    description: 'Read what the blueprint produced and report problems before you trust it.',
    mode: 'plan',
    titlePrefix: 'Review',
    instruction:
      'Review the code this blueprint produced. Read the files listed above, check them against ' +
      'the stated goal, and report what is wrong, missing, or risky — correctness first, then ' +
      'security, then maintainability. Do not fix anything yet; give me the findings and let me ' +
      'decide what to act on.'
  },
  {
    id: 'run',
    label: 'Build & run',
    description: 'Install, build, and get the app running locally — fixing what breaks.',
    mode: 'build',
    titlePrefix: 'Run',
    instruction:
      'Get this running locally. Work out the install/build/run commands from the repository ' +
      'itself (package manifests, scripts, README) rather than assuming a stack, run them, and ' +
      'fix what breaks until the app starts. Report the exact commands that worked so I can repeat them.'
  },
  {
    id: 'ship',
    label: 'Ship to GitHub',
    description: 'Commit the work, push the branch, and open a pull request.',
    mode: 'build',
    titlePrefix: 'Ship',
    instruction:
      'Ship this work. Review the uncommitted changes first and tell me what you are about to ' +
      'commit, then commit with a message describing the change, push the branch, and open a pull ' +
      'request summarising what the blueprint built. Stop and ask me if anything in the diff looks ' +
      'unintended.'
  }
]

const BY_ID = new Map<BlueprintHandoffIntent, BlueprintHandoffIntentSpec>(
  BLUEPRINT_HANDOFF_INTENTS.map((spec) => [spec.id, spec])
)

/** Look up an intent spec. Unknown/absent ids fall back to `continue`. */
export function resolveHandoffIntent(intent: string | undefined): BlueprintHandoffIntentSpec {
  return BY_ID.get(intent as BlueprintHandoffIntent) ?? BY_ID.get('continue')!
}

export function isBlueprintHandoffIntent(value: unknown): value is BlueprintHandoffIntent {
  return typeof value === 'string' && BY_ID.has(value as BlueprintHandoffIntent)
}

export function isBlueprintBranchMode(value: unknown): value is BlueprintBranchMode {
  return value === 'take' || value === 'none'
}
