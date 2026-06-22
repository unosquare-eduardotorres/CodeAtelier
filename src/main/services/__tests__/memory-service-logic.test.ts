/**
 * Unit tests for Memory service pure logic — memory block extraction,
 * type classification, relevance scoring, tag extraction, workspace scope.
 *
 * Phase 14, Track 12a — memory.service.ts (~452 lines at ~25%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Replicated pure logic from MemoryService ──

type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

const VALID_MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference']

/**
 * Replicated from MemoryService type validation (memory.service.ts:152-156).
 */
function isValidMemoryType(type: unknown): type is MemoryType {
  return VALID_MEMORY_TYPES.includes(type as MemoryType)
}

/**
 * Replicated workspace scope determination (memory.service.ts:158-159).
 */
function getMemoryWorkspaceScope(type: MemoryType, workspaceId: string): string | null {
  return type === 'user' || type === 'feedback' ? null : workspaceId
}

/**
 * Replicated tag extraction (memory.service.ts:166).
 */
function extractTags(data: unknown): string[] {
  return Array.isArray(data) ? data : []
}

/**
 * Replicated memory block extraction regex (memory.service.ts:144-146).
 */
function extractMemoryBlocks(text: string): Array<{ raw: string; data: Record<string, unknown> }> {
  const MEMORY_BLOCK_REGEX = /```memory\n([\s\S]*?)```/g
  const blocks: Array<{ raw: string; data: Record<string, unknown> }> = []
  let match: RegExpExecArray | null

  while ((match = MEMORY_BLOCK_REGEX.exec(text)) !== null) {
    try {
      const data = JSON.parse(match[1].trim())
      blocks.push({ raw: match[1].trim(), data })
    } catch {
      // Skip parse errors
    }
  }
  return blocks
}

/**
 * Replicated relevance scoring (memory.service.ts:98-121).
 */
function scoreRelevance(
  memory: { title: string; content: string; tags: string[] },
  messageHint: string
): number {
  const normalizedHint = messageHint
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalizedHint) return 0

  const terms = Array.from(new Set(normalizedHint.split(' '))).filter((term) => term.length >= 3)
  if (terms.length === 0) return 0

  const title = memory.title.toLowerCase()
  const content = memory.content.toLowerCase()
  const tags = memory.tags.join(' ').toLowerCase()

  let score = 0
  for (const term of terms) {
    if (title.includes(term)) score += 3
    if (content.includes(term)) score += 1
    if (tags.includes(term)) score += 2
  }

  return score
}

/**
 * Replicated specialist relevance filter (memory.service.ts:202-206).
 */
function isRelevantToSpecialist(
  memory: { tags: string[]; content: string },
  specialistId: string
): boolean {
  return (
    memory.tags.includes(specialistId) ||
    memory.content.toLowerCase().includes(specialistId.replace('-', ' '))
  )
}

// ── Tests ──

describe('Memory — type classification', () => {
  test('user_is_valid', () => {
    assert.ok(isValidMemoryType('user'))
  })

  test('feedback_is_valid', () => {
    assert.ok(isValidMemoryType('feedback'))
  })

  test('project_is_valid', () => {
    assert.ok(isValidMemoryType('project'))
  })

  test('reference_is_valid', () => {
    assert.ok(isValidMemoryType('reference'))
  })

  test('unknown_type_is_invalid', () => {
    assert.ok(!isValidMemoryType('system'))
    assert.ok(!isValidMemoryType(''))
    assert.ok(!isValidMemoryType(null))
    assert.ok(!isValidMemoryType(undefined))
  })
})

describe('Memory — workspace scope', () => {
  test('user_type_is_global', () => {
    assert.equal(getMemoryWorkspaceScope('user', 'ws-123'), null)
  })

  test('feedback_type_is_global', () => {
    assert.equal(getMemoryWorkspaceScope('feedback', 'ws-123'), null)
  })

  test('project_type_is_workspace_scoped', () => {
    assert.equal(getMemoryWorkspaceScope('project', 'ws-123'), 'ws-123')
  })

  test('reference_type_is_workspace_scoped', () => {
    assert.equal(getMemoryWorkspaceScope('reference', 'ws-456'), 'ws-456')
  })
})

