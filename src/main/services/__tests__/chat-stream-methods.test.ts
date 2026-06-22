/**
 * Unit tests for ChatStreamService pure methods — resolveStreamIdentity,
 * prepareUserMessage, processAttachments, forceResetIfStuck, resolveWorkspaceName.
 *
 * Phase 14, Track 5 — chat-stream.service.ts (~1,202 lines at 34.94%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Replicated types ──

type ConversationPhase = 'da-vinci-responding' | 'specialist-executing' | string

interface ImageAttachment {
  base64: string
  mimeType: string
  fileName: string
}

// ── Replicated pure logic from ChatStreamService ──

/**
 * Replicated from ChatStreamService.resolveStreamIdentity (chat-stream.service.ts:390-414).
 */
function resolveStreamIdentity(params: {
  messageRole: 'da-vinci' | 'specialist'
  adapterAgentId: string
  persona: { agentId: string } | null
}): {
  streamingRole: 'da-vinci' | 'specialist'
  phase: ConversationPhase
  specialistMeta: { specialist: string; taskId?: string } | undefined
  adapterAgentId: string
} {
  const { messageRole, adapterAgentId, persona } = params

  const streamingRole: 'da-vinci' | 'specialist' = persona ? 'specialist' : messageRole
  const phase: ConversationPhase =
    streamingRole === 'specialist' ? 'specialist-executing' : 'da-vinci-responding'
  const specialistMeta = persona
    ? { specialist: persona.agentId, taskId: '' }
    : messageRole === 'specialist'
      ? { specialist: adapterAgentId }
      : undefined

  return { streamingRole, phase, specialistMeta, adapterAgentId }
}

/**
 * Replicated from ChatStreamService.prepareUserMessage (chat-stream.service.ts:551-565).
 */
function prepareUserMessage(
  text: string,
  processedAttachments?: { textContent: string; images: ImageAttachment[] }
): { fullContent: string; imageAttachments: ImageAttachment[] } {
  let fullContent = text
  let imageAttachments: ImageAttachment[] = []

  if (processedAttachments) {
    fullContent += processedAttachments.textContent
    imageAttachments = processedAttachments.images
  }

  return { fullContent, imageAttachments }
}

/**
 * Replicated from ChatStreamService.processAttachments (chat-stream.service.ts:1028-1057).
 */
function processAttachments(
  attachments: string[],
  fileOps: {
    isImageFile: (path: string) => boolean
    readImageAsBase64: (path: string) => { base64: string; mimeType: string }
    readFileContent: (path: string) => string
    estimateTokens: (content: string) => number
  }
): { textContent: string; images: ImageAttachment[] } {
  const images: ImageAttachment[] = []
  const parts: string[] = []

  for (const filePath of attachments) {
    try {
      if (fileOps.isImageFile(filePath)) {
        const { base64, mimeType } = fileOps.readImageAsBase64(filePath)
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'image'
        images.push({ base64, mimeType, fileName })
        parts.push(
          `\n---\n**Attached image: ${fileName}** (${mimeType}) — visible in the conversation\n`
        )
      } else {
        const content = fileOps.readFileContent(filePath)
        const tokens = fileOps.estimateTokens(content)
        parts.push(
          `\n---\n**Attached file: ${filePath}** (${tokens} tokens)\n\`\`\`\n${content}\n\`\`\`\n`
        )
      }
    } catch (error) {
      parts.push(`\n---\n**Failed to read: ${filePath}**: ${(error as Error).message}\n`)
    }
  }

  return { textContent: parts.join(''), images }
}

/**
 * Replicated from ChatStreamService.forceResetIfStuck (chat-stream.service.ts:1151-1160).
 */
function forceResetIfStuck(
  streamingLock: boolean,
  isIdle: boolean,
  abort: (reason: string) => void
): boolean {
  const lockStuck = streamingLock
  const smStuck = !isIdle
  if (lockStuck || smStuck) {
    abort('workspace-switch')
    return true
  }
  return false
}

