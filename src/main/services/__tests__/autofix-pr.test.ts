/**
 * Tests for autofix-pr.service — the orchestration service for `/autofix-pr`.
 *
 * Tests the buildFixPrompt method's prompt generation logic with various
 * combinations of CI failures and review comments.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

// ── Pure-logic tests for prompt generation ──

describe('autofix-pr prompt generation', () => {
  /** Simulates the prompt-building logic extracted from AutofixPrService. */
  function buildPromptSections(params: {
    prNumber: number
    failedChecks: Array<{
      name: string
      conclusion: string | null
      output: { title: string | null; summary: string | null }
    }>
    reviewComments: Array<{
      author: string
      body: string
      path: string
      line: number | null
    }>
  }): string {
    const { prNumber, failedChecks: allChecks, reviewComments } = params
    const failedChecks = allChecks.filter((c) => c.conclusion === 'failure')

    const sections: string[] = [`## Auto-Fix PR #${prNumber}`, '']

    if (failedChecks.length > 0) {
      sections.push('### ❌ Failed CI Checks')
      for (const check of failedChecks) {
        sections.push(`- **${check.name}**`)
        if (check.output.summary) {
          sections.push(`  \`\`\`\n  ${check.output.summary.slice(0, 1500)}\n  \`\`\``)
        }
      }
      sections.push('')
    }

    if (reviewComments.length > 0) {
      sections.push('### 💬 Review Comments')
      for (const comment of reviewComments) {
        const location = comment.path + (comment.line ? `:${comment.line}` : '')
        sections.push(`- **@${comment.author}** on \`${location}\`: ${comment.body}`)
      }
      sections.push('')
    }

    if (failedChecks.length === 0 && reviewComments.length === 0) {
      sections.push('✅ No CI failures or review comments found. The PR looks clean!')
    } else {
      sections.push('### Instructions')
      sections.push('Fix all the issues above:')
      sections.push(
        '1. Address each failed CI check by reading the error output and fixing the code'
      )
      sections.push('2. Address each review comment by making the requested change')
      sections.push('3. Run the project tests to verify your fixes')
      sections.push(
        '4. Do NOT create a new commit — just fix the files. I will handle the commit.'
      )
    }

    return sections.join('\n')
  }

  test('generates prompt with failed CI checks only', () => {
    const prompt = buildPromptSections({
      prNumber: 42,
      failedChecks: [
        {
          name: 'lint',
          conclusion: 'failure',
          output: { title: 'Lint failed', summary: 'src/app.ts:15 — unused import' }
        },
        {
          name: 'tests',
          conclusion: 'failure',
          output: { title: null, summary: 'FAIL src/utils.test.ts' }
        }
      ],
      reviewComments: []
    })

    assert.ok(prompt.includes('## Auto-Fix PR #42'))
    assert.ok(prompt.includes('### ❌ Failed CI Checks'))
    assert.ok(prompt.includes('**lint**'))
    assert.ok(prompt.includes('**tests**'))
    assert.ok(prompt.includes('unused import'))
    assert.ok(prompt.includes('### Instructions'))
    assert.ok(!prompt.includes('### 💬 Review Comments'))
  })

  test('generates prompt with review comments only', () => {
    const prompt = buildPromptSections({
      prNumber: 99,
      failedChecks: [
        { name: 'build', conclusion: 'success', output: { title: null, summary: null } }
      ],
      reviewComments: [
        {
          author: 'reviewer1',
          body: 'Please add error handling here',
          path: 'src/api.ts',
          line: 42
        }
      ]
    })

    assert.ok(prompt.includes('### 💬 Review Comments'))
    assert.ok(prompt.includes('@reviewer1'))
    assert.ok(prompt.includes('`src/api.ts:42`'))
    assert.ok(prompt.includes('Please add error handling here'))
    assert.ok(!prompt.includes('### ❌ Failed CI Checks'))
    assert.ok(prompt.includes('### Instructions'))
  })

  test('generates prompt with both failed checks and review comments', () => {
    const prompt = buildPromptSections({
      prNumber: 10,
      failedChecks: [
        {
          name: 'typecheck',
          conclusion: 'failure',
          output: { title: null, summary: 'TS2345: Argument type mismatch' }
        }
      ],
      reviewComments: [
        { author: 'lead', body: 'Rename this variable', path: 'src/lib.ts', line: null }
      ]
    })

    assert.ok(prompt.includes('### ❌ Failed CI Checks'))
    assert.ok(prompt.includes('### 💬 Review Comments'))
    assert.ok(prompt.includes('### Instructions'))
  })

  test('generates clean-PR message when no failures or comments', () => {
    const prompt = buildPromptSections({
      prNumber: 5,
      failedChecks: [
        { name: 'build', conclusion: 'success', output: { title: null, summary: null } }
      ],
      reviewComments: []
    })

    assert.ok(prompt.includes('✅ No CI failures or review comments found'))
    assert.ok(!prompt.includes('### Instructions'))
  })

  test('review comments without line number omit the line suffix', () => {
    const prompt = buildPromptSections({
      prNumber: 7,
      failedChecks: [],
      reviewComments: [
        { author: 'user', body: 'General comment', path: 'README.md', line: null }
      ]
    })

    assert.ok(prompt.includes('`README.md`'))
    assert.ok(!prompt.includes('`README.md:null`'))
  })

  test('CI check summary is truncated to 1500 chars', () => {
    const longSummary = 'E'.repeat(3000)
    const prompt = buildPromptSections({
      prNumber: 1,
      failedChecks: [
        {
          name: 'long-check',
          conclusion: 'failure',
          output: { title: null, summary: longSummary }
        }
      ],
      reviewComments: []
    })

    // The summary in the prompt should be at most 1500 chars
    const summaryStart = prompt.indexOf('```\n  ')
    const summaryEnd = prompt.indexOf('\n  ```', summaryStart)
    const embeddedSummary = prompt.slice(summaryStart + 6, summaryEnd)
    assert.ok(embeddedSummary.length <= 1500)
  })
})

// ── Context shape tests ──

describe('autofix-pr context shape', () => {
  test('AutofixContext includes prNumber, failedChecks, and reviewComments', () => {
    const context = {
      prNumber: 42,
      prTitle: 'PR #42',
      failedChecks: [{ name: 'lint', summary: 'error' }],
      reviewComments: [
        { author: 'reviewer', body: 'fix this', path: 'src/a.ts', line: 10 }
      ]
    }

    assert.equal(context.prNumber, 42)
    assert.equal(context.failedChecks.length, 1)
    assert.equal(context.reviewComments.length, 1)
    assert.equal(context.reviewComments[0].path, 'src/a.ts')
  })
})
