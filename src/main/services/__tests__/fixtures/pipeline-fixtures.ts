import type { ConversationMode, HandoffBrief } from '../../../../shared/types'

export const VALID_HANDOFF_BLOCK =
  '```handoff\n{\n  "action": "handoff",\n  "summary": "Investigate the auth module for token refresh issues",\n  "specialists": ["dotnet-architect"],\n  "decisions": ["Use refresh token rotation"],\n  "constraints": ["Must maintain backward compatibility"],\n  "filesDiscussed": ["src/auth/token.ts"],\n  "mode": "plan"\n}\n```'

export const MALFORMED_HANDOFF_BLOCK = '```handoff\n{not valid json}\n```'

export const HANDOFF_WITH_BUILD_MODE =
  '```handoff\n{\n  "action": "handoff",\n  "summary": "Review the API",\n  "specialists": ["api-specialist"],\n  "mode": "build"\n}\n```'

export const HANDOFF_WITH_ACTION_VERB =
  '```handoff\n{\n  "action": "handoff",\n  "summary": "Fix the login bug",\n  "specialists": ["qa"],\n  "mode": "plan"\n}\n```'

export const HANDOFF_WITH_IMPLEMENT_VERB =
  '```handoff\n{\n  "action": "handoff",\n  "summary": "Implement the new API",\n  "specialists": ["api-specialist"],\n  "mode": "plan"\n}\n```'

export const HANDOFF_WITH_REVIEW_VERB =
  '```handoff\n{\n  "action": "handoff",\n  "summary": "Review the code quality",\n  "specialists": ["qa"],\n  "mode": "plan"\n}\n```'

export const VALID_DECOMPOSITION_JSON = JSON.stringify({
  tasks: [
    {
      id: 't1',
      specialist: 'dotnet-architect',
      description: 'Review token refresh logic',
      dependsOn: []
    },
    {
      id: 't2',
      specialist: 'testing-specialist',
      description: 'Write regression tests',
      dependsOn: ['t1']
    }
  ]
})

export const DECOMPOSITION_IN_FENCES =
  '```json\n' +
  JSON.stringify({
    tasks: [{ specialist: 'qa', description: 'Run tests' }]
  }) +
  '\n```'

export const DECOMPOSITION_NO_IDS = JSON.stringify({
  tasks: [
    { specialist: 'arch', description: 'Task A' },
    { specialist: 'qa', description: 'Task B' }
  ]
})

export const DECOMPOSITION_MISSING_DEPENDS_ON = JSON.stringify({
  tasks: [{ id: 'x1', specialist: 'qa', description: 'Test', dependsOn: 'not-array' }]
})

export const INVALID_DECOMPOSITION = JSON.stringify({ summary: 'no tasks here' })

export const EMPTY_DECOMPOSITION = JSON.stringify({ tasks: [] })

export const MOCK_BRIEF: HandoffBrief = {
  summary: 'Investigate the auth module',
  decisions: ['Use refresh token rotation'],
  constraints: ['Must maintain backward compatibility'],
  filesDiscussed: ['src/auth/token.ts'],
  recentMessages: [],
  specialists: ['dotnet-architect'],
  mode: 'plan'
}

export const MOCK_CONVERSATION = {
  id: 'conv-test-1',
  mode: 'plan' as ConversationMode,
  workspaceId: 'ws-1',
  title: 'Test conversation'
}

export const MOCK_SPECIALIST = {
  agentId: 'dotnet-architect',
  displayName: '.NET Architect',
  prompt: 'You are a .NET architecture specialist.',
  isActive: true
}