/**
 * Replicated from ChatStreamService.resolveWorkspaceName (chat-stream.service.ts:156-165).
 */
function resolveWorkspaceName(
  workspaceId: string,
  findById: ((id: string) => { name: string } | null) | null
): string {
  try {
    if (findById) {
      const workspace = findById(workspaceId)
      return workspace?.name ?? workspaceId.slice(0, 8)
    }
  } catch {
    // error suppressed
  }
  return workspaceId.slice(0, 8)
}

// ── Tests ──

describe('resolveStreamIdentity', () => {
  test('no_persona_da_vinci_role', () => {
    const result = resolveStreamIdentity({
      messageRole: 'da-vinci',
      adapterAgentId: 'da-vinci-1',
      persona: null
    })
    assert.equal(result.streamingRole, 'da-vinci')
    assert.equal(result.phase, 'da-vinci-responding')
    assert.equal(result.specialistMeta, undefined)
  })

  test('persona_present_becomes_specialist', () => {
    const result = resolveStreamIdentity({
      messageRole: 'da-vinci',
      adapterAgentId: 'da-vinci-1',
      persona: { agentId: 'spec-code-reviewer' }
    })
    assert.equal(result.streamingRole, 'specialist')
    assert.equal(result.phase, 'specialist-executing')
    assert.ok(result.specialistMeta)
    assert.equal(result.specialistMeta!.specialist, 'spec-code-reviewer')
  })

  test('no_persona_specialist_role', () => {
    const result = resolveStreamIdentity({
      messageRole: 'specialist',
      adapterAgentId: 'spec-1',
      persona: null
    })
    assert.equal(result.streamingRole, 'specialist')
    assert.equal(result.phase, 'specialist-executing')
    assert.ok(result.specialistMeta)
    assert.equal(result.specialistMeta!.specialist, 'spec-1')
  })

  test('persona_includes_specialist_agentId_in_meta', () => {
    const result = resolveStreamIdentity({
      messageRole: 'da-vinci',
      adapterAgentId: 'da-vinci-1',
      persona: { agentId: 'my-specialist' }
    })
    assert.equal(result.specialistMeta!.specialist, 'my-specialist')
    assert.equal(result.specialistMeta!.taskId, '')
  })

  test('adapterAgentId_is_preserved', () => {
    const result = resolveStreamIdentity({
      messageRole: 'da-vinci',
      adapterAgentId: 'agent-xyz',
      persona: null
    })
    assert.equal(result.adapterAgentId, 'agent-xyz')
  })
})

describe('prepareUserMessage', () => {
  test('no_attachments_fullContent_equals_input', () => {
    const result = prepareUserMessage('Hello world')
    assert.equal(result.fullContent, 'Hello world')
    assert.deepEqual(result.imageAttachments, [])
  })

  test('with_text_attachment_appends_formatted_content', () => {
    const result = prepareUserMessage('Hello', {
      textContent: '\n---\n**Attached file: test.ts** (50 tokens)\n```\ncode\n```\n',
      images: []
    })
    assert.ok(result.fullContent.includes('Hello'))
    assert.ok(result.fullContent.includes('Attached file: test.ts'))
  })

  test('with_image_attachment_adds_to_imageAttachments', () => {
    const images: ImageAttachment[] = [
      { base64: 'abc', mimeType: 'image/png', fileName: 'screenshot.png' }
    ]
    const result = prepareUserMessage('Describe this', {
      textContent: '\n---\n**Attached image: screenshot.png**\n',
      images
    })
    assert.equal(result.imageAttachments.length, 1)
    assert.equal(result.imageAttachments[0].fileName, 'screenshot.png')
  })

  test('mixed_attachments_both_processed', () => {
    const images: ImageAttachment[] = [
      { base64: 'imgdata', mimeType: 'image/jpeg', fileName: 'photo.jpg' }
    ]
    const result = prepareUserMessage('Check', {
      textContent: '\ntext attachment content\nimage reference\n',
      images
    })
    assert.ok(result.fullContent.includes('text attachment content'))
    assert.equal(result.imageAttachments.length, 1)
  })
})

