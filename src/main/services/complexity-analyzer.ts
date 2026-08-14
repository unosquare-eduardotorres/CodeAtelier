/**
 * Cyclomatic complexity for languages ESLint cannot parse (C#, Java, Python).
 *
 * `analyze_complexity` is implemented as ESLint's `complexity` rule, so every
 * non-JS/TS repository got "Language not supported" — which is what makes the
 * blueprint REVIEW phase report a ❌ for complexity on every C# codebase.
 * This module is the second engine: it walks the tree-sitter AST the code graph
 * already parses (same WASM grammars, same shared `Parser.init()`), so no new
 * parsing infrastructure is introduced.
 *
 * Scoring matches ESLint's `complexity` rule so the numbers stay comparable
 * across languages in one report:
 *   score = 1 + decision points
 *   nested functions are scored SEPARATELY (a lambda inside a method does not
 *   inflate the method), mirroring how ESLint reports nested arrow functions.
 *
 * The node-type tables below are measured against the shipped grammars, not
 * inferred: `boolean_operator` (not `binary_expression`) carries Python's
 * `and`/`or`, and Java's `switch_label` also matches `default`, which would
 * inflate every Java switch by one if counted blindly.
 */

import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'
import { getTreeSitter, loadLanguage, type TsLanguage, type TsNode } from './tree-sitter-parser'
import {
  isExcludedDirName,
  isExcludedPath,
  matchesSkipPattern,
  MAX_INDEXABLE_FILE_BYTES,
  toPosixRel
} from './code-graph-exclusions'
import { SKIP_PATTERNS } from './preprocessing/file-validation'

// ── Language routing ────────────────────────────────────────────────────────

export type TreeSitterLang = 'c_sharp' | 'java' | 'python'

/**
 * Extension → grammar. Explicit rather than repomap's `filenameToLang`: this
 * table is the single source of truth for "supported", so an extension can
 * never resolve to a grammar we have no complexity rules for.
 */
export const TREE_SITTER_EXTENSIONS: Record<string, TreeSitterLang> = {
  '.cs': 'c_sharp',
  '.java': 'java',
  '.py': 'python'
}

/** Extensions handled by the existing ESLint path — unchanged. */
export const ESLINT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts'
])

/** Every extension `analyze_complexity` can score, in report order. */
export const ALL_SUPPORTED_EXTENSIONS = [
  ...ESLINT_EXTENSIONS,
  ...Object.keys(TREE_SITTER_EXTENSIONS)
]

/** Which engine scores a path, or `null` when the language is unsupported. */
export function complexityEngineFor(filePath: string): 'eslint' | 'tree-sitter' | null {
  const ext = path.extname(filePath).toLowerCase()
  if (ESLINT_EXTENSIONS.has(ext)) return 'eslint'
  if (ext in TREE_SITTER_EXTENSIONS) return 'tree-sitter'
  return null
}

/** Grammar for a file path, or `null` when tree-sitter does not handle it. */
export function langForFile(filePath: string): TreeSitterLang | null {
  return TREE_SITTER_EXTENSIONS[path.extname(filePath).toLowerCase()] ?? null
}

// ── Per-language rules ──────────────────────────────────────────────────────

interface LanguageRules {
  /** Nodes that open a new function scope and get their own score. */
  scopes: Set<string>
  /** Nodes that add +1 to the enclosing scope. */
  decisions: Set<string>
  /** Node type carrying short-circuit operators for this grammar. */
  operatorNode: string
  /** Operator token types that add +1 when they appear on `operatorNode`. */
  operators: Set<string>
  /** Veto for decision nodes that are fallthrough rather than branches. */
  exclude?: (node: TsNode) => boolean
  /** Label used when a scope node has no `name` field (lambdas, accessors). */
  anonymousLabels?: Record<string, string>
}

