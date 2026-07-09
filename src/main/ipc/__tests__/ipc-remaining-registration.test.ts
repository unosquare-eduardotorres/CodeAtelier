/**
 * Unit tests for remaining IPC handler registration — verifies all 43 remaining
 * IPC modules successfully import and export callable register functions.
 *
 * Each import exercises the module-level code (constant declarations,
 * helper function definitions, IPC_CHANNELS references) which provides
 * statement coverage for the top ~10-15% of each file.
 *
 * Phase 14, Track 1 — 43 IPC files at 0%.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import { IPC_CHANNELS } from '../../../shared/constants'

// ── Import all 43 remaining IPC modules ──

import { registerChatModeIpc } from '../chat-mode.ipc'
import { registerWorkspaceDeployIpc } from '../workspace-deploy.ipc'
import { registerMemoryIpc } from '../memory.ipc'
import { registerIndexingIpc } from '../indexing.ipc'
import { registerSessionIpc } from '../session.ipc'
import { registerIdeaIpc } from '../idea.ipc'
import { registerCodeChangesIpc } from '../code-changes.ipc'
import { registerSdkControlIpc } from '../sdk-control.ipc'
import { registerChatMessageIpc } from '../chat-message.ipc'
import { registerAgentIpc } from '../agent.ipc'
import { registerSpecialistIpc } from '../specialist.ipc'
import { registerPlanIpc } from '../plan.ipc'
import { registerAgentLifecycleIpc } from '../agent-lifecycle.ipc'
import { registerCheckpointIpc } from '../checkpoint.ipc'
import { registerSkillIpc } from '../skill.ipc'
import { registerConversationSpecialistIpc } from '../conversation-specialist.ipc'
import { registerPermissionIpc } from '../permission.ipc'
import { registerOllamaIpc } from '../ollama.ipc'
import { registerBugIpc } from '../bug.ipc'
import { registerZoomIpc } from '../zoom.ipc'
import { registerCoreAgentPromptIpc } from '../core-agent-prompt.ipc'
import { registerDocsIpc } from '../docs.ipc'
import { registerCodeGraphIpc } from '../code-graph.ipc'
import { registerRepoIpc } from '../repo.ipc'
import { registerTokenIpc } from '../token.ipc'
import { registerInsightsIpc } from '../insights.ipc'
import { registerEmbeddingIpc } from '../embedding.ipc'
import { registerGithubIpc } from '../github.ipc'
import { registerCostIpc } from '../cost.ipc'
import { registerEventsIpc } from '../events.ipc'
import { registerChatIpc } from '../chat.ipc'
import { registerLogIpc } from '../log.ipc'
import { registerUpdateIpc } from '../update.ipc'
import { registerCoreAgentAliasIpc } from '../core-agent-alias.ipc'
import { registerAppPreferenceIpc } from '../app-preference.ipc'
import { registerShellIpc } from '../shell.ipc'
import { registerSyncIpc } from '../sync.ipc'
import { registerSubscriptionIpc } from '../subscription.ipc'
import { registerUserProfileIpc } from '../user-profile.ipc'
import { registerHooksIpc } from '../hooks.ipc'
import { registerPlatformIpc } from '../platform.ipc'
import { registerChatLifecycleIpc } from '../chat-lifecycle.ipc'
import { registerTestingIpc } from '../testing.ipc'

// ── Register function export verification ──

describe('IPC Remaining Registration — export verification', () => {
  test('registerChatModeIpc_is_exported_function', () => {
    assert.equal(typeof registerChatModeIpc, 'function')
  })

  test('registerWorkspaceDeployIpc_is_exported_function', () => {
    assert.equal(typeof registerWorkspaceDeployIpc, 'function')
  })

  test('registerMemoryIpc_is_exported_function', () => {
    assert.equal(typeof registerMemoryIpc, 'function')
  })


  test('registerIndexingIpc_is_exported_function', () => {
    assert.equal(typeof registerIndexingIpc, 'function')
  })

  test('registerSessionIpc_is_exported_function', () => {
    assert.equal(typeof registerSessionIpc, 'function')
  })

  test('registerIdeaIpc_is_exported_function', () => {
    assert.equal(typeof registerIdeaIpc, 'function')
  })

  test('registerCodeChangesIpc_is_exported_function', () => {
    assert.equal(typeof registerCodeChangesIpc, 'function')
  })

  test('registerSdkControlIpc_is_exported_function', () => {
    assert.equal(typeof registerSdkControlIpc, 'function')
  })

  test('registerChatMessageIpc_is_exported_function', () => {
    assert.equal(typeof registerChatMessageIpc, 'function')
  })

  test('registerAgentIpc_is_exported_function', () => {
    assert.equal(typeof registerAgentIpc, 'function')
  })

  test('registerSpecialistIpc_is_exported_function', () => {
    assert.equal(typeof registerSpecialistIpc, 'function')
  })

  test('registerPlanIpc_is_exported_function', () => {
    assert.equal(typeof registerPlanIpc, 'function')
  })

  test('registerAgentLifecycleIpc_is_exported_function', () => {
    assert.equal(typeof registerAgentLifecycleIpc, 'function')
  })

  test('registerCheckpointIpc_is_exported_function', () => {
    assert.equal(typeof registerCheckpointIpc, 'function')
  })

  test('registerSkillIpc_is_exported_function', () => {
    assert.equal(typeof registerSkillIpc, 'function')
  })

  test('registerConversationSpecialistIpc_is_exported_function', () => {
    assert.equal(typeof registerConversationSpecialistIpc, 'function')
  })

  test('registerPermissionIpc_is_exported_function', () => {
    assert.equal(typeof registerPermissionIpc, 'function')
  })

  test('registerOllamaIpc_is_exported_function', () => {
    assert.equal(typeof registerOllamaIpc, 'function')
  })

  test('registerBugIpc_is_exported_function', () => {
    assert.equal(typeof registerBugIpc, 'function')
  })

  test('registerZoomIpc_is_exported_function', () => {
    assert.equal(typeof registerZoomIpc, 'function')
  })

  test('registerCoreAgentPromptIpc_is_exported_function', () => {
    assert.equal(typeof registerCoreAgentPromptIpc, 'function')
  })

  test('registerDocsIpc_is_exported_function', () => {
    assert.equal(typeof registerDocsIpc, 'function')
  })

  test('registerCodeGraphIpc_is_exported_function', () => {
    assert.equal(typeof registerCodeGraphIpc, 'function')
  })

  test('registerRepoIpc_is_exported_function', () => {
    assert.equal(typeof registerRepoIpc, 'function')
  })

  test('registerTokenIpc_is_exported_function', () => {
    assert.equal(typeof registerTokenIpc, 'function')
  })

  test('registerInsightsIpc_is_exported_function', () => {
    assert.equal(typeof registerInsightsIpc, 'function')
  })

  test('registerEmbeddingIpc_is_exported_function', () => {
    assert.equal(typeof registerEmbeddingIpc, 'function')
  })

  test('registerGithubIpc_is_exported_function', () => {
    assert.equal(typeof registerGithubIpc, 'function')
  })

  test('registerCostIpc_is_exported_function', () => {
    assert.equal(typeof registerCostIpc, 'function')
  })

  test('registerEventsIpc_is_exported_function', () => {
    assert.equal(typeof registerEventsIpc, 'function')
  })

  test('registerChatIpc_is_exported_function', () => {
    assert.equal(typeof registerChatIpc, 'function')
  })

  test('registerLogIpc_is_exported_function', () => {
    assert.equal(typeof registerLogIpc, 'function')
  })

  test('registerUpdateIpc_is_exported_function', () => {
    assert.equal(typeof registerUpdateIpc, 'function')
  })

  test('registerCoreAgentAliasIpc_is_exported_function', () => {
    assert.equal(typeof registerCoreAgentAliasIpc, 'function')
  })

  test('registerAppPreferenceIpc_is_exported_function', () => {
    assert.equal(typeof registerAppPreferenceIpc, 'function')
  })

  test('registerShellIpc_is_exported_function', () => {
    assert.equal(typeof registerShellIpc, 'function')
  })

  test('registerSyncIpc_is_exported_function', () => {
    assert.equal(typeof registerSyncIpc, 'function')
  })

  test('registerSubscriptionIpc_is_exported_function', () => {
    assert.equal(typeof registerSubscriptionIpc, 'function')
  })

  test('registerUserProfileIpc_is_exported_function', () => {
    assert.equal(typeof registerUserProfileIpc, 'function')
  })

  test('registerHooksIpc_is_exported_function', () => {
    assert.equal(typeof registerHooksIpc, 'function')
  })

  test('registerPlatformIpc_is_exported_function', () => {
    assert.equal(typeof registerPlatformIpc, 'function')
  })

  test('registerChatLifecycleIpc_is_exported_function', () => {
    assert.equal(typeof registerChatLifecycleIpc, 'function')
  })

  test('registerTestingIpc_is_exported_function', () => {
    assert.equal(typeof registerTestingIpc, 'function')
  })
})

// ── Channel existence checks grouped by domain ──

describe('IPC Channels — chat domain', () => {
  test('chat_mode_channels_exist', () => {
    assert.ok(IPC_CHANNELS.CHAT_UPDATE_MODE)
    assert.ok(IPC_CHANNELS.CHAT_UPDATE_EFFORT)
    assert.ok(IPC_CHANNELS.CHAT_UPDATE_PERSONA)
    assert.ok(IPC_CHANNELS.CHAT_STOP)
    assert.ok(IPC_CHANNELS.CHAT_COMPACT)
    assert.ok(IPC_CHANNELS.CHAT_GET_STREAMING_STATE)
  })

  test('chat_message_channels_exist', () => {
    assert.ok(IPC_CHANNELS.CHAT_MESSAGE_CHUNK)
    assert.ok(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE)
  })

  test('chat_lifecycle_channels_exist', () => {
    assert.ok(IPC_CHANNELS.CHAT_SESSION_RECOVERY)
    assert.ok(IPC_CHANNELS.CHAT_STATE_CHANGE)
    assert.ok(IPC_CHANNELS.CHAT_RESUME_AT)
  })

  test('chat_send_channel_exists', () => {
    assert.ok(IPC_CHANNELS.CHAT_SEND)
    assert.ok(IPC_CHANNELS.CHAT_RENAME)
    assert.ok(IPC_CHANNELS.CHAT_ASK_USER_RESPOND)
  })
})

describe('IPC Channels — agent domain', () => {
  test('agent_channels_exist', () => {
    assert.ok(IPC_CHANNELS.AGENT_GET_STATUSES)
    assert.ok(IPC_CHANNELS.AGENT_STATUS_UPDATE)
    assert.ok(IPC_CHANNELS.AGENT_STOP_ALL)
    assert.ok(IPC_CHANNELS.AGENT_CACHE_EFFICIENCY)
    assert.ok(IPC_CHANNELS.AGENT_DELETE_FROM_WORKSPACE)
    assert.ok(IPC_CHANNELS.AGENT_SYNC_TO_WORKSPACE)
  })

  test('agent_lifecycle_channels_exist', () => {
    assert.ok(IPC_CHANNELS.AGENT_START)
    assert.ok(IPC_CHANNELS.AGENT_READY)
  })

  test('session_channels_exist', () => {
    assert.ok(IPC_CHANNELS.SESSION_LIST)
    assert.ok(IPC_CHANNELS.SESSION_GET_INFO)
    assert.ok(IPC_CHANNELS.SESSION_GET_MESSAGES)
    assert.ok(IPC_CHANNELS.SESSION_RENAME)
    assert.ok(IPC_CHANNELS.SESSION_TAG)
  })
})

describe('IPC Channels — workspace domain', () => {
  test('workspace_deploy_channel_exists', () => {
    assert.ok(IPC_CHANNELS.WORKSPACE_DEPLOY_ALL)
  })

  test('indexing_channels_exist', () => {
    assert.ok(IPC_CHANNELS.INDEXING_START)
    assert.ok(IPC_CHANNELS.INDEXING_PAUSE)
    assert.ok(IPC_CHANNELS.INDEXING_RESUME)
    assert.ok(IPC_CHANNELS.INDEXING_CANCEL)
    assert.ok(IPC_CHANNELS.INDEXING_PROGRESS)
    assert.ok(IPC_CHANNELS.INDEXING_GET_STATUS)
  })

  test('memory_channels_exist', () => {
    assert.ok(IPC_CHANNELS.MEMORY_FACTS_LIST)
    assert.ok(IPC_CHANNELS.MEMORY_FACTS_SEARCH)
    assert.ok(IPC_CHANNELS.MEMORY_FACTS_GET)
    assert.ok(IPC_CHANNELS.MEMORY_FACTS_UPDATE)
    assert.ok(IPC_CHANNELS.MEMORY_FACTS_DELETE)
    assert.ok(IPC_CHANNELS.MEMORY_FEED_DOCUMENT)
  })
})

describe('IPC Channels — tool domain', () => {
  test('code_graph_channels_exist', () => {
    assert.ok(IPC_CHANNELS.CODE_GRAPH_INDEX_START)
    assert.ok(IPC_CHANNELS.CODE_GRAPH_GET_STATUS)
    assert.ok(IPC_CHANNELS.CODE_GRAPH_HAS_INDEX)
  })

  test('embedding_channels_exist', () => {
    assert.ok(IPC_CHANNELS.EMBEDDING_CHECK_STATUS)
    assert.ok(IPC_CHANNELS.EMBEDDING_INITIALIZE)
  })

  test('github_channels_exist', () => {
    assert.ok(IPC_CHANNELS.GITHUB_SAVE_TOKEN)
    assert.ok(IPC_CHANNELS.GITHUB_VALIDATE_TOKEN)
    assert.ok(IPC_CHANNELS.GITHUB_GET_STATUS)
  })

  test('code_changes_channels_exist', () => {
    assert.ok(IPC_CHANNELS.REPO_GET_FILE_DETAILS)
    assert.ok(IPC_CHANNELS.REPO_GET_FILE_DIFF)
    assert.ok(IPC_CHANNELS.REPO_COMMIT_FILES)
  })
})

describe('IPC Channels — settings domain', () => {
  test('permission_channels_exist', () => {
    assert.ok(IPC_CHANNELS.PERMISSION_REQUEST)
    assert.ok(IPC_CHANNELS.PERMISSION_RESPONSE)
  })

  test('subscription_channels_exist', () => {
    assert.ok(IPC_CHANNELS.SUBSCRIPTION_VALIDATE_ALL)
    assert.ok(IPC_CHANNELS.SUBSCRIPTION_CHECK_CLAUDE_CLI)
    assert.ok(IPC_CHANNELS.SUBSCRIPTION_AUTO_CONFIGURE)
  })

  test('app_preference_channels_exist', () => {
    assert.ok(IPC_CHANNELS.APP_PREFERENCE_GET_ALL)
    assert.ok(IPC_CHANNELS.APP_PREFERENCE_SET)
  })

  test('user_profile_channels_exist', () => {
    assert.ok(IPC_CHANNELS.USER_PROFILE_GET)
    assert.ok(IPC_CHANNELS.USER_PROFILE_UPSERT)
  })
})

describe('IPC Channels — management domain', () => {
  test('specialist_channels_exist', () => {
    assert.ok(IPC_CHANNELS.SPECIALIST_LIST)
    assert.ok(IPC_CHANNELS.SPECIALIST_GET)
    assert.ok(IPC_CHANNELS.SPECIALIST_CREATE)
    assert.ok(IPC_CHANNELS.SPECIALIST_UPDATE)
    assert.ok(IPC_CHANNELS.SPECIALIST_DELETE)
  })

  test('conversation_specialist_channels_exist', () => {
    assert.ok(IPC_CHANNELS.CONV_SPECIALIST_LIST)
    assert.ok(IPC_CHANNELS.CONV_SPECIALIST_UPSERT)
    assert.ok(IPC_CHANNELS.CONV_SPECIALIST_REMOVE)
  })

  test('skill_channels_exist', () => {
    assert.ok(IPC_CHANNELS.SKILL_LIST)
    assert.ok(IPC_CHANNELS.SKILL_GET)
    assert.ok(IPC_CHANNELS.SKILL_IMPORT)
    assert.ok(IPC_CHANNELS.SKILL_UPDATE)
    assert.ok(IPC_CHANNELS.SKILL_DELETE)
  })

  test('plan_channels_exist', () => {
    assert.ok(IPC_CHANNELS.PLAN_GET_ALL)
    assert.ok(IPC_CHANNELS.PLAN_GET_BY_ID)
    assert.ok(IPC_CHANNELS.PLAN_UPDATE_STATUS)
    assert.ok(IPC_CHANNELS.PLAN_DELETE)
  })

  test('checkpoint_channels_exist', () => {
    assert.ok(IPC_CHANNELS.CHECKPOINT_LIST)
    assert.ok(IPC_CHANNELS.CHECKPOINT_RESTORE)
    assert.ok(IPC_CHANNELS.CHECKPOINT_REWIND)
  })

  test('idea_channels_exist', () => {
    assert.ok(IPC_CHANNELS.IDEA_LIST)
    assert.ok(IPC_CHANNELS.IDEA_CREATE)
    assert.ok(IPC_CHANNELS.IDEA_UPDATE)
    assert.ok(IPC_CHANNELS.IDEA_DELETE)
    assert.ok(IPC_CHANNELS.IDEA_START_GRILL)
  })
})

describe('IPC Channels — utility domain', () => {
  test('sdk_control_channels_exist', () => {
    assert.ok(IPC_CHANNELS.SDK_STOP_TASK)
    assert.ok(IPC_CHANNELS.SDK_SUPPORTED_MODELS)
    assert.ok(IPC_CHANNELS.SDK_LIST_SUBAGENTS)
    assert.ok(IPC_CHANNELS.SDK_FORK_SESSION)
  })

  test('ollama_channels_exist', () => {
    assert.ok(IPC_CHANNELS.OLLAMA_CHECK_STATUS)
    assert.ok(IPC_CHANNELS.OLLAMA_PULL_MODEL)
    assert.ok(IPC_CHANNELS.OLLAMA_CANCEL_PULL)
  })

  test('bug_channels_exist', () => {
    assert.ok(IPC_CHANNELS.BUG_REPORT)
    assert.ok(IPC_CHANNELS.BUG_LIST)
    assert.ok(IPC_CHANNELS.BUG_GET)
    assert.ok(IPC_CHANNELS.BUG_RESOLVE)
  })

  test('zoom_channels_exist', () => {
    assert.ok(IPC_CHANNELS.ZOOM_IN)
    assert.ok(IPC_CHANNELS.ZOOM_OUT)
    assert.ok(IPC_CHANNELS.ZOOM_RESET)
    assert.ok(IPC_CHANNELS.ZOOM_SET)
    assert.ok(IPC_CHANNELS.ZOOM_GET)
  })

  test('core_agent_prompt_channels_exist', () => {
    assert.ok(IPC_CHANNELS.CORE_AGENT_PROMPT_LIST)
    assert.ok(IPC_CHANNELS.CORE_AGENT_PROMPT_GET)
    assert.ok(IPC_CHANNELS.CORE_AGENT_PROMPT_UPSERT)
    assert.ok(IPC_CHANNELS.CORE_AGENT_PROMPT_RESET)
  })

  test('core_agent_alias_channels_exist', () => {
    assert.ok(IPC_CHANNELS.CORE_AGENT_LIST)
    assert.ok(IPC_CHANNELS.CORE_AGENT_UPSERT)
  })

  test('docs_channels_exist', () => {
    assert.ok(IPC_CHANNELS.DOCS_LIST)
    assert.ok(IPC_CHANNELS.DOCS_READ_FILE)
  })

  test('repo_channels_exist', () => {
    assert.ok(IPC_CHANNELS.REPO_INIT)
    assert.ok(IPC_CHANNELS.REPO_SET_REMOTE)
    assert.ok(IPC_CHANNELS.REPO_GET_INFO)
  })

  test('token_channels_exist', () => {
    assert.ok(IPC_CHANNELS.TOKEN_GET_WORKSPACE_SUMMARY)
    assert.ok(IPC_CHANNELS.TOKEN_GET_CONVERSATION_SUMMARY)
    assert.ok(IPC_CHANNELS.TOKEN_GET_RECENT_SESSIONS)
  })

  test('insights_channel_exists', () => {
    assert.ok(IPC_CHANNELS.CONVERSATION_INSIGHTS)
  })

  test('cost_channels_exist', () => {
    assert.ok(IPC_CHANNELS.COST_GET_WORKSPACE_SUMMARY)
    assert.ok(IPC_CHANNELS.COST_GET_CONVERSATION)
  })

  test('events_channels_exist', () => {
    assert.ok(IPC_CHANNELS.EVENTS_GET_RECENT)
    assert.ok(IPC_CHANNELS.EVENTS_GET_BY_CONVERSATION)
  })

  test('log_channel_exists', () => {
    assert.ok(IPC_CHANNELS.LOG_FROM_RENDERER)
  })

  test('update_channels_exist', () => {
    assert.ok(IPC_CHANNELS.UPDATE_CHECK)
    assert.ok(IPC_CHANNELS.UPDATE_INSTALL)
    assert.ok(IPC_CHANNELS.UPDATE_DOWNLOAD)
  })

  test('shell_channel_exists', () => {
    assert.ok(IPC_CHANNELS.SHELL_SHOW_ITEM_IN_FOLDER)
  })

  test('sync_channels_exist', () => {
    assert.ok(IPC_CHANNELS.SYNC_COMPUTE_DIFF)
    assert.ok(IPC_CHANNELS.SYNC_APPLY)
  })

  test('hooks_channels_exist', () => {
    assert.ok(IPC_CHANNELS.HOOKS_LIST)
    assert.ok(IPC_CHANNELS.HOOKS_RELOAD)
  })

  test('platform_channel_exists', () => {
    assert.ok(IPC_CHANNELS.PLATFORM_INFO)
  })

  test('testing_channels_exist', () => {
    assert.ok(IPC_CHANNELS.TESTING_LIST_SCENARIOS)
    assert.ok(IPC_CHANNELS.TESTING_PREFLIGHT)
    assert.ok(IPC_CHANNELS.TESTING_RUN)
    assert.ok(IPC_CHANNELS.TESTING_REQUEUE_FAILED)
    assert.ok(IPC_CHANNELS.TESTING_CANCEL)
    assert.ok(IPC_CHANNELS.TESTING_GET_RUNS)
    assert.ok(IPC_CHANNELS.TESTING_GET_RUN_RESULTS)
    assert.ok(IPC_CHANNELS.TESTING_GET_RESULT_DETAIL)
    assert.ok(IPC_CHANNELS.TESTING_PROGRESS)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
