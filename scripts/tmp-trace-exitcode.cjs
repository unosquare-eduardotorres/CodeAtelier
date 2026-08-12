// TEMPORARY DIAGNOSTIC — traces who sets process.exitCode. Delete after use.
let v = process.exitCode
Object.defineProperty(process, 'exitCode', {
  configurable: true,
  get() {
    return v
  },
  set(next) {
    if (next) {
      console.error(`\n[exitCode-trace] process.exitCode set to ${next}\n${new Error().stack}\n`)
    }
    v = next
  }
})
