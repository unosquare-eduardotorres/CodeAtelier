# AgentSessionService Circuit Breaker — Future Architecture

## Problem

AgentSessionService is the single execution engine for all 5 service types
(Chat, Grill, Audit, Council, MPA). If it enters a degraded state, every
service fails simultaneously with no recovery path short of app restart.

## Failure Modes

| Mode                       | Cause                                  | Impact                                            |
| -------------------------- | -------------------------------------- | ------------------------------------------------- |
| Executor binary missing    | Corrupt install, PATH issue            | All streams fail to start                         |
| MCP config write failure   | Disk full, permissions                 | Agent has no tools (now throws — Phase 5C)        |
| IPC bridge socket conflict | Port collision, stale socket           | Control tools unavailable (now logged — Phase 5A) |
| Context overflow           | Prompt > model window                  | Stream terminates early, partial output           |
| Infinite recovery loop     | circuitBreaker.isBroken never triggers | Session hangs indefinitely                        |

## Proposed Design

### Health Tracking

```typescript
class SessionHealthTracker {
  private failures = 0
  private lastFailure: number | null = null
  private readonly FAILURE_WINDOW_MS = 5 * 60_000  // 5 min
  private readonly MAX_FAILURES = 3
  private readonly COOLDOWN_MS = 30_000  // 30 sec

  recordFailure(): void { ... }
  recordSuccess(): void { this.failures = 0 }
  isHealthy(): boolean { ... }
  getCooldownRemaining(): number { ... }
}
```

### Integration Points

1. `executeStream()` — wrap in health check before starting
2. `send()` — early return with error event if unhealthy
3. `stop()` — reset health tracker on explicit stop
4. Per-workspace isolation — separate tracker per workspace

### Cooldown Behavior

When circuit opens (3 failures in 5 min):

- New `send()` calls immediately emit `{ type: 'error', content: 'Session cooldown' }`
- Cooldown lasts 30 seconds
- After cooldown, next attempt is a "half-open" probe
- Success closes circuit, failure extends cooldown

### Service-Level Impact

| Service | On Circuit Open            | Recovery                              |
| ------- | -------------------------- | ------------------------------------- |
| Chat    | Error message in chat      | User retries manually                 |
| Grill   | Evaluation marked 'failed' | Re-run available                      |
| Audit   | Track marked 'failed'      | Resume picks up remaining tracks      |
| Council | Advisor marked 'failed'    | Council continues with fewer advisors |
| MPA     | Phase marked 'failed'      | Pipeline pauses, user can resume      |

## Why Not Now

- Failure rate in production is very low (executor binary is bundled)
- Phase 5 fixes already handle the most common failure modes
- Circuit breaker adds complexity to the critical path
- Risk of false positives (slow local LLMs could trigger circuit)

## Prerequisites

- Telemetry on `executeStream()` failure rates (currently no metrics)
- User-facing "session health" indicator in UI
- Retry budget per service type (grill can retry, audit can skip track)
