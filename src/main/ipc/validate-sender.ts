/**
 * Validates that an IPC message comes from a trusted sender.
 * Prevents rogue webviews or injected frames from calling IPC handlers.
 */
export function validateSender(event: Electron.IpcMainInvokeEvent): void {
  if (!event.senderFrame) {
    throw new Error('Unauthorized IPC sender: no sender frame')
  }

  const url = event.senderFrame.url

  // Allow file:// protocol (production) and localhost (dev with HMR)
  if (url.startsWith('file://') || url.startsWith('http://localhost')) {
    return
  }

  throw new Error(`Unauthorized IPC sender: ${url}`)
}