const LANGUAGE_RULES: Record<TreeSitterLang, LanguageRules> = {
  c_sharp: {
    scopes: new Set([
      'method_declaration',
      'constructor_declaration',
      'destructor_declaration',
      'operator_declaration',
      'indexer_declaration',
      'accessor_declaration',
      'local_function_statement',
      'lambda_expression'
    ]),
    decisions: new Set([
      'if_statement',
      'for_statement',
      'for_each_statement',
      'while_statement',
      'do_statement',
      'case_switch_label', // `default:` is a SEPARATE node (default_switch_label)
      'switch_expression_arm',
      'catch_clause',
      'catch_filter_clause', // `catch (E e) when (…)` is a second branch
      'and_pattern',
      'or_pattern',
      'conditional_expression',
      'conditional_access_expression' // `?.` short-circuits
    ]),
    operatorNode: 'binary_expression',
    operators: new Set(['&&', '||', '??']),
    // `_ => …` is the switch expression's fallthrough arm, not a branch.
    exclude: (n) => n.type === 'switch_expression_arm' && n.firstNamedChild?.type === 'discard',
    anonymousLabels: {
      lambda_expression: 'lambda',
      accessor_declaration: 'accessor',
      indexer_declaration: 'indexer',
      operator_declaration: 'operator',
      destructor_declaration: 'finalizer'
    }
  },
  java: {
    scopes: new Set(['method_declaration', 'constructor_declaration', 'lambda_expression']),
    decisions: new Set([
      'if_statement',
      'for_statement',
      'enhanced_for_statement',
      'while_statement',
      'do_statement',
      'switch_label', // covers BOTH `case X:` and `case X ->`
      'catch_clause',
      'ternary_expression'
    ]),
    operatorNode: 'binary_expression',
    operators: new Set(['&&', '||']),
    // `switch_label` also matches `default:` / `default ->`, which is the
    // fallthrough path, not a decision — counting it inflates every switch.
    exclude: (n) => n.type === 'switch_label' && n.text.trimStart().startsWith('default'),
    anonymousLabels: { lambda_expression: 'lambda' }
  },
  python: {
    scopes: new Set(['function_definition', 'lambda']),
    decisions: new Set([
      'if_statement',
      'elif_clause',
      'for_statement',
      'while_statement',
      'case_clause',
      'union_pattern', // `case 1 | 2` is two patterns, so one extra branch
      'except_clause',
      'conditional_expression',
      'assert_statement',
      'if_clause', // comprehension filter
      'for_in_clause' // comprehension iteration
    ]),
    operatorNode: 'boolean_operator', // NOT binary_expression — measured
    operators: new Set(['and', 'or']),
    // `case _:` is the fallthrough arm — the same construct as Java's `default`
    // and C#'s `_ =>`, so it is excluded for the same reason. A GUARDED
    // wildcard (`case _ if cond:`) still scores, via its `if_clause` guard.
    exclude: (n) =>
      n.type === 'case_clause' &&
      n.childForFieldName('guard') === null &&
      n.firstNamedChild?.type === 'case_pattern' &&
      n.firstNamedChild.namedChildCount === 0,
    anonymousLabels: { lambda: 'lambda' }
  }
}

/** Never counted, in any language: `else`/`else_clause`, `finally_clause`,
 *  `try_statement`, `with_statement`, C#'s `default_switch_label`. They add no
 *  independent path. */

// ── Scoring ─────────────────────────────────────────────────────────────────

export interface FunctionComplexity {
  /** Workspace-relative POSIX path, set by the file-level API. */
  file: string
  function: string
  line: number
  column: number
  complexity: number
}

/**
 * `isNamed` is load-bearing, not defensive: in tree-sitter-python the `lambda`
 * KEYWORD token has node type `lambda` too, so a plain type check reports every
 * lambda twice — once for the real scope and once for the bare keyword.
 */
function isScope(node: TsNode, rules: LanguageRules): boolean {
  return node.isNamed && rules.scopes.has(node.type)
}

function isDecision(node: TsNode, rules: LanguageRules): boolean {
  if (rules.exclude?.(node)) return false
  if (rules.decisions.has(node.type)) return true
  if (node.type !== rules.operatorNode) return false
  // The operator token type IS its text for these grammars ('&&', 'and', …),
  // so this does not depend on a grammar-specific field name.
  return node.children.some((c) => c !== null && rules.operators.has(c.type))
}

/** Score one scope, stopping at nested scopes (measured on their own). */
function measureScope(scope: TsNode, rules: LanguageRules): number {
  let complexity = 1
  const stack: TsNode[] = []
  for (const child of scope.children) if (child) stack.push(child)
  while (stack.length > 0) {
    const node = stack.pop()!
    if (isScope(node, rules)) continue // its own function — skip subtree
    if (isDecision(node, rules)) complexity++
    for (const child of node.children) if (child) stack.push(child)
  }
  return complexity
}

function scopeName(node: TsNode, rules: LanguageRules): string {
  const named = node.childForFieldName('name')?.text
  if (named) return named
  const label = rules.anonymousLabels?.[node.type] ?? 'anonymous'
  return `${label}@${node.startPosition.row + 1}`
}

/**
 * Score every function in a source string. Pure w.r.t. the filesystem —
 * the unit-testable core.
 */
