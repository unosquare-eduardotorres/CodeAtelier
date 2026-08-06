# Implementation Plan v5: Code Graph + Semantic Search

## Agentic Code Studio

---

## What changed from v4

Added **Phase 2C: Preprocessing Pipeline** — a dedicated stage between repomap scanning and ChromaDB embedding that treats every code chunk before it gets embedded. This is the difference between average and excellent retrieval quality across all projects in the studio.

All other phases (2A, 2B, 2D–2I) are unchanged from v4.

---

## Why preprocessing matters for a multi-project studio

A specialist querying "find the function that validates JWT tokens" needs the embedding to understand:

- This is a method on `AuthService`
- It lives in `src/auth/auth.service.ts`
- It imports `jsonwebtoken`
- It returns `boolean`

Without preprocessing, the raw function body is embedded in isolation. The model has none of that context. With preprocessing, all of it is baked into the embedding text before the vector is generated. When you embed `async getUser(id: string)`, the model doesn't inherently know this is inside a `UserService` class or that it uses a `Database`. By prepending this context, the embedding captures semantic relationships that pure code misses.

For a studio managing multiple different projects (different stacks, different naming conventions, different languages), this context injection is what makes retrieval generalize — a query written for a React project works differently from one written for a C# project, and the preprocessing layer is where that distinction gets encoded.

---

## Phase 2C: Preprocessing Pipeline

### Overview

The preprocessing pipeline sits between repomap's tag extraction and ChromaDB's `upsert`. Every chunk passes through it before a single vector is generated.

```
repomap tag list
      ↓
┌─────────────────────────────────────────────────────┐
│  PREPROCESSING PIPELINE                             │
│                                                     │
│  Stage 1: Noise filtering     (skip bad files)      │
│  Stage 2: Context injection   (prepend headers)     │
│  Stage 3: Scope enrichment    (class + imports)     │
│  Stage 4: NL description      (LLM-generated)       │
│  Stage 5: Metadata enrichment (structured tags)     │
│  Stage 6: Overlap handling    (chunk boundaries)    │
└─────────────────────────────────────────────────────┘
      ↓
ChromaDB upsert (embed the enriched text)
```

---

### Recommended library: `code-chunk`

Before implementing custom preprocessing, investigate this TypeScript library first:

- GitHub: https://github.com/supermemoryai/code-chunk
- npm: `npm install code-chunk`

It traverses the AST to extract semantic entities — functions, methods, classes, interfaces, types, and imports — and organizes them into a hierarchical scope tree. A method inside a class knows its parent. This enables providing scope context like `UserService > getUser`. The context is formatted into `contextualizedText`, optimized for embedding models to understand semantic relationships.

The `contextualizedText` it produces looks like:

```
# src/services/user.ts
# Scope: UserService
# Defines: async getUser(id: string): Promise<User>
# Uses: Database

async getUser(id: string): Promise<User> {
  return this.db.query('SELECT * FROM users WHERE id = ?', [id])
}
```

This is exactly what Stage 2 + Stage 3 below produce. Using `code-chunk` instead of building it from scratch saves 200+ lines of AST traversal code. Ask the user to evaluate it against their TypeScript/C#/React requirements before deciding whether to use it or build custom.

Reference: https://supermemory.ai/blog/building-code-chunk-ast-aware-code-chunking/

---

### Stage 1: Noise filtering

**Purpose:** Skip files that would pollute the index with irrelevant or auto-generated content. Embeddings of minified code, lock files, or generated protobuf types add noise that degrades retrieval quality for everything in the same collection.

**Single source of truth: `src/main/services/code-graph-exclusions.ts`.** Both indexers consume it, so the code graph and semantic search can never drift apart:

