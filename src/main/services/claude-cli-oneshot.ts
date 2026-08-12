import { execFile } from 'node:child_process'
import { buildEnvWithPath } from './env-utils'

export interface ClaudeOneShotOptions {
  timeout?: number
  maxBuffer?: number
  cwd?: string
}

const DEFAULT_TIMEOUT = 180_000
const DEFAULT_MAX_BUFFER = 1024 * 1024 * 10 // 10MB

/**
 * Run a binary in one-shot mode and resolve stdout. Closes the child's stdin
 * immediately (EOF, equivalent to `< /dev/null`) so the Claude CLI does not
 * block ~3s on its empty stdin pipe and intermittently exit non-zero. Surfaces
 * stderr in the rejection message for diagnostics. `binary` param exists for
 * testability; production calls use runClaudeCliOneShot.
 */
export function runCliOneShot(
  binary: string,
  args: string[],
  opts: ClaudeOneShotOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      {
        encoding: 'utf-8',
        timeout: opts.timeout ?? DEFAULT_TIMEOUT,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        cwd: opts.cwd,
        env: buildEnvWithPath(),
        windowsHide: true
      },
      (err, stdout, stderr) => {
        if (err) {
          const sErr = stderr?.trim() || ''
          if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            const secs = Math.round((opts.timeout ?? DEFAULT_TIMEOUT) / 1000)
            reject(new Error(`CLI timed out after ${secs}s${sErr ? `\n${sErr}` : ''}`))
            return
          }
          reject(new Error(`${err.message}${sErr ? `\n${sErr}` : ''}`))
          return
        }
        resolve(stdout)
      }
    )
    child.stdin?.end() // EOF — eliminates the CLI's 3s stdin wait
  })
}

export function runClaudeCliOneShot(args: string[], opts?: ClaudeOneShotOptions): Promise<string> {
  return runCliOneShot('claude', args, opts)
}