export async function computeFileComplexity(
  code: string,
  lang: TreeSitterLang
): Promise<Array<Omit<FunctionComplexity, 'file'>>> {
  const rules = LANGUAGE_RULES[lang]
  let language: TsLanguage
  try {
    language = await loadLanguage(lang)
  } catch (err) {
    throw new Error(`tree-sitter grammar for ${lang} unavailable: ${(err as Error).message}`)
  }

  const { Parser } = await getTreeSitter()
  const parser = new Parser()
  const out: Array<Omit<FunctionComplexity, 'file'>> = []
  let tree: ReturnType<InstanceType<Awaited<ReturnType<typeof getTreeSitter>>['Parser']>['parse']> =
    null
  try {
    parser.setLanguage(language)
    tree = parser.parse(code)
    if (!tree) return out

    const stack: TsNode[] = [tree.rootNode]
    while (stack.length > 0) {
      const node = stack.pop()!
      for (const child of node.children) if (child) stack.push(child)
      if (!isScope(node, rules)) continue
      out.push({
        function: scopeName(node, rules),
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        complexity: measureScope(node, rules)
      })
    }
  } finally {
    try {
      tree?.delete()
    } catch {
      /* best-effort */
    }
    try {
      parser.delete()
    } catch {
      /* best-effort */
    }
  }

  out.sort((a, b) => a.line - b.line || a.column - b.column)
  return out
}

// ── File discovery ──────────────────────────────────────────────────────────

/**
 * Hard cap per call. A .NET monorepo has tens of thousands of `.cs` files;
 * scanning all of them would blow the tool's time budget long before the
 * 15K-char output cap matters.
 */
export const MAX_FILES_PER_SCAN = 1500

/**
 * Collect analyzable files under `target`, reusing the indexer's exclusion
 * rules. SKIP_PATTERNS matters more here than for TS: without it a generated
 * `*.g.cs` / `*.designer.cs` / `*.pb.cs` file tops every C# complexity report
 * and buries the hand-written code the review is actually about.
 */
export function collectAnalyzableFiles(
  targetAbs: string,
  workspacePath: string,
  cap: number = MAX_FILES_PER_SCAN
): { files: string[]; truncated: boolean } {
  const files: string[] = []
  let truncated = false

  const accept = (abs: string): void => {
    if (files.length >= cap) {
      truncated = true
      return
    }
    if (!langForFile(abs)) return
    const rel = toPosixRel(abs, workspacePath)
    if (isExcludedPath(rel) || matchesSkipPattern(rel, SKIP_PATTERNS)) return
    try {
      if (statSync(abs).size > MAX_INDEXABLE_FILE_BYTES) return
    } catch {
      return
    }
    files.push(abs)
  }

  const walk = (dir: string): void => {
    if (files.length >= cap) {
      truncated = true
      return
    }
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= cap) {
        truncated = true
        return
      }
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || isExcludedDirName(entry.name)) continue
        walk(abs)
      } else if (entry.isFile()) {
        accept(abs)
      }
    }
  }

  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(targetAbs)
  } catch {
    return { files, truncated }
  }
  if (stat.isDirectory()) walk(targetAbs)
  else accept(targetAbs)

  return { files, truncated }
}

export interface TreeSitterScanResult {
  results: FunctionComplexity[]
  filesScanned: number
  truncated: boolean
  /** Files that could not be read or parsed — reported, never thrown. */
  failures: Array<{ file: string; error: string }>
}

/**
 * Score every C#/Java/Python file under the given workspace-relative paths.
 * Never throws: unreadable or unparsable files are collected as `failures` so
 * one bad file cannot take down the whole audit section.
 */
export async function analyzeTreeSitterComplexity(
  relPaths: string[],
  workspacePath: string,
  cap: number = MAX_FILES_PER_SCAN
): Promise<TreeSitterScanResult> {
  const seen = new Set<string>()
  let truncated = false
  for (const rel of relPaths) {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(workspacePath, rel)
    const found = collectAnalyzableFiles(abs, workspacePath, cap - seen.size)
    if (found.truncated) truncated = true
    for (const f of found.files) seen.add(f)
    if (seen.size >= cap) {
      truncated = true
      break
    }
  }

  const results: FunctionComplexity[] = []
  const failures: Array<{ file: string; error: string }> = []
  for (const abs of seen) {
    const lang = langForFile(abs)
    if (!lang) continue
    const rel = toPosixRel(abs, workspacePath)
    try {
      const scores = await computeFileComplexity(readFileSync(abs, 'utf-8'), lang)
      for (const s of scores) results.push({ file: rel, ...s })
    } catch (err) {
      failures.push({ file: rel, error: (err as Error).message })
    }
  }

  return { results, filesScanned: seen.size, truncated, failures }
}
