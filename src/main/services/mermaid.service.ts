import { JSDOM } from 'jsdom'
import { sanitizeMermaid } from '../../shared/mermaid-sanitizers'

class MermaidService {
  private initialized = false
  private mermaid: typeof import('mermaid').default | null = null

  private async ensureInit(): Promise<void> {
    if (this.initialized) return

    // Provide a minimal DOM for mermaid (it requires DOM APIs).
    // IMPORTANT: JSDOM globals MUST be set BEFORE importing mermaid.
    // Mermaid v11 bundles DOMPurify which initializes at module-load time
    // by calling getGlobal() to find window/document. If those globals are
    // missing when the module loads, DOMPurify returns a stub without
    // sanitize(), causing "DOMPurify.sanitize is not a function" errors.
    //
    // Node 24+ exposes globalThis.navigator as a read-only getter,
    // so we use Object.defineProperty to override it for JSDOM compatibility.
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>')
    global.window = dom.window as unknown as Window & typeof globalThis
    global.document = dom.window.document
    Object.defineProperty(global, 'navigator', {
      value: dom.window.navigator,
      writable: true,
      configurable: true
    })

    // Dynamic import so mermaid's bundled DOMPurify sees the JSDOM globals
    // Mermaid v11 is ESM-only. When electron-vite bundles it into CJS for the
    // main process, the default export ends up nested under `.default`.
    const mermaidModule = await import('mermaid')
    const mermaidDefault = mermaidModule.default
    this.mermaid =
      (mermaidDefault as unknown as { default: typeof mermaidDefault }).default ?? mermaidDefault

    this.mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'strict',
      fontFamily: "'Inter', 'JetBrains Mono', sans-serif",
      themeVariables: {
        primaryColor: '#0d1117',
        primaryTextColor: '#c0caf5',
        primaryBorderColor: '#73daca',
        lineColor: '#73daca',
        secondaryColor: '#0d1117',
        tertiaryColor: '#0d1117',
        background: 'transparent',
        mainBkg: '#0d1117',
        nodeBorder: '#73daca',
        fontFamily: "'Inter', sans-serif",
        fontSize: '13px'
      }
    })

    // Register Lucide icon pack for @{} icon nodes
    this.mermaid.registerIconPacks([
      {
        name: 'lucide',
        loader: () => import('@iconify-json/lucide').then((module) => module.icons)
      }
    ])

    this.initialized = true
  }

  async render(definition: string, id?: string): Promise<{ svg: string }> {
    await this.ensureInit()
    const diagramId = id ?? `mermaid-${Date.now()}`
    const { svg } = await this.mermaid!.render(diagramId, sanitizeMermaid(definition))
    return { svg }
  }
}

export const mermaidService = new MermaidService()
