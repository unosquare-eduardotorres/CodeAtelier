/**
 * The lent-branch guard — the rules, imported for real.
 *
 * A blueprint can take a chat's branch over while the chat keeps its
 * `branch_name`, which is what makes handing it back possible. The guard that
 * decides what the chat may do meanwhile lived inside `ChatStreamService.stream`,
 * a method that needs a database, a lifecycle registry, a live CLI session and a
 * workspace on disk before it will run at all — so it had no test, and the two
 * rules most likely to be got wrong were the two nobody could see:
 *
 *   - a *retained* track (owner cleared, work preserved) is NOT lent. Get this
 *     backwards and every chat whose branch was ever retained is permanently
 *     unable to write — the normal state after closing a chat.
 *   - a *plan* turn is allowed through while the branch is away. Get this
 *     backwards and lending a branch to a blueprint silently disables the chat
 *     completely, including the conversation the user would have while waiting.
 *
 * These import the real functions. Replicating the logic here would produce a
 * test that still passes with the implementation deleted.
 *
 * Run: tsx src/main/services/__tests__/lent-branch.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  resolveLentHolder,
  lentBranchRefusal,
  type HeldTrackRow,
  type LentBranchHolder
} from '../lent-branch'

const CHAT = { id: 'conv-1', branchName: 'chat/feature-x' }

/** A track row held by an owner. */
function heldBy(ownerKind: HeldTrackRow['ownerKind'], ownerId: string): HeldTrackRow {
  return { ownerKind, ownerId }
}

describe('resolveLentHolder — is the branch away?', () => {
  test('a chat with no branch has nothing to lend', () => {
    assert.equal(resolveLentHolder({ id: 'conv-1' }, heldBy('blueprint', 'bp-1')), null)
    assert.equal(
      resolveLentHolder({ id: 'conv-1', branchName: null }, heldBy('blueprint', 'bp-1')),
      null
    )
  })

  test('no track holds the branch', () => {
    assert.equal(resolveLentHolder(CHAT, null), null)
    assert.equal(resolveLentHolder(CHAT, undefined), null)
  })

  test('a retained track is not lent — its owner is gone, nobody is writing', () => {
    // The regression this exists to prevent: retention clears owner_id but keeps
    // the row and the tree. Reading that as "held by someone" wedges the chat
    // forever, and retention is what happens every time a chat is closed with
    // uncommitted work.
    const retained: HeldTrackRow = { ownerKind: 'chat', ownerId: null }
    assert.equal(resolveLentHolder(CHAT, retained), null)
  })

  test('the chat holding its own branch is the normal state, not a loan', () => {
    assert.equal(resolveLentHolder(CHAT, heldBy('chat', 'conv-1')), null)
  })

  test('another chat holding it is a loan', () => {
    const lent = resolveLentHolder(CHAT, heldBy('chat', 'conv-2'))
    assert.ok(lent)
    assert.equal(lent.ownerId, 'conv-2')
    assert.equal(lent.ownerKind, 'chat')
    assert.equal(lent.branchName, 'chat/feature-x')
    assert.equal(lent.label, 'Another chat')
  })

  test('a blueprint holding it is a loan, named as a blueprint', () => {
    const lent = resolveLentHolder(CHAT, heldBy('blueprint', 'bp-9'))
    assert.ok(lent)
    assert.equal(lent.label, 'A blueprint')
  })

  test('every owner kind is named as itself', () => {
    // Was `kind === 'blueprint' ? 'A blueprint' : 'Another chat'`, which told a
    // user whose branch a campaign had taken to go find a chat.
    const labels = (['chat', 'blueprint', 'campaign', 'manual'] as const).map(
      (kind) => resolveLentHolder(CHAT, heldBy(kind, `owner-${kind}`))?.label
    )
    assert.deepEqual(labels, ['Another chat', 'A blueprint', 'A campaign', 'Other work'])
  })
})

describe('lentBranchRefusal — may this turn run?', () => {
  const lentToBlueprint: LentBranchHolder = {
    branchName: 'chat/feature-x',
    ownerKind: 'blueprint',
    ownerId: 'bp-9',
    label: 'A blueprint'
  }
  const lentToChat: LentBranchHolder = {
    branchName: 'chat/feature-x',
    ownerKind: 'chat',
    ownerId: 'conv-2',
    label: 'Another chat'
  }

  test('a branch that is not lent never refuses anything', () => {
    assert.equal(lentBranchRefusal(null, 'build'), null)
    assert.equal(lentBranchRefusal(null, 'danger'), null)
  })

  test('a plan turn runs while the branch is away', () => {
    assert.equal(lentBranchRefusal(lentToBlueprint, 'plan'), null)
  })

  test('a conversation with no mode is treated as planning', () => {
    // `mode` is optional on the row and predates the column. Defaulting to
    // `build` here would block every legacy conversation.
    assert.equal(lentBranchRefusal(lentToBlueprint, undefined), null)
    assert.equal(lentBranchRefusal(lentToBlueprint, null), null)
  })

  test('a build turn is refused, and the message names the holder and branch', () => {
    const msg = lentBranchRefusal(lentToBlueprint, 'build')
    assert.ok(msg)
    assert.match(msg, /^A blueprint is working on "chat\/feature-x" right now\./)
    assert.match(msg, /Planning still works\./)
  })

  test('a danger turn is refused too', () => {
    assert.ok(lentBranchRefusal(lentToBlueprint, 'danger'))
  })

  test('only a chat holder carries a blockedBy tag', () => {
    // The renderer resolves `blockedBy:` to a conversation title. A blueprint id
    // there sends the user hunting through a chat list it is not in.
    assert.match(lentBranchRefusal(lentToChat, 'build')!, /\(blockedBy:conv-2\)$/)
    assert.doesNotMatch(lentBranchRefusal(lentToBlueprint, 'build')!, /blockedBy/)
  })
})

void summaryAsync()
