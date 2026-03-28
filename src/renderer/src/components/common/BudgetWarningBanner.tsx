import { useState, useEffect, useRef, useCallback } from 'react'
import { AlertTriangle, X } from 'lucide-react'

interface BudgetAlert {
  type: 'warning' | 'exceeded'
  currentCostCents: number
  budgetCents: number
  percentUsed?: number
}

const AUTO_DISMISS_MS = 15_000

export default function BudgetWarningBanner(): React.JSX.Element | null {
  const [alert, setAlert] = useState<BudgetAlert | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dismiss = useCallback(() => {
    setAlert(null)
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const showAlert = useCallback(
    (newAlert: BudgetAlert) => {
      // Clear existing timer
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
      setAlert(newAlert)
      timerRef.current = setTimeout(dismiss, AUTO_DISMISS_MS)
    },
    [dismiss]
  )

  useEffect(() => {
    const cleanupWarning = window.api.onBudgetWarning((data) => {
      showAlert({
        type: 'warning',
        currentCostCents: data.currentCostCents,
        budgetCents: data.budgetCents,
        percentUsed: data.percentUsed
      })
    })

    const cleanupExceeded = window.api.onBudgetExceeded((data) => {
      showAlert({
        type: 'exceeded',
        currentCostCents: data.currentCostCents,
        budgetCents: data.budgetCents
      })
    })

    return () => {
      cleanupWarning()
      cleanupExceeded()
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [showAlert])

  if (!alert) return null

  const isExceeded = alert.type === 'exceeded'
  const currentDollars = (alert.currentCostCents / 100).toFixed(2)
  const budgetDollars = (alert.budgetCents / 100).toFixed(2)

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2.5 border-b text-sm ${isExceeded ? 'bg-danger-muted border-red-800/50' : 'bg-yellow-500/10 border-yellow-800/50'}`}
    >
      <AlertTriangle
        size={14}
        className={`shrink-0 ${isExceeded ? 'text-red-400' : 'text-yellow-400'}`}
      />
      <span className={`flex-1 ${isExceeded ? 'text-red-300' : 'text-yellow-300'}`}>
        {isExceeded ? (
          <>
            Budget exceeded — spent <span className="font-semibold">${currentDollars}</span> of $
            {budgetDollars} daily limit. Specialist tasks are paused.
          </>
        ) : (
          <>
            Budget warning — spent <span className="font-semibold">${currentDollars}</span> of $
            {budgetDollars} daily limit
            {alert.percentUsed != null && ` (${Math.round(alert.percentUsed)}%)`}.
          </>
        )}
      </span>
      <button
        onClick={dismiss}
        className={`p-1 rounded transition-colors ${
          isExceeded
            ? 'hover:bg-red-800/40 text-red-400 hover:text-red-300'
            : 'hover:bg-yellow-800/40 text-yellow-400 hover:text-yellow-300'
        }`}
        aria-label="Dismiss budget alert"
      >
        <X size={14} />
      </button>
    </div>
  )
}
