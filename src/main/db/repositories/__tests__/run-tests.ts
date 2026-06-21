// Repository test runner entrypoint
// Usage: npx tsx src/main/db/repositories/__tests__/run-tests.ts
import './message.repository.test'
import './conversation.repository.test'
import './workspace.repository.test'
import './grill-session.repository.test'
import './mpa-campaign.repository.test'
import './usage-log.repository.test'
import './migration-v102.test'

// ─── Phase 15: Coverage Mega-Push — Track 1A: Core Entity Repos ───
import './specialist.repository.test'
import './skill.repository.test'
import './bug.repository.test'
import './preset.repository.test'
import './idea.repository.test'
import './memory.repository.test'
import './event.repository.test'

// ─── Phase 15: Track 1B: Pipeline Repos ───
import './blueprint.repository.test'
import './audit.repository.test'
import './mpa-run.repository.test'
import './council-session.repository.test'
import './plan.repository.test'

// ─── Phase 15: Track 1C: Remaining Repos ───
import './remaining-repos.test'

// ─── Phase 15: Track 1D: Code-Graph + Search Repos ───
import './code-graph-repos.test'

// ─── Phase 15: Track 6: Migration Suite ───
import './migration-suite.test'

// ─── Phase 16: Track 1 + Track 6: Migration replay + branch coverage ───
import './migration-replay.test'
import './repo-branch-coverage.test'

// ─── Phase 17: Track 8: Repo deep branch completion ───
import './repo-deep-branch.test'

import { passed, failed, skipped } from '../../../services/__tests__/test-harness'

console.log(`\nRepository tests: ${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed > 0 ? 1 : 0)
