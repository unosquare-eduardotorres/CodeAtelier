// Repository test runner entrypoint
// Usage: npx tsx src/main/db/repositories/__tests__/run-tests.ts
import './message.repository.test'
import './conversation.repository.test'
import './workspace.repository.test'
import { passed, failed, skipped } from '../../../services/__tests__/test-harness'

console.log(`\nRepository tests: ${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed > 0 ? 1 : 0)