| Layer                              | Consumer                                                                              | Mechanism                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Directory pruning during discovery | `discoverSrcFiles()` (used by **both** `code-graph.service.ts` and `indexing.ipc.ts`) | `REPOMAP_EXCLUDED_DIRS` + `ADDITIONAL_EXCLUDED_DIRS` via `isExcludedDirName()`, plus `.gitignore` / `.atelierignore` |
| Incremental re-index               | `file-watcher.handler.ts`                                                             | `isExcludedPath()` + `matchesSkipPattern()` on the changed-file list                                                 |
| Late-stage chunk filter            | `preprocessing/file-validation.ts` → `shouldSkipFile()`                               | `isExcludedPath()` (case-insensitive) + `SKIP_PATTERNS` + caller-supplied `skipPatterns`                             |

`ADDITIONAL_EXCLUDED_DIRS` is **Tier 1** — tool-managed output that is never hand-written: `bin`, `obj`, `packages`, `Tools`, `ThirdParty`, `Pods`, `Carthage`, `DerivedData`, `xcuserdata`, `Binaries`, `Intermediate`, `DerivedDataCache`, `Saved`, `Temp`, `Logs`, `Builds`, `CMakeFiles`, `cmake-build-*`, `_deps`, `vcpkg_installed`, `conan`, `site-packages`, `bower_components`, `jspm_packages`, `Godeps`, `_site`, `storybook-static`, … Matching is case-insensitive (Windows NTFS / macOS HFS+).

Generic names (`lib`, `libs`, `Library`, `external`, `deps`, `plugins`, `shared`, …) are **Tier 2** — listed in `TIER2_CANDIDATE_DIRS` and never excluded by default, because they are just as often first-party code.

**Exclusion preflight** (`index-exclusion-preflight.service.ts`) runs before indexing starts. It walks the workspace breadth-first (max depth 6, 3-second budget), gathers evidence per candidate directory — `git check-ignore`, `git ls-files`, vendor markers (`LICENSE`, `*.podspec`, `Package.swift`, `*.nuspec`, `bower.json`, `CMakeLists.txt`), file-extension mix — and classifies:

1. `gitIgnored` → **auto-exclude**
2. Tier-1 name → **auto-exclude** (listed for transparency only; already hardcoded)
3. > 80% binaries → **auto-exclude**
4. Tier-2 + vendor markers → **needs confirmation**, checkbox pre-checked
5. Tier-2 + tracked source → **needs confirmation**, checkbox **unchecked**, badged "contains source code committed to git"
6. Otherwise → **keep**

Confirmed exclusions are appended to the repository's `.atelierignore` (not to per-machine settings), so both indexers and every clone inherit the decision. A preflight failure is logged and ignored — it must never block indexing.

**Remaining file-level patterns (`SKIP_PATTERNS`):**

```typescript
export const SKIP_PATTERNS = [
  ...excludedDirGlobs(), // derived from ADDITIONAL_EXCLUDED_DIRS

  // Package managers
  '**/node_modules/**',
  '**/vendor/**',
  '**/.pnp/**',

  // Build output not covered by the shared directory set
  '**/dist/**',
  '**/build/**',
  '**/.next/**',

  // Generated files
  '**/*.generated.ts',
  '**/*.generated.cs',
  '**/*.g.cs', // C# source generators
  '**/*.g.tsx',
  '**/*.designer.cs',
  '**/migrations/**', // DB migrations (usually auto-generated)
  '**/*.pb.ts', // Protobuf generated
  '**/*.pb.cs',

  // Minified / compiled
  '**/*.min.js',
  '**/*.min.css',
  '**/*.bundle.js',
  '**/*.chunk.js',

  // Lock files and configs with no semantic content
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',

  // Test snapshots (large, auto-generated)
  '**/__snapshots__/**',
  '**/*.snap',

  // Assets
  '**/*.svg',
  '**/*.png',
  '**/*.jpg',
  '**/*.ico',
  '**/*.woff',
  '**/*.ttf'
]
```

**Content-based filters (applied after loading):**

