/**
 * Shared react-diff-viewer-continued styling.
 * Extracted from FileDiffView so the inline tool-call diffs can reuse it.
 */
import type { HighlightTheme } from 'react-diff-viewer-continued'

/**
 * Syntax token colors for the diff viewer's first-party `highlightLanguage`
 * feature. Mirrors prism-react-renderer's nightOwl theme (the palette chat
 * CodeBlock already uses) so diffs and chat blocks agree. Keys are Prism
 * token types; unknown types fall back to `default` (library-handled).
 */
export const nightOwlHighlightTheme: HighlightTheme = {
  default: '#d6deeb',
  keyword: '#7fdbca',
  'control-keyword': '#7fdbca',
  'module-keyword': '#7fdbca',
  string: '#addb67',
  'template-string': '#addb67',
  'string-interpolation': '#82aaff',
  'regex-source': '#5ca7e4',
  number: '#f78c6c',
  'class-name': '#ffcb8b',
  'function-variable': '#82aaff',
  function: '#82aaff',
  builtin: '#82aaff',
  char: '#82aaff',
  constant: '#82aaff',
  comment: '#637777',
  'triple-quoted-string': '#addb67',
  operator: '#7fdbca',
  punctuation: '#c792ea',
  tag: '#7fdbca',
  'attr-name': '#addb67',
  'attr-value': '#addb67',
  selector: '#c792ea',
  doctype: '#c792ea',
  property: '#80cbc4',
  boolean: '#ff5874',
  variable: '#d6deeb',
  namespace: '#b2ccd6',
  url: '#addb67',
  entity: '#d6deeb'
}

/** Custom theme matching Code Atelier's dark palette */
export const codeAtelierDiffStyles = {
  variables: {
    dark: {
      diffViewerBackground: '#1a1b26',
      diffViewerColor: '#c0caf5',
      // Line fills are transparent — the add/remove signal is carried by the
      // tinted gutter strip plus the word-level wash on changed pairs, so the
      // diff reads as "color on the text" instead of flooded rows.
      addedBackground: 'transparent',
      addedColor: '#c0caf5',
      removedBackground: 'transparent',
      removedColor: '#c0caf5',
      wordAddedBackground: 'rgba(46, 160, 67, 0.35)',
      wordRemovedBackground: 'rgba(248, 81, 73, 0.35)',
      addedGutterBackground: 'rgba(46, 160, 67, 0.20)',
      removedGutterBackground: 'rgba(248, 81, 73, 0.20)',
      gutterBackground: '#16161e',
      gutterColor: '#565f89',
      codeFoldBackground: '#1e1f2e',
      codeFoldGutterBackground: '#1e1f2e',
      codeFoldContentColor: '#565f89',
      emptyLineBackground: '#1a1b26'
    }
  },
  line: {
    padding: '2px 10px',
    fontSize: '12px',
    lineHeight: '1.6'
  },
  gutter: {
    padding: '0 8px',
    minWidth: '40px'
  },
  contentText: {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '12px',
    lineHeight: '1.6'
  }
}

/** Tighter variant for the narrow tool-activity expand panel. */
export const compactDiffStyles = {
  ...codeAtelierDiffStyles,
  line: {
    padding: '1px 8px',
    fontSize: '11px',
    lineHeight: '1.5'
  },
  gutter: {
    padding: '0 6px',
    minWidth: '28px'
  },
  contentText: {
    ...codeAtelierDiffStyles.contentText,
    fontSize: '11px',
    lineHeight: '1.5'
  }
}
