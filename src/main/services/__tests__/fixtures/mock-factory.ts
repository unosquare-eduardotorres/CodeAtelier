import { EventEmitter } from 'node:events'

export interface MockMainWindow {
  webContents: {
    send: (channel: string, ...args: unknown[]) => void
  }
  sentMessages: Array<{ channel: string; data: unknown }>
}

export function createMockMainWindow(): MockMainWindow {
  const sentMessages: Array<{ channel: string; data: unknown }> = []
  return {
    webContents: {
      send: (channel: string, ...args: unknown[]) => {
        sentMessages.push({ channel, data: args[0] })
      }
    },
    sentMessages
  }
}

export interface MockGeneralistService extends EventEmitter {
  decompose: (...args: unknown[]) => Promise<unknown>
  switchMode: (mode: string) => void
  getWorkspacePath: () => string
  getMode: () => string
  getCurrentConversationId: () => string
  removeListener: (event: string, fn: (...args: unknown[]) => void) => this
}

export function createMockGeneralistService(): MockGeneralistService {
  const emitter = new EventEmitter() as MockGeneralistService
  emitter.decompose = async () => ({ conversationId: '', summary: '', mode: 'plan', tasks: [] })
  emitter.switchMode = () => {}
  emitter.getWorkspacePath = () => '/test/workspace'
  emitter.getMode = () => 'plan'
  emitter.getCurrentConversationId = () => 'conv-test-1'
  return emitter
}

export function createMockRepositories() {
  return {
    conversationRepository: {
      findById: (id: string) => ({ id, mode: 'plan', workspaceId: 'ws-1', title: 'Test' }),
      updateMode: (_id: string, _mode: string) => {},
      updateSessionId: (_id: string, _sessionId: string) => {}
    },
    messageRepository: {
      create: (_convId: string, role: string, content: string) => ({ id: `msg-${Date.now()}`, role, contentMd: content }),
      findByConversation: (_convId: string) => []
    },
    specialistRepository: {
      findByAgentId: (id: string) => ({ agentId: id, displayName: id, prompt: 'Specialist prompt', isActive: true }),
      findActive: () => []
    }
  }
}