```typescript
function shouldSkipFile(filePath: string, content: string): boolean {
  // Skip auto-generated files by header comment
  const firstLines = content.slice(0, 500).toLowerCase()
  if (
    firstLines.includes('auto-generated') ||
    firstLines.includes('this file is automatically generated') ||
    firstLines.includes('do not edit') ||
    firstLines.includes('generated by') ||
    firstLines.includes('@generated') ||
    firstLines.includes('<auto-generated>') // C# pattern
  )
    return true

  // Skip minified files (very long lines, no newlines)
  const lines = content.split('\n')
  const avgLineLength = content.length / Math.max(lines.length, 1)
  if (avgLineLength > 500) return true

  // Skip files with almost no alphanumeric content (binary-ish)
  const alphanumRatio = (content.match(/[a-zA-Z0-9]/g)?.length ?? 0) / content.length
  if (alphanumRatio < 0.3) return true

  return false
}
```

Ask the user if there are project-specific patterns to add (e.g. scaffolding output, ORM-generated models, client SDK output from OpenAPI specs).

---

### Stage 2: Context injection (Contextual Chunk Headers)

**Purpose:** Prepend a structured header to every chunk before embedding. This is the single highest-impact treatment. Contextual chunk headers give embeddings a much more accurate and complete representation of the content — leading to a substantial improvement in retrieval quality and reducing the rate at which irrelevant results show up.

**Header format:**

```typescript
function buildChunkHeader(chunk: FileChunk): string {
  const parts: string[] = []

  // File path (last 3 segments to keep it concise)
  const shortPath = chunk.filePath.split('/').slice(-3).join('/')
  parts.push(`# File: ${shortPath}`)

  // Language
  parts.push(`# Language: ${chunk.language}`)

  // Scope chain (e.g. "UserService > validateJwt")
  if (chunk.className) {
    parts.push(`# Scope: ${chunk.className} > ${chunk.symbolName}`)
  } else {
    parts.push(`# Scope: ${chunk.symbolName}`)
  }

  // Symbol kind and visibility
  const visibility = chunk.isPublic ? 'public' : 'private'
  parts.push(`# Kind: ${visibility} ${chunk.symbolKind}`)

  // Full signature
  parts.push(`# Signature: ${chunk.signature}`)

  // Key imports used by this chunk
  if (chunk.imports.length > 0) {
    parts.push(`# Uses: ${chunk.imports.slice(0, 8).join(', ')}`)
  }

  // Blank line separator before code
  parts.push('')

  return parts.join('\n')
}

// Final embed text = header + code body
function buildEmbedText(chunk: FileChunk): string {
  return buildChunkHeader(chunk) + chunk.body
}
```

**Example output for a TypeScript method:**

```
# File: src/auth/auth.service.ts
# Language: TypeScript
# Scope: AuthService > validateJwt
# Kind: public method
# Signature: validateJwt(token: string): boolean
# Uses: jsonwebtoken, ConfigService, Logger

validateJwt(token: string): boolean {
  try {
    const secret = this.configService.get('JWT_SECRET')
    jwt.verify(token, secret)
    return true
  } catch {
    return false
  }
}
```

**Example output for a C# method:**

```
# File: Services/Auth/AuthService.cs
# Language: C#
# Scope: AuthService > ValidateJwt
# Kind: public method
# Signature: public bool ValidateJwt(string token)
# Uses: System.IdentityModel.Tokens.Jwt, IConfiguration, ILogger

public bool ValidateJwt(string token) {
  try {
    var handler = new JwtSecurityTokenHandler();
    handler.ValidateToken(token, _validationParams, out _);
    return true;
  } catch { return false; }
}
```

The embedding model now understands this is auth-related, in a service class, dealing with JWT — without needing to read any other file.

---

### Stage 3: Scope enrichment

**Purpose:** For methods inside large classes (God classes, service classes, controllers), add the class-level context. For a large class, create an embedding for individual methods separately but include the class definition and relevant imports with each method chunk. When a specific method is retrieved, the AI model has the full context needed to understand and work with that method.

```typescript
interface ScopeContext {
  className: string
  classKind: 'class' | 'interface' | 'abstract class' | 'record' // C# etc.
  classSignature: string // e.g. "class AuthService implements IAuthService"
  classDecorators: string[] // e.g. ["@Injectable()", "@Controller('/auth')"]
  parentClassImports: string[] // imports at the top of the class file
  siblingMethodSignatures: string[] // other public methods (signatures only, not bodies)
}
```

Sibling method signatures are particularly valuable — they tell the embedding model what else this class does, which helps when a query describes a workflow ("find where payment is initiated and where it's confirmed" — both methods are siblings in `PaymentService`).

**Condensed sibling section added to embed text:**

```
# Class: AuthService implements IAuthService
# Class decorators: @Injectable()
# Other public methods: login(), logout(), refreshToken(), getCurrentUser()

