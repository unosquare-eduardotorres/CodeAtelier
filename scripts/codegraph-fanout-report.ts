/**
 * Read-only measurement for the code-graph ambiguity thresholds.
 *
 * Reports how many symbol names are defined in N files ("definition fan-out")
 * and how many edges survive at each candidate cut-off, so AMBIGUITY_THRESHOLD
 * and AMBIGUOUS_FANOUT are chosen from data instead of guessed.
 *
 * Usage:  npx tsx scripts/codegraph-fanout-report.ts [dbPath]
 */
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const DEFAULT_DB = join(
  homedir(),
  'Library',
  'Application Support',
  'code-atelier',
  'code-atelier.db'
)

function main(): void {
  const dbPath = process.argv[2] ?? DEFAULT_DB
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath}`)
    process.exit(1)
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })

  const workspaces = db
    .prepare(
      `SELECT workspace_id, COUNT(*) AS tags FROM code_graph_tags
       GROUP BY workspace_id ORDER BY tags DESC`
    )
    .all() as { workspace_id: string; tags: number }[]

  for (const ws of workspaces) {
    console.log(`\n=== workspace ${ws.workspace_id} — ${ws.tags.toLocaleString()} tags`)

    const rows = db
      .prepare(`SELECT name, kind, rel_fname FROM code_graph_tags WHERE workspace_id = ?`)
      .all(ws.workspace_id) as { name: string; kind: 'def' | 'ref'; rel_fname: string }[]

    const defs = new Map<string, Set<string>>()
    const refs = new Map<string, Set<string>>()
    for (const r of rows) {
      const map = r.kind === 'def' ? defs : refs
      let set = map.get(r.name)
      if (!set) {
        set = new Set()
        map.set(r.name, set)
      }
      set.add(r.rel_fname)
    }

    // Edge count per name = |refFiles × defFiles| minus same-file pairs
    const perName: { name: string; fanout: number; edges: number }[] = []
    for (const [name, refFiles] of refs) {
      const defFiles = defs.get(name)
      if (!defFiles) continue
      let overlap = 0
      for (const f of refFiles) if (defFiles.has(f)) overlap++
      perName.push({
        name,
        fanout: defFiles.size,
        edges: refFiles.size * defFiles.size - overlap
      })
    }

    const totalEdges = perName.reduce((s, p) => s + p.edges, 0)
    console.log(`names with both def+ref: ${perName.length.toLocaleString()}`)
    console.log(`total edges (no cut-off): ${totalEdges.toLocaleString()}`)

    console.log('\nfan-out histogram (definition sites per name):')
    const buckets: [string, (n: number) => boolean][] = [
      ['1', (n) => n === 1],
      ['2-3', (n) => n >= 2 && n <= 3],
      ['4-8', (n) => n >= 4 && n <= 8],
      ['9-16', (n) => n >= 9 && n <= 16],
      ['17-32', (n) => n >= 17 && n <= 32],
      ['33-64', (n) => n >= 33 && n <= 64],
      ['65+', (n) => n >= 65]
    ]
    for (const [label, pred] of buckets) {
      const group = perName.filter((p) => pred(p.fanout))
      const edges = group.reduce((s, p) => s + p.edges, 0)
      console.log(
        `  ${label.padEnd(6)} names=${String(group.length).padStart(6)} ` +
          `edges=${String(edges).padStart(9)} (${((edges / totalEdges) * 100).toFixed(1)}%)`
      )
    }

    console.log('\nedges retained per cut-off:')
    for (const t of [4, 8, 16, 32, 64, Infinity]) {
      const kept = perName.filter((p) => p.fanout <= t).reduce((s, p) => s + p.edges, 0)
      console.log(
        `  <=${String(t).padEnd(8)} ${String(kept).padStart(9)} edges ` +
          `(${((kept / totalEdges) * 100).toFixed(1)}% retained)`
      )
    }

    console.log('\ntop 10 fan-out names:')
    for (const p of [...perName].sort((a, b) => b.fanout - a.fanout).slice(0, 10)) {
      console.log(`  ${p.name.padEnd(28)} fanout=${p.fanout} edges=${p.edges}`)
    }
  }

  db.close()
}

main()
