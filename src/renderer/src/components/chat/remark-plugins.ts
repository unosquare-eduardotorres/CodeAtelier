/**
 * Custom remark plugins for MessageBubble markdown rendering.
 * Extracted from MessageBubble.tsx for maintainability.
 */
import type { Plugin } from 'unified'
import type { Root, Text, PhrasingContent, Html, RootContent, Parent } from 'mdast'
import { visit } from 'unist-util-visit'

/**
 * Remark plugin: wraps emoji characters inside headings with a styled <span class="emoji">
 * so CSS can normalize their size and alignment.
 */
export const remarkEmojiSpan: Plugin<[], Root> = () => {
  const emojiRegex =
    /(\p{Emoji_Presentation}|\p{Extended_Pictographic})(\u200D(\p{Emoji_Presentation}|\p{Extended_Pictographic}))*/gu

  return (tree) => {
    visit(tree, 'heading', (node) => {
      const newChildren: PhrasingContent[] = []
      for (const child of node.children) {
        if (child.type !== 'text') {
          newChildren.push(child)
          continue
        }
        const text = (child as Text).value
        let lastIndex = 0
        let match: RegExpExecArray | null

        emojiRegex.lastIndex = 0
        while ((match = emojiRegex.exec(text)) !== null) {
          if (match.index > lastIndex) {
            newChildren.push({ type: 'text', value: text.slice(lastIndex, match.index) })
          }
          newChildren.push({
            type: 'html',
            value: `<span class="emoji">${match[0]}</span>`
          })
          lastIndex = match.index + match[0].length
        }
        if (lastIndex === 0) {
          newChildren.push(child)
        } else if (lastIndex < text.length) {
          newChildren.push({ type: 'text', value: text.slice(lastIndex) })
        }
      }
      node.children = newChildren
    })
  }
}

/**
 * Remark plugin: wraps the last paragraph ending with '?' in a styled
 * <div class="agent-question"> so questions stand out visually in chat.
 */
export const remarkHighlightQuestions: Plugin<[], Root> = () => {
  return (tree) => {
    let lastQuestionIndex: number | null = null

    tree.children.forEach((node, index) => {
      if (node.type !== 'paragraph') return
      const textContent = (node as { children: Array<{ value?: string }> }).children
        .map((c) => c.value ?? '')
        .join('')
        .trim()
      if (textContent.endsWith('?')) {
        lastQuestionIndex = index
      }
    })

    if (lastQuestionIndex !== null) {
      const node = tree.children[lastQuestionIndex]
      tree.children.splice(
        lastQuestionIndex,
        1,
        { type: 'html', value: '<div class="agent-question">' } as Html as RootContent,
        node,
        { type: 'html', value: '</div>' } as Html as RootContent
      )
    }
  }
}

/**
 * Remark plugin: wraps "Next Steps" headings and their following content in a styled
 * <div class="agent-next-steps"> so actionable next-step blocks stand out visually.
 */
export const remarkHighlightNextSteps: Plugin<[], Root> = () => {
  return (tree) => {
    const children = tree.children
    let i = 0
    while (i < children.length) {
      const node = children[i]
      if (node.type === 'heading') {
        const textContent = (node as { children: Array<{ value?: string }> }).children
          .map((c) => c.value ?? '')
          .join('')
          .trim()
        if (/next\s+steps?/i.test(textContent)) {
          let end = i + 1
          while (end < children.length && children[end].type !== 'heading') {
            end++
          }
          const wrapped = children.slice(i, end)
          const openTag = {
            type: 'html',
            value: '<div class="agent-next-steps">'
          } as Html as RootContent
          const closeTag = { type: 'html', value: '</div>' } as Html as RootContent
          children.splice(i, end - i, openTag, ...wrapped, closeTag)
          i += wrapped.length + 2
          continue
        }
      }
      i++
    }
  }
}

/**
 * Remark plugin: wraps arrow characters (→, ←, ⟶, ⟹, ↔) in a styled
 * <span class="arrow-indicator"> so they stand out from surrounding body text.
 */
export const remarkStyledArrows: Plugin<[], Root> = () => {
  const arrowRegex = /([→←↔⟶⟹])/g

  return (tree) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (index == null || !parent) return
      const text = node.value
      if (!arrowRegex.test(text)) return

      arrowRegex.lastIndex = 0
      const parts: (Text | Html)[] = []
      let lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = arrowRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          parts.push({ type: 'text', value: text.slice(lastIndex, match.index) })
        }
        parts.push({
          type: 'html',
          value: `<span class="arrow-indicator">${match[0]}</span>`
        } as Html)
        lastIndex = match.index + match[0].length
      }
      if (lastIndex < text.length) {
        parts.push({ type: 'text', value: text.slice(lastIndex) })
      }
      if (parts.length > 1) {
        ;(parent as Parent).children.splice(index, 1, ...(parts as RootContent[]))
      }
    })
  }
}
