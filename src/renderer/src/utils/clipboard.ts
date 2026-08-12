/** Copy text to clipboard — Electron-native first, then Web API fallback. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  // Electron's native clipboard — works reliably on all platforms
  if (window.api?.clipboardWriteText) {
    try {
      window.api.clipboardWriteText(text)
      return true
    } catch {
      /* fall through to Web API */
    }
  }
  // Web API fallback
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}
