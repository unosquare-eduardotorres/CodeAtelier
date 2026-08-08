export interface DiffToken {
  text: string
  /** `same` in both strings, `a` only in the left, `b` only in the right. */
  side: 'same' | 'a' | 'b'
}

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t !== '')
}

/**
 * Word-level LCS diff for a single line.
 *
 * Duplicate pairs are ≥0.90 cosine — near-identical sentences. Printing both
 * in full and leaving the reader to spot the difference by eye is the main
 * cost of the review queue, so the differing words are highlighted instead.
 */
export function wordDiff(a: string, b: string): { left: DiffToken[]; right: DiffToken[] } {
  const A = tokenize(a)
  const B = tokenize(b)

  // LCS table — titles are short, so the O(n·m) table is not a concern.
  const lcs: number[][] = Array.from({ length: A.length + 1 }, () =>
    new Array(B.length + 1).fill(0)
  )
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const left: DiffToken[] = []
  const right: DiffToken[] = []
  let i = 0
  let j = 0
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      left.push({ text: A[i], side: 'same' })
      right.push({ text: B[j], side: 'same' })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      left.push({ text: A[i], side: 'a' })
      i++
    } else {
      right.push({ text: B[j], side: 'b' })
      j++
    }
  }
  while (i < A.length) left.push({ text: A[i++], side: 'a' })
  while (j < B.length) right.push({ text: B[j++], side: 'b' })

  return { left, right }
}

/** Pulls the `cosine: 0.920` marker the dedup scanner writes into `resolution`. */
export function parseCosine(resolution: string | null): number | null {
  if (!resolution) return null
  const match = resolution.match(/cosine:\s*([\d.]+)/)
  if (!match) return null
  const value = Number.parseFloat(match[1])
  return Number.isFinite(value) ? value : null
}
