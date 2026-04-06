import log from 'electron-log/main'

const abandonmentLogger = log.scope('Abandonment')

/**
 * Patterns that indicate a specialist is "giving up" rather than completing the task.
 * These are checked against the final accumulated output of a specialist process.
 */
const ABANDONMENT_PATTERNS: RegExp[] = [
  /I cannot complete this/i,
  /I am unable to/i,
  /this is beyond my/i,
  /I give up/i,
  /I['']m stuck/i,
  /you should try/i,
  /you['']ll need to manually/i,
  /I cannot figure out/i,
  /this requires manual/i,
  /I recommend you do this yourself/i,
  /unfortunately.{0,30}(?:cannot|unable|impossible)/i,
  /not possible for me to/i,
  /I was unable to complete/i,
  /I could not (?:find|resolve|fix|complete|implement)/i,
  /this task (?:is|seems) impossible/i,
  /beyond (?:my|the) (?:scope|capability|abilities)/i,
  /I don['']t (?:know|understand) how to/i
]

/**
 * Phrases that are NOT abandonment (avoid false positives).
 * If these appear near a detected pattern, we skip the detection.
 */
const FALSE_POSITIVE_GUARDS: RegExp[] = [
  /I fixed/i,
  /I resolved/i,
  /I completed/i,
  /successfully/i,
  /all tests pass/i,
  /build succeeded/i,
  /the issue was/i,
  /here['']s what I did/i
]

interface AbandonmentResult {
  detected: boolean
  pattern?: string
  /** Last N characters of output where pattern was found */
  context?: string
}

/**
 * Detects abandonment patterns in specialist output.
 *
 * Checks the last portion of output (where conclusions typically appear)
 * for give-up language, while filtering out false positives.
 */
export function detectAbandonment(output: string): AbandonmentResult {
  if (!output || output.length < 20) {
    return { detected: false }
  }

  // Focus on the last 3000 chars — conclusions appear at the end
  const tail = output.slice(-3000)

  for (const pattern of ABANDONMENT_PATTERNS) {
    const match = tail.match(pattern)
    if (match) {
      // Check for false positive guards in the same region
      const matchIndex = match.index ?? 0
      const surroundingText = tail.slice(
        Math.max(0, matchIndex - 200),
        Math.min(tail.length, matchIndex + 500)
      )

      const isFalsePositive = FALSE_POSITIVE_GUARDS.some((guard) => guard.test(surroundingText))
      if (isFalsePositive) {
        continue
      }

      abandonmentLogger.warn(`Abandonment detected: "${match[0]}"`)
      return {
        detected: true,
        pattern: match[0],
        context: surroundingText.slice(0, 300)
      }
    }
  }

  return { detected: false }
}

/**
 * Quality gate patterns — detects test/lint/build results in specialist output.
 */
export interface QualityGateResult {
  type: 'test' | 'lint' | 'typecheck' | 'build'
  passed: boolean
  summary: string
}

/**
 * Parses specialist output for quality gate results (test/lint/build pass/fail).
 * Returns all detected gates.
 */
export function detectQualityGates(output: string): QualityGateResult[] {
  if (!output || output.length < 10) return []

  const gates: QualityGateResult[] = []

  // Test results
  const testPassMatch = output.match(
    /(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?(?:.*?(\d+)\s+(?:tests?\s+)?fail(?:ed|ing)?)?/i
  )
  const testFailMatch = output.match(/(\d+)\s+(?:tests?\s+)?fail(?:ed|ing)/i)
  if (testFailMatch) {
    const failCount = parseInt(testFailMatch[1], 10)
    if (failCount > 0) {
      gates.push({
        type: 'test',
        passed: false,
        summary: `${failCount} test(s) failing`
      })
    }
  } else if (testPassMatch) {
    gates.push({
      type: 'test',
      passed: true,
      summary: `${testPassMatch[1]} test(s) passing`
    })
  }

  // TypeScript errors
  const tsErrorMatch = output.match(/Found (\d+) error/i)
  const tsErrorMatch2 = output.match(/error TS\d+/g)
  if (tsErrorMatch) {
    const count = parseInt(tsErrorMatch[1], 10)
    gates.push({
      type: 'typecheck',
      passed: count === 0,
      summary: count > 0 ? `${count} TypeScript error(s)` : 'TypeScript check passed'
    })
  } else if (tsErrorMatch2 && tsErrorMatch2.length > 0) {
    gates.push({
      type: 'typecheck',
      passed: false,
      summary: `${tsErrorMatch2.length} TypeScript error(s)`
    })
  }

  // ESLint errors
  const lintErrorMatch = output.match(/(\d+)\s+error/i)
  const lintProblemsMatch = output.match(/\u2716\s*(\d+)\s+problem.*?(\d+)\s+error/i)
  if (lintProblemsMatch) {
    const errorCount = parseInt(lintProblemsMatch[2], 10)
    gates.push({
      type: 'lint',
      passed: errorCount === 0,
      summary: errorCount > 0 ? `${errorCount} lint error(s)` : 'Lint check passed'
    })
  } else if (lintErrorMatch) {
    // Only flag lint if it looks like a lint report, not generic error counts
    const context = output.slice(
      Math.max(0, (lintErrorMatch.index ?? 0) - 100),
      (lintErrorMatch.index ?? 0) + 200
    )
    if (/eslint|lint|warning/i.test(context)) {
      const count = parseInt(lintErrorMatch[1], 10)
      gates.push({
        type: 'lint',
        passed: count === 0,
        summary: count > 0 ? `${count} lint error(s)` : 'Lint check passed'
      })
    }
  }

  // Build results
  if (/build\s+(?:succeeded|successful|complete)/i.test(output)) {
    gates.push({ type: 'build', passed: true, summary: 'Build succeeded' })
  } else if (/build\s+(?:failed|error)|compilation\s+failed|error during build/i.test(output)) {
    gates.push({ type: 'build', passed: false, summary: 'Build failed' })
  }

  return gates
}