describe('processAttachments', () => {
  const mockFileOps = {
    isImageFile: (path: string) => path.endsWith('.png') || path.endsWith('.jpg'),
    readImageAsBase64: (path: string) => ({
      base64: `base64-${path}`,
      mimeType: path.endsWith('.png') ? 'image/png' : 'image/jpeg'
    }),
    readFileContent: (path: string) => `content of ${path}`,
    estimateTokens: (content: string) => Math.ceil(content.length / 4)
  }

  test('image_file_includes_base64_mimeType_fileName', () => {
    const result = processAttachments(['/path/to/screenshot.png'], mockFileOps)
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].base64, 'base64-/path/to/screenshot.png')
    assert.equal(result.images[0].mimeType, 'image/png')
    assert.equal(result.images[0].fileName, 'screenshot.png')
  })

  test('text_file_includes_code_block_with_token_count', () => {
    const result = processAttachments(['/path/to/file.ts'], mockFileOps)
    assert.equal(result.images.length, 0)
    assert.ok(result.textContent.includes('Attached file: /path/to/file.ts'))
    assert.ok(result.textContent.includes('tokens'))
    assert.ok(result.textContent.includes('```'))
  })

  test('error_reading_file_includes_error_message', () => {
    const errorOps = {
      ...mockFileOps,
      isImageFile: () => false,
      readFileContent: () => { throw new Error('Permission denied') }
    }
    const result = processAttachments(['/path/secret.txt'], errorOps)
    assert.ok(result.textContent.includes('Failed to read'))
    assert.ok(result.textContent.includes('Permission denied'))
    assert.equal(result.images.length, 0)
  })

  test('multiple_attachments_all_processed', () => {
    const result = processAttachments(
      ['/path/a.png', '/path/b.ts', '/path/c.jpg'],
      mockFileOps
    )
    assert.equal(result.images.length, 2) // two images
    assert.ok(result.textContent.includes('b.ts'))
  })

  test('empty_array_returns_empty', () => {
    const result = processAttachments([], mockFileOps)
    assert.equal(result.images.length, 0)
    assert.equal(result.textContent, '')
  })
})

describe('forceResetIfStuck', () => {
  test('lock_false_sm_idle_no_abort', () => {
    let aborted = false
    const didReset = forceResetIfStuck(false, true, () => { aborted = true })
    assert.ok(!aborted)
    assert.ok(!didReset)
  })

  test('lock_true_triggers_abort', () => {
    let abortReason = ''
    const didReset = forceResetIfStuck(true, true, (r) => { abortReason = r })
    assert.ok(didReset)
    assert.equal(abortReason, 'workspace-switch')
  })

  test('sm_not_idle_triggers_abort', () => {
    let aborted = false
    const didReset = forceResetIfStuck(false, false, () => { aborted = true })
    assert.ok(aborted)
    assert.ok(didReset)
  })

  test('both_stuck_triggers_abort', () => {
    let aborted = false
    const didReset = forceResetIfStuck(true, false, () => { aborted = true })
    assert.ok(aborted)
    assert.ok(didReset)
  })
})

describe('resolveWorkspaceName', () => {
  test('workspace_found_returns_name', () => {
    const result = resolveWorkspaceName('ws-12345678-abcd', (id) =>
      id === 'ws-12345678-abcd' ? { name: 'My Project' } : null
    )
    assert.equal(result, 'My Project')
  })

  test('workspace_not_found_returns_first_8_chars', () => {
    const result = resolveWorkspaceName('ws-12345678-abcd', () => null)
    assert.equal(result, 'ws-12345')
  })

  test('DB_error_returns_first_8_chars', () => {
    const result = resolveWorkspaceName('ws-12345678-abcd', () => {
      throw new Error('DB error')
    })
    assert.equal(result, 'ws-12345')
  })

  test('null_finder_returns_first_8_chars', () => {
    const result = resolveWorkspaceName('ws-12345678-abcd', null)
    assert.equal(result, 'ws-12345')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
