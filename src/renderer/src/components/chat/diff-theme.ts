/**
 * Shared react-diff-viewer-continued styling.
 * Extracted from FileDiffView so the inline tool-call diffs can reuse it.
 */

/** Custom theme matching Code Atelier's dark palette */
export const codeAtelierDiffStyles = {
  variables: {
    dark: {
      diffViewerBackground: '#1a1b26',
      diffViewerColor: '#c0caf5',
      addedBackground: 'rgba(46, 160, 67, 0.15)',
      addedColor: '#c0caf5',
      removedBackground: 'rgba(248, 81, 73, 0.15)',
      removedColor: '#c0caf5',
      wordAddedBackground: 'rgba(46, 160, 67, 0.40)',
      wordRemovedBackground: 'rgba(248, 81, 73, 0.40)',
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
