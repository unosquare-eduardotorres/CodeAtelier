/**
 * Mermaid diagram sanitizers for LLM-generated output.
 *
 * Pure string→string transforms with no DOM or framework dependency.
 * Used by both the renderer (MermaidDiagram.tsx) and the backend (mermaid.service.ts).
 */

/**
 * Map deprecated Lucide icon names to their current equivalents.
 * Lucide renamed many icons in v0.3xx+; LLMs trained on older docs
 * still generate the old names.
 */
export const ICON_ALIASES: Record<string, string> = {
  'alert-triangle': 'triangle-alert',
  'alert-circle': 'circle-alert',
  'alert-octagon': 'octagon-alert',
  'edit': 'square-pen',
  'edit-2': 'pencil',
  'edit-3': 'pencil',
  'home': 'house',
  'layout': 'layout-grid',
  'send': 'send-horizontal',
  'trash-2': 'trash',
  'external-link': 'square-arrow-out-up-right',
}

/**
 * Split multiple @{} icon nodes crammed onto the same line.
 * LLMs often concatenate them: A@{ ... }B@{ ... } — must be one per line.
 * Also splits arrows trailing an @{} node onto a new line.
 */
export function splitIconNodeLines(definition: string): string {
  // Case 1: }NodeId@{  (no separator — direct concatenation)
  // Case 2: } NodeId@{ (space only — also invalid for mermaid)
  // [\w-]+ matches hyphenated node IDs like my-node, step-1
  let result = definition.replace(
    /\}([ \t]*)([\w-]+@\{)/g,
    '}\n  $2'
  )

  // Case 3: @{...} --> NodeId  or  @{...} --> NodeId@{...}
  // Any --, ==, or -. immediately after a @{} block is always a link arrow
  // in Mermaid, never valid label text. Handles plain arrows (-->), thick
  // arrows (==>), dotted arrows (-.->), and labeled edges (--text-->).
  result = result.replace(
    /(@\{[^}]*\})([ \t]*)(--|==|-\.|<-|~~)/g,
    '$1\n  $3'
  )

  return result
}

/**
 * Fix common LLM mistake: @{ icon syntax wrapped inside shape brackets.
 * e.g. A["@{ icon: ... }"] → A@{ icon: ... }
 *      B[("@{ icon: ... }")] → B@{ icon: ... }
 *
 * Runs in a loop because each pass only fixes the first bracket-wrapped node
 * per line. After fix + newline insertion, the next pass catches the second
 * node (now at line start).
 */
export function fixIconSyntax(definition: string): string {
  let prev = ''
  let current = definition
  while (current !== prev) {
    prev = current

    // Pass 1: Line-start nodes (brackets optional, handles :::class conversion)
    current = current.replace(
      /^([ \t]*[\w-]+)[ \t]*\[?\(?[ \t]*["']?@\{[ \t]*([^}\n]+)[ \t]*\}["']?[ \t]*\)?[ \t]*\]?(:::([\w-]+))?/gm,
      (_match, indent: string, props: string, _classGroup: string, className: string) => {
        const line = `${indent}@{ ${props.trim()} }`
        // :::class doesn't work with @{ } — convert to class keyword
        if (className) {
          return `${line}\n  class ${indent.trim()} ${className}`
        }
        return line
      }
    )

    // Pass 2: Mid-line bracket-wrapped nodes (requires [ and ], no :::class)
    // Catches nodes after arrows or concatenated on the same line.
    // The required brackets distinguish from bare @{} (already correct).
    current = current.replace(
      /([\w-]+)[ \t]*\[[ \t]*\(?[ \t]*["']?@\{[ \t]*([^}\n]+)[ \t]*\}["']?[ \t]*\)?[ \t]*\](:::([ \w-]+))?/g,
      (_m, nodeId: string, props: string, _classGroup: string, className: string) => {
        const line = `${nodeId}@{ ${props.trim()} }`
        if (className) {
          return `${line}\n  class ${nodeId} ${className}`
        }
        return line
      }
    )
  }
  return current
}

/**
 * Remap deprecated Lucide icon names and normalize quote style.
 * Matches both single and double-quoted icon names, always outputs double quotes.
 */
export function fixIconNames(definition: string): string {
  return definition.replace(
    /icon:\s*["']lucide:([^"']+)["']/g,
    (_match, iconName: string) => {
      const resolved = ICON_ALIASES[iconName] ?? iconName
      return `icon: "lucide:${resolved}"`
    }
  )
}

/**
 * Full LLM-output sanitization pipeline for Mermaid definitions.
 * Order: unwrap bracket-wrapped icons → split concatenated nodes → remap deprecated icon names
 */
export function sanitizeMermaid(definition: string): string {
  const trimmed = definition.trim()
  const unwrapped = fixIconSyntax(trimmed)
  const split = splitIconNodeLines(unwrapped)
  return fixIconNames(split)
}