describe('Memory — tag extraction', () => {
  test('array_input_returns_as_is', () => {
    assert.deepEqual(extractTags(['tag1', 'tag2']), ['tag1', 'tag2'])
  })

  test('non_array_input_returns_empty', () => {
    assert.deepEqual(extractTags('not an array'), [])
    assert.deepEqual(extractTags(null), [])
    assert.deepEqual(extractTags(undefined), [])
    assert.deepEqual(extractTags(42), [])
  })

  test('empty_array_returns_empty', () => {
    assert.deepEqual(extractTags([]), [])
  })
})

describe('Memory — block extraction', () => {
  test('extracts_valid_memory_block', () => {
    const text = 'Text before\n```memory\n{"type":"project","title":"Test","content":"Hello"}\n```\nText after'
    const blocks = extractMemoryBlocks(text)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].data.type, 'project')
    assert.equal(blocks[0].data.title, 'Test')
  })

  test('extracts_multiple_blocks', () => {
    const text = [
      '```memory\n{"type":"user","title":"A","content":"x"}\n```',
      'text',
      '```memory\n{"type":"project","title":"B","content":"y"}\n```'
    ].join('\n')
    const blocks = extractMemoryBlocks(text)
    assert.equal(blocks.length, 2)
  })

  test('skips_malformed_json', () => {
    const text = '```memory\n{broken json\n```'
    const blocks = extractMemoryBlocks(text)
    assert.equal(blocks.length, 0)
  })

  test('no_blocks_returns_empty', () => {
    const blocks = extractMemoryBlocks('No memory blocks here')
    assert.equal(blocks.length, 0)
  })
})

describe('Memory — relevance scoring', () => {
  test('title_match_scores_3_points', () => {
    const score = scoreRelevance(
      { title: 'authentication flow', content: '', tags: [] },
      'authentication'
    )
    assert.equal(score, 3)
  })

  test('content_match_scores_1_point', () => {
    const score = scoreRelevance(
      { title: 'other', content: 'handles authentication', tags: [] },
      'authentication'
    )
    assert.equal(score, 1)
  })

  test('tag_match_scores_2_points', () => {
    const score = scoreRelevance(
      { title: 'other', content: '', tags: ['authentication'] },
      'authentication'
    )
    assert.equal(score, 2)
  })

  test('multiple_matches_accumulate', () => {
    const score = scoreRelevance(
      { title: 'authentication', content: 'uses authentication', tags: ['authentication'] },
      'authentication'
    )
    assert.equal(score, 6) // 3 + 1 + 2
  })

  test('empty_hint_returns_0', () => {
    assert.equal(scoreRelevance({ title: 'test', content: '', tags: [] }, ''), 0)
  })

  test('short_terms_under_3_chars_filtered', () => {
    const score = scoreRelevance(
      { title: 'ab cd ef', content: '', tags: [] },
      'ab cd ef'
    )
    assert.equal(score, 0)
  })

  test('case_insensitive_matching', () => {
    const score = scoreRelevance(
      { title: 'Authentication Flow', content: '', tags: [] },
      'AUTHENTICATION'
    )
    assert.equal(score, 3)
  })
})

describe('Memory — specialist relevance', () => {
  test('tag_match_returns_true', () => {
    assert.ok(isRelevantToSpecialist(
      { tags: ['code-reviewer'], content: '' },
      'code-reviewer'
    ))
  })

  test('content_match_with_hyphen_to_space_returns_true', () => {
    assert.ok(isRelevantToSpecialist(
      { tags: [], content: 'This is for the code reviewer specialist' },
      'code-reviewer'
    ))
  })

  test('no_match_returns_false', () => {
    assert.ok(!isRelevantToSpecialist(
      { tags: ['other'], content: 'Unrelated content' },
      'code-reviewer'
    ))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
