import { create } from 'zustand'

export type HelpSection =
  | 'getting-started'
  | 'models'
  | 'repository'
  | 'team'
  | 'ideas'
  | 'memory'
  | 'documents'
  | 'tokens'
  | 'specialists'
  | 'skills'

export interface HelpSectionMeta {
  id: HelpSection
  title: string
  icon: string
  description: string
  order: number
}

/** Registry of all help sections with display metadata */
export const HELP_SECTIONS: HelpSectionMeta[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    icon: 'Rocket',
    description: 'Your first steps with Agent Studio',
    order: 0
  },
  {
    id: 'models',
    title: 'Models',
    icon: 'Cpu',
    description: 'Choose and configure AI models for your workspace',
    order: 1
  },
  {
    id: 'repository',
    title: 'Repository',
    icon: 'GitBranch',
    description: 'Connect your code repository and GitHub account',
    order: 2
  },
  {
    id: 'team',
    title: 'Team',
    icon: 'Users',
    description: 'Manage your AI specialist team',
    order: 3
  },
  {
    id: 'ideas',
    title: 'Ideas',
    icon: 'Lightbulb',
    description: 'Capture and organize project ideas',
    order: 4
  },
  {
    id: 'memory',
    title: 'Memory',
    icon: 'Brain',
    description: 'How Auto Memory keeps your AI agents informed',
    order: 5
  },
  {
    id: 'documents',
    title: 'Documents',
    icon: 'FileText',
    description: 'Attach reference documents to your workspace',
    order: 6
  },
  {
    id: 'tokens',
    title: 'Tokens',
    icon: 'Coins',
    description: 'Understand and monitor token usage',
    order: 7
  },
  {
    id: 'specialists',
    title: 'Specialists',
    icon: 'UserCog',
    description: 'Configure specialist agents for your team',
    order: 8
  },
  {
    id: 'skills',
    title: 'Skills',
    icon: 'Wrench',
    description: 'Add skills and capabilities to your agents',
    order: 9
  }
]

interface HelpState {
  /** Currently active help section */
  activeSection: HelpSection
  /** Whether the user has seen the Getting Started guide */
  hasSeenGettingStarted: boolean
  /** Search query for filtering TOC */
  searchQuery: string

  // Actions
  setActiveSection: (section: HelpSection) => void
  setSearchQuery: (query: string) => void
  initFromStorage: () => void
}

const STORAGE_KEY_SECTION = 'help_last_section'
const STORAGE_KEY_SEEN = 'help_seen_getting_started'

export const useHelpStore = create<HelpState>((set) => ({
  activeSection: 'getting-started',
  hasSeenGettingStarted: false,
  searchQuery: '',

  setActiveSection: (section: HelpSection) => {
    set({ activeSection: section })
    try {
      localStorage.setItem(STORAGE_KEY_SECTION, section)
      if (section === 'getting-started') {
        localStorage.setItem(STORAGE_KEY_SEEN, 'true')
        set({ hasSeenGettingStarted: true })
      }
    } catch {
      // localStorage may be unavailable in some environments
    }
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query })
  },

  initFromStorage: () => {
    try {
      const seen = localStorage.getItem(STORAGE_KEY_SEEN) === 'true'
      const lastSection = localStorage.getItem(STORAGE_KEY_SECTION) as HelpSection | null

      set({
        hasSeenGettingStarted: seen,
        activeSection: seen && lastSection ? lastSection : 'getting-started'
      })

      // Mark as seen on first visit
      if (!seen) {
        localStorage.setItem(STORAGE_KEY_SEEN, 'true')
        set({ hasSeenGettingStarted: true })
      }
    } catch {
      // localStorage may be unavailable
    }
  }
}))
