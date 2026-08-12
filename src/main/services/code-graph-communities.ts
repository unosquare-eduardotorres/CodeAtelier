/**
 * Subsystem detection over the file-level dependency graph.
 *
 * `graph_map` ranks files by PageRank, which answers "what matters most?" but
 * not "what belongs together?". Label propagation supplies the second answer in
 * ~60 lines with no new dependency — Leiden would need a native/Python
 * dependency for a marginal quality gain on a graph we already rank separately.
 *
 * Everything here is pure: adjacency in, communities out. No DB, no I/O.
 */

/** One undirected file-pair with its edge weight. */
export interface FilePair {
  sourceFile: string
  targetFile: string
  edgeCount: number
}

export interface Community {
  /** Directory most members live in, or their shared prefix. */
  name: string
  /**
   * Most-connected member. Flat directories (a services/ folder with hundreds of
   * files) produce several communities with the same `name`, so this is what
   * actually tells them apart.
   */
  hubFile: string
  files: string[]
  /** Edges whose endpoints are both inside this community. */
  internalEdges: number
}

export interface GodNode {
  file: string
  /** Distinct neighbouring files, in and out. */
  degree: number
}

/**
 * Name a community by the directory most of its files live in, at up to
 * `depth` segments. Preferred over the longest common prefix, which collapses
 * to a useless 'src' as soon as one member sits outside the main directory.
 * Falls back to the common prefix when no directory holds a plurality.
 */
export function dominantDirectory(files: string[], depth: number = 3): string {
  if (files.length === 0) return 'root'
  const counts = new Map<string, number>()
  for (const file of files) {
    const dir = file.split('/').slice(0, -1).slice(0, depth).join('/')
    if (dir.length === 0) continue
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  let tied = false
  for (const [dir, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = dir
      bestCount = count
      tied = false
    } else if (count === bestCount) {
      tied = true
    }
  }
  // A tie, or a plurality below a third, says the group straddles directories —
  // the shared prefix is then the more honest label.
  const hasPlurality = !tied && bestCount * 3 >= files.length && best.length > 0
  return hasPlurality ? best : commonDirectoryPrefix(files)
}

/**
 * Name a community by the longest directory prefix all its files share.
 * Deterministic, and on a layered layout more meaningful than a generated label.
 */
export function commonDirectoryPrefix(files: string[]): string {
  if (files.length === 0) return 'root'
  const split = files.map((f) => f.split('/').slice(0, -1))
  let prefix = split[0]
  for (const parts of split.slice(1)) {
    let i = 0
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++
    prefix = prefix.slice(0, i)
    if (prefix.length === 0) break
  }
  return prefix.length > 0 ? prefix.join('/') : 'root'
}

/** Build a weighted undirected adjacency map from directed file pairs. */
function buildAdjacency(pairs: FilePair[]): Map<string, Map<string, number>> {
  const adj = new Map<string, Map<string, number>>()
  const link = (a: string, b: string, w: number): void => {
    let neighbours = adj.get(a)
    if (!neighbours) {
      neighbours = new Map()
      adj.set(a, neighbours)
    }
    neighbours.set(b, (neighbours.get(b) ?? 0) + w)
  }
  for (const p of pairs) {
    if (p.sourceFile === p.targetFile) continue
    link(p.sourceFile, p.targetFile, p.edgeCount)
    link(p.targetFile, p.sourceFile, p.edgeCount)
  }
  return adj
}

/**
 * Label propagation: every node adopts the label carried by the greatest
 * neighbour weight, iterating until stable. Ties break on the lexicographically
 * smallest label and nodes are visited in sorted order, so the result is
 * deterministic — the same index always yields the same subsystems.
 */
export function detectCommunities(
  pairs: FilePair[],
  opts: {
    minSize?: number
    maxIterations?: number
    maxCommunities?: number
    hubDegree?: number
  } = {}
): Community[] {
  const minSize = opts.minSize ?? 3
  const maxIterations = opts.maxIterations ?? 10
  const maxCommunities = opts.maxCommunities ?? 12
  const hubDegree = opts.hubDegree ?? 50

  const fullAdj = buildAdjacency(pairs)

  // Hub files (a shared types barrel, a constants module) touch everything, so
  // label propagation floods the whole graph through them and returns one blob.
  // They are excluded from propagation and surfaced separately as god nodes.
  const hubs = new Set(
    [...fullAdj.entries()].filter(([, n]) => n.size >= hubDegree).map(([file]) => file)
  )
  const adj =
    hubs.size === 0
      ? fullAdj
      : buildAdjacency(pairs.filter((p) => !hubs.has(p.sourceFile) && !hubs.has(p.targetFile)))

  const nodes = [...adj.keys()].sort()
  const labels = new Map<string, string>(nodes.map((n) => [n, n]))

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false
    for (const node of nodes) {
      const weights = new Map<string, number>()
      for (const [neighbour, weight] of adj.get(node) ?? []) {
        const label = labels.get(neighbour)!
        weights.set(label, (weights.get(label) ?? 0) + weight)
      }
      if (weights.size === 0) continue
      let best = labels.get(node)!
      let bestWeight = -1
      for (const [label, weight] of weights) {
        if (weight > bestWeight || (weight === bestWeight && label < best)) {
          best = label
          bestWeight = weight
        }
      }
      if (best !== labels.get(node)) {
        labels.set(node, best)
        changed = true
      }
    }
    if (!changed) break
  }

  const groups = new Map<string, string[]>()
  for (const [node, label] of labels) {
    const group = groups.get(label)
    if (group) group.push(node)
    else groups.set(label, [node])
  }

  // Single pass over the pairs — counting per community separately would be
  // O(communities × pairs) on graphs where pairs runs into six figures.
  const internalByLabel = new Map<string, number>()
  for (const p of pairs) {
    const sourceLabel = labels.get(p.sourceFile)
    if (sourceLabel && sourceLabel === labels.get(p.targetFile)) {
      internalByLabel.set(sourceLabel, (internalByLabel.get(sourceLabel) ?? 0) + p.edgeCount)
    }
  }

  const communities: Community[] = []
  for (const [label, files] of groups) {
    if (files.length < minSize) continue
    const sorted = files.sort()
    const hubFile = sorted.reduce((best, file) =>
      (fullAdj.get(file)?.size ?? 0) > (fullAdj.get(best)?.size ?? 0) ? file : best
    )
    communities.push({
      name: dominantDirectory(sorted),
      hubFile,
      files: sorted,
      internalEdges: internalByLabel.get(label) ?? 0
    })
  }

  return communities.sort((a, b) => b.files.length - a.files.length).slice(0, maxCommunities)
}

/**
 * Files with the most distinct neighbours — the ones every change risks touching.
 * Degree, not PageRank: PageRank says "important", degree says "entangled".
 */
export function findGodNodes(pairs: FilePair[], topN: number = 10): GodNode[] {
  const adj = buildAdjacency(pairs)
  return [...adj.entries()]
    .map(([file, neighbours]) => ({ file, degree: neighbours.size }))
    .sort((a, b) => b.degree - a.degree || a.file.localeCompare(b.file))
    .slice(0, topN)
}
