import mermaid from 'mermaid'
import { JSDOM } from 'jsdom'

class MermaidService {
  private initialized = false

  private async ensureInit(): Promise<void> {
    if (this.initialized) return

    // Provide a minimal DOM for mermaid (it requires DOM APIs)
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>')
    global.window = dom.window as unknown as Window & typeof globalThis
    global.document = dom.window.document
    global.navigator = dom.window.navigator

    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      fontFamily: 'ui-monospace, monospace'
    })
    this.initialized = true
  }

  async render(definition: string, id?: string): Promise<{ svg: string }> {
    await this.ensureInit()
    const diagramId = id ?? `mermaid-${Date.now()}`
    const { svg } = await mermaid.render(diagramId, definition.trim())
    return { svg }
  }
}

export const mermaidService = new MermaidService()