validateJwt(token: string): boolean { ... }
```

---

### Stage 4: Natural language description generation

**Purpose:** Generate a one-sentence plain English description of each chunk using Claude. This is the most expensive preprocessing step but also the one that most directly bridges the gap between how developers query ("find the thing that checks if a user is logged in") and how the code is named (`validateJwt`, `checkSession`, `isAuthenticated` — any of these might be the right answer).

**How it works:**

```typescript
const DESCRIPTION_PROMPT = `You are analyzing source code for a search index.
Write ONE sentence describing what this code does in plain English.
Focus on: what it does, what it returns, when it's used.
Do NOT include the function name or file path.
Keep it under 20 words.

Code:
{code}

One-sentence description:`

async function generateDescription(
  chunk: FileChunk,
  model = 'claude-haiku-4-5-20251001' // Use cheapest model — task is simple
): Promise<string> {
  // Use a fast, cheap model — descriptions are simple one-liners
  const response = await anthropic.messages.create({
    model,
    max_tokens: 60,
    messages: [
      {
        role: 'user',
        content: DESCRIPTION_PROMPT.replace('{code}', chunk.body.slice(0, 800))
      }
    ]
  })
  return response.content[0].type === 'text' ? response.content[0].text.trim() : ''
}
```

**The description is prepended to the embed text, not stored as a comment:**

```
Verifies a JWT token's signature and expiry date, returning false if invalid.

# File: src/auth/auth.service.ts
# Scope: AuthService > validateJwt
...
validateJwt(token: string): boolean { ... }
```

**Cost and timing considerations:**

This is an API call per chunk. For a 500-file project with ~5,000 chunks:

- Using `claude-haiku-4-5-20251001`: approximately $0.005–0.02 total (very cheap)
- Time: ~2-5ms per chunk with batching = ~10-25 seconds additional indexing time
- This is a one-time cost per chunk — cached until the file changes

**Important:** Make descriptions optional and toggled separately from the main semantic search feature. Some users may not want any API calls during indexing (air-gapped environments, cost-sensitive setups).

Store in settings:

```typescript
interface WorkspaceSettings {
  semanticSearchEnabled: boolean
  semanticSearchDescriptions: boolean // ← new toggle: "Enhance with AI descriptions"
  ollamaModel: string
}
```

**Caching descriptions:** Store generated descriptions in a separate SQLite cache (similar to repomap's tag cache) keyed by `filePath + symbolName + contentHash`. Never regenerate a description for unchanged code.

```typescript
// Cache schema
interface DescriptionCache {
  key: string // sha256(filePath + symbolName + body)
  description: string
  generatedAt: Date
  model: string // track which model generated it
}
```

References:

- Claude Haiku pricing: https://www.anthropic.com/pricing
- Anthropic SDK TypeScript: https://github.com/anthropic-ai/sdk-python (confirm TS version with user)

---

### Stage 5: Metadata enrichment

**Purpose:** Store rich structured metadata in ChromaDB alongside each vector. This enables filtered queries — specialists can ask "find public TypeScript methods in the auth module" without that being a semantic search question at all.

```typescript
interface ChunkMetadata {
  // Location
  filePath: string
  fileName: string
  directory: string // e.g. "src/auth"
  projectName: string // for multi-project queries later

  // Symbol
  symbolName: string
  symbolKind: 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'const'
  className: string | null
  signature: string
  startLine: number
  endLine: number

  // Language
  language: 'typescript' | 'csharp' | 'javascript' | 'tsx' | 'jsx' | 'css' | string

  // Visibility and structure
  isPublic: boolean
  isAsync: boolean
  isStatic: boolean
  isAbstract: boolean // C# / TypeScript abstract
  hasTests: boolean // does a *.test.ts / *.spec.ts exist for this file?

