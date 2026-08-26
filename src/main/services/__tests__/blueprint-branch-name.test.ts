/**
 * What a blueprint's branch is called.
 *
 * The name is resolved once, persisted, and then used by `ensureTrack` as an
 * identity key — a different name for the same owner is read as a stale track
 * and torn down. So the interesting properties here are not cosmetic:
 *
 *   - the ticket key survives verbatim, because it is what people search with;
 *   - the description is truncated on a word boundary, because `…-heading-to-b`
 *     reads as a typo rather than as a shortening;
 *   - a name already in use is disambiguated, because a Jira branch carries no
 *     id suffix and a collision degrades a run to the shared checkout silently.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import {
  buildBlueprintBranchName,
  readBlueprintBranchName,
  readJiraIssueKey
} from '../../../shared/blueprint-branch-name'

const ID = 'd18319b8-aaaa-bbbb-cccc-dddddddddddd'

describe('blueprint branch name › Jira tickets', () => {
  test('names the branch after the ticket, not the blueprint id', () => {
    const name = buildBlueprintBranchName({
      title: 'MUL-2336: Rename hotel billing detail',
      jiraIssueKey: 'MUL-2336',
      blueprintId: ID
    })
    assert.equal(name, 'feature/MUL-2336-rename-hotel-billing-detail')
  })

  test('does not repeat the key when the title already leads with it', () => {
    for (const title of [
      'MUL-2336: Rename hotel billing',
      'MUL-2336 - Rename hotel billing',
      '[MUL-2336] Rename hotel billing',
      'mul-2336: Rename hotel billing'
    ]) {
      assert.equal(
        buildBlueprintBranchName({ title, jiraIssueKey: 'MUL-2336', blueprintId: ID }),
        'feature/MUL-2336-rename-hotel-billing',
        title
      )
    }
  })

  test('uppercases the key even when the ticket was typed in lower case', () => {
    const name = buildBlueprintBranchName({
      title: 'Fix the thing',
      jiraIssueKey: 'mul-2336',
      blueprintId: ID
    })
    assert.equal(name, 'feature/MUL-2336-fix-the-thing')
  })

  test('truncates the description on a word boundary, never mid-word', () => {
    const name = buildBlueprintBranchName({
      title: 'Rename the hotel billing detail heading to be far more descriptive',
      jiraIssueKey: 'MUL-2336',
      blueprintId: ID
    })
    const desc = name.replace('feature/MUL-2336-', '')
    assert.ok(desc.length <= 40, `description is ${desc.length} chars: ${desc}`)
    // The old blind slice(0, n) cut here produced `…-heading-to-b`.
    assert.equal(desc, 'rename-the-hotel-billing-detail-heading')
  })

  test('a cut that lands exactly on a separator keeps the whole word', () => {
    // Slug is `aaaa-bbbb-...` — chosen so character 40 is the separator itself.
    const title = `${'a'.repeat(20)} ${'b'.repeat(19)} tail`
    const name = buildBlueprintBranchName({ title, jiraIssueKey: 'X-1', blueprintId: ID })
    assert.equal(name, `feature/X-1-${'a'.repeat(20)}-${'b'.repeat(19)}`)
  })

  test('quotes and punctuation never reach the branch name', () => {
    const name = buildBlueprintBranchName({
      title: `MUL-11: Don't break "billing" (again!)`,
      jiraIssueKey: 'MUL-11',
      blueprintId: ID
    })
    assert.match(name, /^feature\/MUL-11-[a-z0-9-]+$/)
    assert.ok(!name.endsWith('-'))
  })

  test('a title that slugs to nothing still yields a usable branch', () => {
    const name = buildBlueprintBranchName({
      title: '!!! ???',
      jiraIssueKey: 'MUL-9',
      blueprintId: ID
    })
    assert.equal(name, 'feature/MUL-9')
  })
})

describe('blueprint branch name › non-Jira blueprints', () => {
  test('keeps the historical blueprint/<slug>-<id8> shape', () => {
    const name = buildBlueprintBranchName({ title: 'Add retry to uploads', blueprintId: ID })
    assert.equal(name, 'blueprint/add-retry-to-uploads-d18319b8')
  })

  test('an empty ticket key is not treated as a ticket', () => {
    const name = buildBlueprintBranchName({
      title: 'Add retry to uploads',
      jiraIssueKey: '   ',
      blueprintId: ID
    })
    assert.equal(name, 'blueprint/add-retry-to-uploads-d18319b8')
  })

  test('two blueprints with the same title still differ', () => {
    const a = buildBlueprintBranchName({ title: 'Same title', blueprintId: 'aaaaaaaa1111' })
    const b = buildBlueprintBranchName({ title: 'Same title', blueprintId: 'bbbbbbbb2222' })
    assert.notEqual(a, b, 'git allows a branch in exactly one worktree repo-wide')
  })
})

describe('blueprint branch name › collisions', () => {
  test('suffixes a re-imported ticket rather than reusing a held branch', () => {
    const taken = new Set(['feature/MUL-2336-rename-hotel-billing'])
    const name = buildBlueprintBranchName({
      title: 'MUL-2336: Rename hotel billing',
      jiraIssueKey: 'MUL-2336',
      blueprintId: ID,
      taken
    })
    assert.equal(name, 'feature/MUL-2336-rename-hotel-billing-2')
  })

  test('keeps counting past the first collision', () => {
    const taken = new Set(['feature/MUL-1-fix', 'feature/MUL-1-fix-2', 'feature/MUL-1-fix-3'])
    const name = buildBlueprintBranchName({
      title: 'Fix',
      jiraIssueKey: 'MUL-1',
      blueprintId: ID,
      taken
    })
    assert.equal(name, 'feature/MUL-1-fix-4')
  })

  test('an unrelated set of taken names changes nothing', () => {
    const name = buildBlueprintBranchName({
      title: 'Fix',
      jiraIssueKey: 'MUL-1',
      blueprintId: ID,
      taken: new Set(['main', 'chat/mulligan-d18319b8'])
    })
    assert.equal(name, 'feature/MUL-1-fix')
  })
})

describe('blueprint branch name › settings readers', () => {
  test('reads a persisted branch name, and nothing else', () => {
    assert.equal(readBlueprintBranchName({ branchName: 'feature/MUL-1-fix' }), 'feature/MUL-1-fix')
    assert.equal(readBlueprintBranchName({}), null)
    assert.equal(readBlueprintBranchName({ branchName: '' }), null)
    assert.equal(readBlueprintBranchName({ branchName: 42 }), null)
    assert.equal(readBlueprintBranchName(null), null)
    assert.equal(readBlueprintBranchName(undefined), null)
  })

  test('reads a Jira key defensively', () => {
    assert.equal(readJiraIssueKey({ jiraIssueKey: 'MUL-1' }), 'MUL-1')
    assert.equal(readJiraIssueKey({ jiraIssueKey: 7 }), undefined)
    assert.equal(readJiraIssueKey(null), undefined)
  })
})
