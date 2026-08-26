/**
 * What the blueprint branch picker is offered — the real assembly function.
 *
 * The `blueprint:branchOptions` round trip had no coverage of any kind: the
 * handler needs `ipcMain`, a workspace on disk and a live database, so the one
 * decision in it that can be wrong — how a held branch is presented — was
 * invisible. These import the shaping function the handler now delegates to.
 *
 * The property that matters is that a held branch still APPEARS. Filtering held
 * branches out is the obvious-looking implementation and it is wrong twice
 * over: the user sees a branch in their terminal that the picker denies exists,
 * and they are given no way to find out who has it.
 *
 * Run: tsx src/main/services/__tests__/branch-options.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { buildBranchOptions, NO_COMMITS_BRANCH_OPTIONS, type HeldBranch } from '../branch-options'

/** Titles for the two chats used below; anything else is unresolvable. */
const TITLES: Record<string, string> = { 'conv-1': 'Refactor the parser' }
const chatTitle = (id: string): string | null => TITLES[id] ?? null

describe('buildBranchOptions — an ordinary repository', () => {
  const base = {
    repoHasCommits: true as const,
    local: ['main', 'chat/parser', 'blueprint/auth-1a2b3c4d'],
    current: 'main',
    chatTitle
  }

  test('every local branch is offered', () => {
    const opts = buildBranchOptions({ ...base, tracks: [] })
    assert.deepEqual(
      opts.branches.map((b) => b.name),
      ['main', 'chat/parser', 'blueprint/auth-1a2b3c4d']
    )
    assert.equal(opts.repoHasCommits, true)
    assert.equal(opts.currentBranch, 'main')
  })

  test('the checkout branch is marked, and only it', () => {
    const opts = buildBranchOptions({ ...base, tracks: [] })
    assert.deepEqual(
      opts.branches.filter((b) => b.isPrimaryHead).map((b) => b.name),
      ['main']
    )
  })

  test('an unowned branch has no holder', () => {
    const opts = buildBranchOptions({ ...base, tracks: [] })
    assert.equal(opts.branches.find((b) => b.name === 'chat/parser')?.heldBy, null)
  })

  test('a held branch is still listed, with who has it', () => {
    // The whole point. Filtering it out hides a branch the user can see in
    // their own terminal, and answers none of "why can I not pick this?".
    const tracks: HeldBranch[] = [
      { branchName: 'chat/parser', ownerKind: 'chat', ownerId: 'conv-1' }
    ]
    const opts = buildBranchOptions({ ...base, tracks })
    const held = opts.branches.find((b) => b.name === 'chat/parser')

    assert.ok(held, 'held branch must still appear in the list')
    assert.equal(held.heldBy?.ownerKind, 'chat')
    assert.equal(held.heldBy?.ownerId, 'conv-1')
  })

  test('a chat holder is named by its title, not its id', () => {
    const tracks: HeldBranch[] = [
      { branchName: 'chat/parser', ownerKind: 'chat', ownerId: 'conv-1' }
    ]
    const opts = buildBranchOptions({ ...base, tracks })
    assert.equal(
      opts.branches.find((b) => b.name === 'chat/parser')?.heldBy?.label,
      'Refactor the parser'
    )
  })

  test('a chat whose title cannot be resolved falls back to its id', () => {
    // A deleted conversation whose track outlived it. Showing `null` here would
    // render as "held by nobody" beside a branch that is definitely held.
    const tracks: HeldBranch[] = [
      { branchName: 'chat/parser', ownerKind: 'chat', ownerId: 'conv-gone' }
    ]
    const opts = buildBranchOptions({ ...base, tracks })
    assert.equal(opts.branches.find((b) => b.name === 'chat/parser')?.heldBy?.label, 'conv-gone')
  })

  test('a non-chat holder is named by its id — there is nothing better', () => {
    const tracks: HeldBranch[] = [
      { branchName: 'blueprint/auth-1a2b3c4d', ownerKind: 'blueprint', ownerId: 'bp-77' }
    ]
    const opts = buildBranchOptions({ ...base, tracks })
    const held = opts.branches.find((b) => b.name === 'blueprint/auth-1a2b3c4d')
    assert.equal(held?.heldBy?.ownerKind, 'blueprint')
    assert.equal(held?.heldBy?.label, 'bp-77')
  })

  test('a retained track has a tree but no owner, so it is free to take', () => {
    // `transferOwner` adopts these without a busy check — retained means the
    // work outlived whatever produced it and nobody is writing to that tree.
    // A non-null `heldBy` with a null `ownerId` is how the picker distinguishes
    // "somebody is using this" from "this has a worktree you can inherit".
    const tracks: HeldBranch[] = [{ branchName: 'chat/parser', ownerKind: 'chat', ownerId: null }]
    const opts = buildBranchOptions({ ...base, tracks })
    const held = opts.branches.find((b) => b.name === 'chat/parser')
    assert.ok(held?.heldBy, 'a retained track still holds the branch in a worktree')
    assert.equal(held.heldBy.ownerId, null)
    assert.equal(held.heldBy.label, null)
  })

  test('a track for a branch that no longer exists is ignored', () => {
    // Bookkeeping outliving the ref. It must not manufacture a picker entry for
    // a branch git would reject.
    const tracks: HeldBranch[] = [
      { branchName: 'chat/deleted', ownerKind: 'chat', ownerId: 'conv-1' }
    ]
    const opts = buildBranchOptions({ ...base, tracks })
    assert.equal(opts.branches.length, 3)
    assert.equal(
      opts.branches.some((b) => b.name === 'chat/deleted'),
      false
    )
  })
})

describe('buildBranchOptions — degenerate repositories', () => {
  test('no commits yet: no branches, and says so', () => {
    const opts = buildBranchOptions({
      repoHasCommits: false,
      local: ['main'],
      current: 'main',
      tracks: [],
      chatTitle
    })
    assert.equal(opts.repoHasCommits, false)
    assert.deepEqual(opts.branches, [])
    assert.equal(opts.currentBranch, null)
    assert.deepEqual(opts, NO_COMMITS_BRANCH_OPTIONS)
  })

  test('a detached HEAD reports no current branch rather than an empty one', () => {
    // `git branch --show-current` prints nothing when detached. Passing '' on
    // would mark no branch as primary head and render an empty label.
    const opts = buildBranchOptions({
      repoHasCommits: true,
      local: ['main'],
      current: '',
      tracks: [],
      chatTitle
    })
    assert.equal(opts.currentBranch, null)
    assert.equal(opts.branches[0].isPrimaryHead, false)
  })
})

// summaryAsync() calls process.exit() — only run it as the entry point, or the
// shared runner is terminated mid-list.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