  // Dependencies (from repomap graph)
  importedBy: string[] // files that import this file (from repomap)
  pageRank: number // repomap PageRank score

  // Content signals
  hasDocstring: boolean // has JSDoc / XML doc comment
  lineCount: number
  hasDescription: boolean // was AI description generated?

  // Timestamps
  lastModified: number // file mtime — for cache invalidation
  indexedAt: number
}
```

**How `importedBy` and `pageRank` get here:** These come directly from repomap's tag data and dependency graph — pass them through the preprocessing pipeline from the repomap output rather than re-computing them.

**Using metadata filters in `semantic_search`:**

```typescript
// Example: specialist searches only in TypeScript auth files
const results = await collection.query({
  queryEmbeddings: [queryEmbedding],
  nResults: 5,
  where: {
    $and: [
      { language: { $eq: 'typescript' } },
      { directory: { $contains: 'auth' } },
      { isPublic: { $eq: true } }
    ]
  }
})
```

This is much more precise than relying on semantic similarity alone for structural queries.

---

### Stage 6: Overlap handling

**Purpose:** Prevent context loss at chunk boundaries. When a long method gets split, the second chunk shouldn't start mid-logic without any context from the first.

Chunks can include the last N lines from the previous chunk. This helps with queries that target code at chunk boundaries.

For your studio this is most relevant for:

- Long React components (JSX return statement split from hooks)
- Long C# methods with multiple try/catch blocks
- Long TypeScript class constructors with DI injection

```typescript
const OVERLAP_LINES = 5 // Include last 5 lines of previous chunk

// When a symbol body exceeds MAX_CHUNK_LINES, split with overlap
const MAX_CHUNK_LINES = 80 // ~400 tokens for qwen3-embedding:4b

