import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, FileText, RotateCcw, Loader2 } from 'lucide-react'
import { useSkillStore } from '@renderer/store'

export default function SkillImportDropzone(): React.JSX.Element {
  const { importSkill, importingSkill } = useSkillStore()
  const [error, setError] = useState<string | null>(null)
  const [lastFailedPath, setLastFailedPath] = useState<string | null>(null)

  const handleImport = useCallback(
    async (filePath: string): Promise<void> => {
      setError(null)
      setLastFailedPath(null)

      const result = await importSkill(filePath)
      if (!result.success) {
        setError(result.error ?? 'Import failed')
        setLastFailedPath(filePath)
      }
    },
    [importSkill]
  )

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length === 0) return
      const file = acceptedFiles[0] as File & { path: string }
      if (file.path) {
        handleImport(file.path)
      }
    },
    [handleImport]
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'text/markdown': ['.md'] },
    multiple: false,
    disabled: importingSkill
  })

  const handleBrowse = async (): Promise<void> => {
    const filePath = await window.api.selectSkillFile()
    if (filePath) {
      handleImport(filePath)
    }
  }

  const handleRetry = (): void => {
    if (lastFailedPath) {
      handleImport(lastFailedPath)
    }
  }

  return (
    <div className="space-y-2">
      <div
        {...getRootProps()}
        className={`relative flex flex-col items-center justify-center p-6 rounded-xl border-2 border-dashed transition-colors cursor-pointer ${
          isDragActive
            ? 'border-indigo-500 bg-indigo-500/5'
            : importingSkill
              ? 'border-gray-700 bg-gray-800/30 cursor-wait'
              : 'border-gray-700 bg-gray-800/30 hover:border-gray-600 hover:bg-gray-800/50'
        }`}
      >
        <input {...getInputProps()} />

        {importingSkill ? (
          <>
            <Loader2 size={24} className="text-indigo-400 animate-spin mb-2" />
            <p className="text-sm text-gray-400">Importing skill and updating CLAUDE.md...</p>
            <p className="text-[11px] text-gray-600 mt-1">This may take up to 60 seconds</p>
          </>
        ) : isDragActive ? (
          <>
            <Upload size={24} className="text-indigo-400 mb-2" />
            <p className="text-sm text-indigo-400 font-medium">Drop .md file here</p>
          </>
        ) : (
          <>
            <FileText size={24} className="text-gray-600 mb-2" />
            <p className="text-sm text-gray-400">
              Drag and drop a <span className="text-gray-300 font-medium">.md</span> skill file here
            </p>
            <p className="text-[11px] text-gray-600 mt-1">
              or{' '}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleBrowse()
                }}
                className="text-indigo-400 hover:text-indigo-300 underline"
              >
                browse to select
              </button>
            </p>
          </>
        )}
      </div>

      {/* Error with retry */}
      {error && !importingSkill && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
          <span className="text-xs text-red-400 flex-1">{error}</span>
          {lastFailedPath && (
            <button
              onClick={handleRetry}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors flex-shrink-0"
            >
              <RotateCcw size={12} />
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  )
}
