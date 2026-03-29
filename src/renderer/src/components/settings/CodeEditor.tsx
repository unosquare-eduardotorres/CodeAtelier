import { useCallback } from 'react'
import Editor from 'react-simple-code-editor'
import { Highlight, themes } from 'prism-react-renderer'

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  language: 'yaml' | 'markdown' | 'typescript' | 'json'
  readOnly?: boolean
  className?: string
}

const LANGUAGE_MAP: Record<string, string> = {
  yaml: 'yaml',
  markdown: 'markdown',
  typescript: 'typescript',
  json: 'json'
}

export default function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  className = ''
}: CodeEditorProps): React.JSX.Element {
  const highlight = useCallback(
    (code: string) => (
      <Highlight theme={themes.nightOwl} code={code} language={LANGUAGE_MAP[language] ?? 'markup'}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                <span className="inline-block w-8 text-right mr-4 text-text-secondary select-none text-[11px]">
                  {i + 1}
                </span>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </>
        )}
      </Highlight>
    ),
    [language]
  )

  return (
    <div className={`rounded-lg border border-border-subtle bg-surface-base overflow-auto ${className}`}>
      <Editor
        value={value}
        onValueChange={readOnly ? () => {} : onChange}
        highlight={highlight}
        padding={16}
        textareaClassName="outline-none font-mono text-sm"
        className="font-mono text-sm text-text-primary min-h-[200px]"
        style={{
          fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
          fontSize: '13px',
          lineHeight: '1.6'
        }}
        readOnly={readOnly}
      />
    </div>
  )
}
