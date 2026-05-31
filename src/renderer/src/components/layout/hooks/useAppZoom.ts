/**
 * useAppZoom — manages zoom factor state and IPC subscription.
 */
import { useState, useEffect } from 'react'

export function useAppZoom(): number {
  const [zoomFactor, setZoomFactor] = useState(1.0)

  useEffect(() => {
    window.api.zoomGet().then(setZoomFactor).catch(console.error)
    const unsub = window.api.onZoomChanged((factor: number) => setZoomFactor(factor))
    return unsub
  }, [])

  return zoomFactor
}