function splitLongChunk(chunk: FileChunk): FileChunk[] {
  const lines = chunk.body.split('\n')
  if (lines.length <= MAX_CHUNK_LINES) return [chunk]

  const parts: FileChunk[] = []
  let start = 0
  let partIndex = 0

  while (start < lines.length) {
    const end = Math.min(start + MAX_CHUNK_LINES, lines.length)
    const overlap = start > 0 ? lines.slice(start - OVERLAP_LINES, start) : []

    parts.push({
      ...chunk,
      id: `${chunk.id}::part${partIndex}`,
      body: [...overlap, ...lines.slice(start, end)].join('\n'),
      startLine: chunk.startLine + start - (start > 0 ? OVERLAP_LINES : 0),
      endLine: chunk.startLine + end,
      symbolName: `${chunk.symbolName} (part ${partIndex + 1}/${Math.ceil(lines.length / MAX_CHUNK_LINES)})`
    })

    start = end
    partIndex++
  }

  return parts
}
```

---

### Full preprocessing pipeline function

This is the single function that every chunk passes through before embedding:

```typescript
async function preprocessChunk(
  rawChunk: RawChunk, // from repomap tag extraction
  fileContent: string, // raw file content
  scopeContext: ScopeContext | null, // class context if method
  options: PreprocessingOptions
): Promise<ProcessedChunk | null> {
  // Stage 1: Noise filtering
  if (shouldSkipFile(rawChunk.filePath, fileContent)) return null

  // Stage 2 + 3: Context injection + scope enrichment
  const withHeader = buildEmbedText({
    ...rawChunk,
    imports: extractRelevantImports(fileContent, rawChunk),
    className: scopeContext?.className ?? null,
    classSignature: scopeContext?.classSignature ?? null,
    siblingSignatures: scopeContext?.siblingMethodSignatures ?? []
  })

  // Stage 4: NL description (optional, async)
  let description = ''
  if (options.generateDescriptions) {
    description = await descriptionCache.getOrGenerate(rawChunk, withHeader)
  }

  // Stage 5: Metadata enrichment
  const metadata = buildMetadata(rawChunk, scopeContext, fileContent)

  // Stage 6: Overlap handling (split if too long)
  const chunks = splitLongChunk({
    ...rawChunk,
    body: withHeader,
    metadata
  })

  // Final embed text = description + contextual header + code
  return chunks.map((chunk) => ({
    ...chunk,
    embedText: description ? `${description}\n\n${chunk.body}` : chunk.body,
    metadata
  }))
}
```

---

### Preprocessing options per workspace

Add to workspace settings (allows per-project tuning):

```typescript
interface PreprocessingSettings {
  generateDescriptions: boolean // AI descriptions (costs API tokens)
  descriptionModel: string // which Claude model for descriptions
  maxChunkLines: number // default 80
  overlapLines: number // default 5
  skipPatterns: string[] // additional patterns beyond defaults
  includePrivateMethods: boolean // default true — set false for huge codebases
  includeSiblingSignatures: boolean // default true
}
```

---

### Processing order and parallelism

Preprocessing is the slowest stage in the indexing pipeline. Run it with controlled concurrency to avoid overwhelming Ollama or the API:

```typescript
async function runPreprocessingPipeline(
  tags: RepomapTag[],
  options: PreprocessingSettings,
  onProgress: (state: IndexingState) => void
): Promise<ProcessedChunk[]> {
  const results: ProcessedChunk[] = []

  // Process files in parallel (concurrency: 5)
  // Process chunks within each file serially (to maintain scope context)
  await pMap(
    groupByFile(tags),
    async (fileTags) => {
      const fileContent = await fs.readFile(fileTags[0].filePath, 'utf-8')

      // Stage 1 check at file level
      if (shouldSkipFile(fileTags[0].filePath, fileContent)) {
        onProgress({ ...state, filesSkipped: state.filesSkipped + 1 })
        return
      }

      const scopeContexts = buildScopeContexts(fileTags)

      for (const tag of fileTags) {
        // Pause checkpoint
        while (options.paused) await sleep(100)
        if (options.cancelled) return

        const processed = await preprocessChunk(
          tag,
          fileContent,
          scopeContexts.get(tag.symbolName) ?? null,
          options
        )

        if (processed) results.push(...processed)
        onProgress(/* update progress */)
      }
    },
    { concurrency: 5 }
  )

  return results
}
```

Reference for `p-map`: https://github.com/sindresorhus/p-map (controlled concurrency, handles errors gracefully)

---

### Description cache schema

Store in `app.getPath('userData')/description-cache.db` (SQLite via `better-sqlite3`):

```sql
CREATE TABLE descriptions (
  key TEXT PRIMARY KEY,           -- sha256(filePath + symbolName + bodyHash)
  description TEXT NOT NULL,
  model TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  file_path TEXT NOT NULL,        -- for invalidation by file
  symbol_name TEXT NOT NULL
);

CREATE INDEX idx_file_path ON descriptions(file_path);
```

When a file changes (chokidar fires), delete all description cache entries for that file path and regenerate only those chunks.

References:

- better-sqlite3: https://github.com/WiseLibs/better-sqlite3
- Node.js crypto for hashing: https://nodejs.org/api/crypto.html

---

## Updated indexing stages with preprocessing

The `IndexingState` from v4 gains two new stages:

```typescript
export interface IndexingState {
  status:
    | 'idle'
    | 'scanning' // repomap scanning files
    | 'preprocessing' // NEW: noise filter + headers + descriptions
    | 'indexing-files' // embedding file-level chunks
    | 'indexing-chunks' // embedding symbol-level chunks
    | 'paused'
    | 'complete'
    | 'error'

  // ... existing fields ...

  // NEW: preprocessing stage
  preprocessTotal: number
  preprocessComplete: number
  preprocessSkipped: number // noise-filtered files
  descriptionsGenerated: number
  descriptionsCached: number
}
```

**Updated progress UI states:**

```
PREPROCESSING:
  Preprocessing code...
  ████░░░░░░░░░░░░░░░░  18%
  892 / 5,000 chunks  ·  47 files skipped  ·  ~30s remaining
  Currently: src/auth/auth.service.ts
  AI descriptions: 234 generated  ·  128 from cache
  [Pause]
