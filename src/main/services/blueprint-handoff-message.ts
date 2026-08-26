/**
 * The first message a Blueprint → Chat handoff puts in the new conversation.
 *
 * Kept apart from the IPC handler so it can be tested without Electron, and
 * because it is the part most likely to be edited: it is a prompt, not plumbing.
 *
 * What it deliberately does NOT do is inline the blueprint's spec, plan or
 * output. Those are files in the working tree the chat is about to inherit —
 * the envelope points at them (`filesToReadFirst`, artifacts) and the agent
 * reads them. Inlining would be both lossy, since the standard render truncates
 * long runs, and redundant.
 */

import type { BlueprintHandoffIntentSpec } from '../../shared/blueprint-handoff'

export interface HandoffMessageParams {
  /** Envelope rendered in `standard` format by the chat target adapter. */
  contextMarkdown: string
  spec: BlueprintHandoffIntentSpec
  /** The branch the new chat works on, or null for the workspace checkout. */
  branchName: string | null
  /** True when the chat took over the blueprint's own working tree. */
  inheritedTrack: boolean
  /**
   * The blueprint's branch when the user chose NOT to take it.
   *
   * Without this, declining the branch is indistinguishable from a blueprint
   * that never had one, and the agent gets told the output is in the checkout
   * when it is actually on a branch someone else is holding.
   */
  unclaimedBranch?: string | null
  /**
   * The Jira ticket the blueprint was imported from, when it had one.
   *
   * The key already reaches the chat, but only as one line in the decisions
   * dump — which tells the agent the number without telling it the ticket is
   * something it is expected to read and answer to.
   */
  jiraIssueKey?: string
}

export function composeHandoffMessage(params: HandoffMessageParams): string {
  const { contextMarkdown, spec, branchName, inheritedTrack, unclaimedBranch, jiraIssueKey } =
    params
  const lines: string[] = [contextMarkdown.trimEnd(), '', '### Where this work lives', '']

  // Which of these three is true changes the agent's first move, and it cannot
  // infer it: an agent that assumes a fresh checkout reports an empty diff, and
  // one that assumes it inherited a tree edits files that are not there.
  if (inheritedTrack && branchName) {
    lines.push(
      `This conversation took over the blueprint's own working tree on \`${branchName}\`. ` +
        `Everything the blueprint produced is already here, uncommitted changes included — ` +
        `you do not need to check anything out or copy anything.`
    )
  } else if (branchName) {
    lines.push(
      `This conversation works on \`${branchName}\`. The blueprint's output is on that branch.`
    )
  } else if (unclaimedBranch) {
    lines.push(
      `The blueprint's output is on \`${unclaimedBranch}\`, which is currently checked out by ` +
        `other work. This conversation runs in the workspace checkout, so **that output is not ` +
        `in your working tree** — read it from the branch (\`git show\`, \`git diff\`) rather ` +
        `than assuming the files are present.`
    )
  } else {
    lines.push(
      `The blueprint ran in the workspace checkout rather than a branch of its own, so its ` +
        `output is already in the working tree you are in.`
    )
  }

  if (jiraIssueKey) {
    lines.push(
      '',
      `This work started from Jira ticket \`${jiraIssueKey}\`, which is the requirement of ` +
        `record — read it with \`mcp__jira__get_issue\` rather than inferring it from the title, ` +
        `and use \`mcp__jira__add_comment\` to post back to it when asked.`
    )
  }

  lines.push('', '### What I want you to do next', '', spec.instruction)

  return lines.join('\n')
}