```

---

## Updated files changed summary

| File                               | Change                                                                | Phase |
| ---------------------------------- | --------------------------------------------------------------------- | ----- |
| `package.json`                     | Add `chromadb`, `code-chunk`, `p-map`, `better-sqlite3`               | 2     |
| NEW `ollama-manager.service.ts`    | Ollama detection, pull, embed                                         | 2A    |
| NEW `preprocessing.service.ts`     | All 6 preprocessing stages, description cache                         | 2C    |
| NEW `description-cache.service.ts` | SQLite cache for AI descriptions                                      | 2C    |
| NEW `vector-search.service.ts`     | ChromaDB, indexProject (calls preprocessing), queryFiles, queryChunks | 2B+2C |
| `mcp-server.service.ts`            | Add vector results to enrichFilesDiscussed                            | 2     |
| `generalist.service.ts`            | Parallel query (repomap + vector files)                               | 2     |
| NEW `semantic-search.tool.ts`      | Tool for specialists                                                  | 2D    |
| NEW `ollama-manager.ipc.ts`        | Ollama download IPC                                                   | 2A    |
| NEW `indexing.ipc.ts`              | Indexing start/pause/resume/cancel/progress IPC                       | 2D    |
| `preload/index.ts`                 | Expose new IPC channels                                               | 2     |
| `RepositorySettingsTab.tsx`        | Code Intelligence + Preprocessing settings sections                   | 2     |
| NEW `OllamaSetupModal.tsx`         | Download flow modal                                                   | 2A    |
| NEW `IndexingProgressPanel.tsx`    | Progress UI with preprocessing stage                                  | 2D    |
| `.gitignore`                       | Add `./chroma/`, `./description-cache.db`                             | 2     |

---

## Questions to ask the user before implementing Phase 2C

- [ ] Show me how the studio currently reads file content — is there a `FileService` or similar utility I should use instead of raw `fs.readFile`?
- [ ] What is the typical project size in your studio — average file count, largest project? This determines whether description generation is practical at indexing time
- [ ] Are there project-specific auto-generated file patterns I should add to the noise filter (ORM output, scaffold output, client SDK generation)?
- [ ] For C# projects: are there `.designer.cs`, `.g.cs`, or other generated patterns beyond the defaults?
- [ ] For React projects: are there specific patterns like Storybook stories, generated component index files, or similar that should be skipped?
- [ ] Should AI descriptions be ON by default, or opt-in? (Recommendation: opt-in, since it costs API tokens)
- [ ] Do you want to expose `includePrivateMethods` as a user setting, or always index everything?
- [ ] Show me where workspace settings are persisted — I need to add the preprocessing settings schema there

---

## Implementation order for Phase 2C

Implement preprocessing stages in this order — each one is independently testable:

1. **Stage 1 (noise filter)** — test against a real project, verify the right files are skipped
2. **Stage 2 (context injection)** — embed 10 chunks with and without headers, compare retrieval manually
3. **Stage 5 (metadata enrichment)** — wire ChromaDB metadata, test filtered queries
4. **Stage 3 (scope enrichment)** — add sibling signatures, test God class scenarios
5. **Stage 6 (overlap handling)** — test with the largest files in a real project
6. **Stage 4 (descriptions)** — add last, it's the most expensive and the rest must work first. Build the SQLite cache before generating a single description.

---

## References

- code-chunk library: https://github.com/supermemoryai/code-chunk
- cAST paper (AST chunking research): https://arxiv.org/html/2506.15655v1
- Contextual chunk headers technique: https://github.com/NirDiamant/RAG_Techniques/blob/main/all_rag_techniques/contextual_chunk_headers.ipynb
- Qodo RAG for 10k repos (context injection): https://www.qodo.ai/blog/rag-for-large-scale-code-repos/
- p-map (controlled async concurrency): https://github.com/sindresorhus/p-map
- better-sqlite3 (description cache): https://github.com/WiseLibs/better-sqlite3
- ChromaDB metadata filtering: https://docs.trychroma.com/guides#filtering-by-metadata
- qwen3-embedding:4b (Ollama): https://ollama.com/library/qwen3-embedding
