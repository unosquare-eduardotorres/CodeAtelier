# Implementation Plan: Code Graph + Semantic Search for Agentic Code Studio

## Context for this session

You are helping build two features into an existing **agentic code studio** built with the **Claude Agents SDK**. The studio currently has:
- A generalist/orchestrator agent (merged into one)
- Specialist subagents (reviewer, fixer, planner)
- No code graph or vector search yet

You are adding both from scratch, in this order:

1. **repomap-mcp** — the code graph layer (Tree-sitter + PageRank, runs as a local MCP server)
2. **ChromaDB + Ollama** — the semantic/vector search layer (feeds off repomap's output)

**You do not have access to the studio's source code.** Before writing any code, ask the user to share:
- Their project structure (folder layout)
- Their orchestrator code (the part that decides to spawn specialists)
- Their current MCP client setup and how tools are registered
- Their `package.json` and Node.js/TypeScript versions
- How specialists currently receive context (what gets passed to them)

Do not assume class names, file paths, or architecture details. Everything below is a neutral guide.

---

## Background: why this order matters

repomap-mcp is not just a search tool — it IS the code graph layer. It provides:
- Tree-sitter parsing of all source files (TypeScript, C#, React/TSX, JS, 40+ languages)
- A ranked list of files + their defined symbols, ordered by cross-file importance (PageRank)
- A dependency picture: which files reference which other files
- A local SQLite tag cache (auto-managed, no setup needed)

ChromaDB then uses that symbol data as the content to embed — you need repomap working first before you can build the vector layer on top of it.

---

## Phase 1: repomap-mcp (the code graph)

### What it is
A local MCP server that runs as a subprocess on the same machine as your studio. Your orchestrator calls it as a tool. It reads your project files, parses them with Tree-sitter, builds a dependency graph, runs PageRank, and returns a ranked text summary of the most important files and symbols — sized to fit a token budget.

No external database. No separate server to manage. The only artifact it creates is a `.repomap.tags.cache/` folder inside your project (add to `.gitignore`).

### References
- GitHub (TypeScript version, recommended): https://github.com/fl0w1nd/repomap-mcp
- npm package: https://www.npmjs.com/package/repomap-mcp
- How the algorithm works (Aider's original writeup): https://aider.chat/2023/10/22/repomap.html
- Full architecture breakdown: https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping-system
- Language support list: https://aider.chat/docs/languages.html
- Python version (RepoMapper, alternative): https://github.com/pdavis68/RepoMapper

### Install
```bash
# Recommended: pin a specific version so maintainer updates don't break you
npm install repomap-mcp

# Or use npx for quick testing (always pulls latest)
npx repomap-mcp --root ./src
```

### MCP configuration
Ask the user how their Claude Agents SDK is currently configured for MCP. The pattern varies depending on their SDK version and setup. The general shape is:

```json
{
  "mcpServers": {
    "repomap": {
      "command": "npx",
      "args": ["repomap-mcp", "--root", "/absolute/path/to/project"]
    }
  }
}
```

For a studio that works on multiple projects, investigate whether the project root can be passed as a tool parameter rather than a startup arg. The `repo_map` tool accepts `projectRoot` as a call-time parameter, so one running MCP server instance can serve multiple projects.

Reference for Claude Agents SDK MCP setup: https://docs.anthropic.com/en/docs/agents-and-tools/mcp

### The tool call
Once registered, the orchestrator calls it like any other MCP tool:

```typescript
// Shape — adapt to the user's actual MCP client API
const repoContext = await mcpClient.callTool('repo_map', {
  projectRoot: '/absolute/path/to/project',
  mapTokens: 2048,  // how many tokens of output to return
  // optional: boost files already known to be relevant
  // chatFiles: ['src/auth/login.ts'],
  // mentionedIdentifiers: ['UserService'],
});
```

The tool returns a formatted string like:
```
src/auth/UserService.ts  (rank: 8.4)
  class UserService
  validateCredentials(username, password)
  createSession(userId)

src/middleware/auth.ts  (rank: 6.1)
  authMiddleware
  requireRole(role)
...
```

### Where to call it in the orchestrator
**Before any Claude API call that involves code changes.** The pattern is:

```
User sends task
       ↓
Detect code-change intent (is this a code task or a conversational question?)
       ↓
Call repo_map(projectRoot, task)   ← NEW: happens here, before Claude
       ↓
Inject ranked map into system prompt
       ↓
Claude decomposes task, spawns specialists
       ↓
Specialists receive their file slice (already pre-scoped)
```

Ask the user to show you the exact point in their orchestrator where they currently call Claude for task decomposition. The repo_map call goes just before that.

System prompt injection pattern:
```typescript
const systemPrompt = `
You are a code orchestrator. The following files are most relevant 
to this task, ranked by importance:

${repoContext}

When decomposing this task into subtasks, assign specialists only 
files from this list unless you have a strong reason to look elsewhere.
`;
```

### Questions to ask the user before implementing Phase 1
- [ ] Show me your orchestrator code — specifically where you call Claude for decomposition
- [ ] How is your MCP client currently set up? Show me where you register/call tools
- [ ] Is the project root a fixed path or does it change per task/session?
- [ ] What version of the Claude Agents SDK are you using?
- [ ] Do you want repomap called on every task, or only when code changes are detected?

---

## Phase 2: ChromaDB + Ollama (semantic/vector search)

**Start this phase only after Phase 1 is working and tested.**

### What it adds
repomap finds files by structural importance and symbol name. Vector search finds files by *meaning* — if the user says "fix the authentication bug" and the relevant file is called `session-handler.ts`, repomap might not surface it highly (wrong name), but vector search will (semantically related to auth).

Together they cover both cases:
- Graph/repomap ≈ structural + symbol-name search
- Vector ≈ semantic / meaning-based search
- mergeAndRank ≈ combines both scores

### Stack (fully local, zero cost)

| Component | Tool | Install |
|-----------|------|---------|
| Embedding model | `nomic-embed-text` via Ollama | https://ollama.com |
| Vector store | ChromaDB | `npm install chromadb` |
| File watcher | chokidar | `npm install chokidar` |

### References
- Ollama (download + install): https://ollama.com
- nomic-embed-text model page: https://ollama.com/library/nomic-embed-text
- nomic-embed-code (code-specific alternative, may perform better): https://ollama.com/library/nomic-embed-code
- ChromaDB TypeScript quickstart: https://docs.trychroma.com/getting-started
- ChromaDB JS client GitHub: https://github.com/chroma-core/chroma/tree/main/clients/js
- chokidar GitHub: https://github.com/paulmillr/chokidar
- Ollama + ChromaDB integration example: https://cookbook.chromadb.dev/integrations/ollama/embeddings/

### Setup
```bash
# 1. Install Ollama from https://ollama.com, then:
ollama pull nomic-embed-text

# 2. Install npm packages
npm install chromadb chokidar
```

Verify Ollama is running:
```bash
curl http://localhost:11434/api/embeddings \
  -d '{"model": "nomic-embed-text", "prompt": "test"}'
# Should return a JSON object with an "embedding" array
```

### Core functions

Ask the user where they want these to live in their project structure before creating files.

**embed() — local Ollama call, zero cost**
```typescript
async function embed(text: string): Promise<number[]> {
  const res = await fetch('http://localhost:11434/api/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text })
  });
  const { embedding } = await res.json();
  return embedding;
}
```

**getOrCreateCollection() — one collection per project**
```typescript
import { ChromaClient } from 'chromadb';

const chroma = new ChromaClient(); // uses ./chroma by default for local storage

async function getCollection(projectName: string) {
  // Use a sanitized project name as collection name
  // ChromaDB collection names must be 3-63 chars, alphanumeric + hyphens
  return chroma.getOrCreateCollection({ 
    name: projectName.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  });
}
```

**indexProject() — run at startup, after repomap has scanned the project**

The key question: what data comes back from repomap? Ask the user to log the raw output of a `repo_map` tool call so you can see the exact format. You need to parse file paths and symbols from that output to build the embed text per file.

Alternatively, repomap exposes a `search_identifiers` tool that returns structured data — investigate whether that's easier to parse than the map text output.

```typescript
async function indexProject(
  projectName: string,
  // The shape below is a guess — confirm with the user
  // what data their repomap call actually returns
  files: Array<{ path: string; symbols: string[]; rank?: number }>
) {
  const collection = await getCollection(projectName);

  // Process in batches to avoid overwhelming Ollama
  const BATCH_SIZE = 20;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (file) => {
      const text = `${file.path}\n${file.symbols.join(', ')}`;
      const embedding = await embed(text);
      await collection.upsert({
        ids: [file.path],
        embeddings: [embedding],
        documents: [text],
        metadatas: [{
          path: file.path,
          rank: file.rank ?? 0,
        }]
      });
    }));
  }
}
```

**semanticSearch() — called per task by orchestrator**
```typescript
async function semanticSearch(
  projectName: string,
  query: string,
  topK = 8
): Promise<Array<{ path: string; score: number }>> {
  const collection = await getCollection(projectName);
  const queryEmbedding = await embed(query);

  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: topK,
  });

  return results.ids[0].map((id, i) => ({
    path: id as string,
    // ChromaDB returns distance (lower = more similar), invert for score
    score: 1 - (results.distances?.[0][i] ?? 0),
  }));
}
```

**mergeAndRank() — combines repomap + vector results**

The 0.6/0.4 split below is a starting point. Log results in production and tune based on which files specialists actually use.

```typescript
interface FileResult {
  path: string;
  score: number;
}

function mergeAndRank(
  repomapResults: FileResult[],  // from repomap tool call (parse ranked files from text)
  vectorResults: FileResult[],   // from semanticSearch()
  maxFiles = 12
): FileResult[] {
  const scores = new Map<string, number>();

  for (const r of repomapResults) {
    scores.set(r.path, (scores.get(r.path) ?? 0) + r.score * 0.6);
  }
  for (const r of vectorResults) {
    scores.set(r.path, (scores.get(r.path) ?? 0) + r.score * 0.4);
  }

  return [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, maxFiles)
    .map(([path, score]) => ({ path, score }));
}
```

Note: to use repomap results in mergeAndRank, you need to parse the ranked file list out of repomap's text output and normalize scores to 0–1. Ask the user to show you a real repomap output sample so you can write the right parser.

**chokidar watcher — keeps both stores fresh after file changes**
```typescript
import chokidar from 'chokidar';

function startWatcher(projectRoot: string, projectName: string) {
  const pending = new Map<string, 'upsert' | 'delete'>();
  let debounceTimer: NodeJS.Timeout;

  chokidar.watch(projectRoot, {
    ignoreInitial: true,
    ignored: [
      '**/node_modules/**',
      '**/.repomap.tags.cache/**',
      '**/chroma/**',
      '**/.git/**',
    ]
  })
    .on('add',    path => queue(path, 'upsert'))
    .on('change', path => queue(path, 'upsert'))
    .on('unlink', path => queue(path, 'delete'));

  function queue(path: string, event: 'upsert' | 'delete') {
    pending.set(path, event);
    clearTimeout(debounceTimer);
    // 300ms window: if specialists write 10 files quickly, process once
    debounceTimer = setTimeout(() => flush(), 300);
  }

  async function flush() {
    const batch = new Map(pending);
    pending.clear();

    const collection = await getCollection(projectName);

    for (const [path, event] of batch) {
      if (event === 'upsert') {
        // Re-embed in ChromaDB
        // Note: you need the symbol list to re-embed properly.
        // Options:
        // A) re-call repo_map for just this file (if repomap supports single-file query)
        // B) read the file and extract a best-effort embed from its content
        // C) embed just the file path for now and accept lower quality on changed files
        // Investigate repomap's search_identifiers tool — it may support per-file queries
        const text = path; // placeholder — replace with actual symbol extraction
        const embedding = await embed(text);
        await collection.upsert({
          ids: [path],
          embeddings: [embedding],
          documents: [text],
          metadatas: [{ path }]
        });
      } else {
        await collection.delete({ ids: [path] });
      }
    }
    // Note: repomap's cache updates automatically on next tool call (mtime-based)
    // No manual repomap update needed here
  }
}
```

**Important note on the watcher + repomap:** repomap handles its own cache invalidation automatically. When a file changes and you call `repo_map` next time, it re-parses that file on its own. You only need the watcher for ChromaDB.

### Updated orchestrator flow with both features

```typescript
// In orchestrator, before calling Claude for decomposition:

const [repomapOutput, vectorResults] = await Promise.all([
  mcpClient.callTool('repo_map', {
    projectRoot,
    mapTokens: 2048,
  }),
  semanticSearch(projectName, taskDescription, 8),
]);

// Parse repomap output into structured results
// (write a parser based on the actual output format — ask user to log it)
const repomapResults = parseRepomapOutput(repomapOutput);

// Merge both
const rankedFiles = mergeAndRank(repomapResults, vectorResults);

// Inject into system prompt
const systemPrompt = `
You are a code orchestrator. The following files are most relevant 
to this task (combined structural + semantic ranking):

${rankedFiles.map(f => `- ${f.path} (score: ${f.score.toFixed(2)})`).join('\n')}

Assign specialists only files from this list.
`;
```

### Questions to ask the user before implementing Phase 2
- [ ] Is Ollama already installed on your machine?
- [ ] Show me a real sample of what `repo_map` returns — I need to parse it
- [ ] Does `repo_map` have a way to query a single file's symbols? (for the watcher)
- [ ] One ChromaDB collection per project, or one global collection with project filter?
- [ ] Where should ChromaDB persist its data? (default: `./chroma` relative to process)
- [ ] Should the startup indexer block the studio from running until complete, or run in background?

---

## Decisions to make with the user

**Embedding model choice:**
- `nomic-embed-text` — general purpose, well tested, good baseline
- `nomic-embed-code` — code-specific, potentially better for symbol/file retrieval
- Test both on a real project and compare retrieval quality before committing
- Reference: https://ollama.com/library/nomic-embed-code

**What to embed per file:**
- Minimal: `filePath + symbolNames` (fast, low noise)
- Richer: `filePath + symbolNames + function signatures` (slower, more context)
- Richest: first N lines of file content (catches file-level docstrings and comments)
- Start minimal, enrich only if retrieval quality is poor

**Collection isolation:**
- One collection per project (cleanest, matches repomap's per-project isolation)
- One global collection with project metadata filter (enables cross-project search later)
- Recommendation: start per-project, same model as repomap

**mergeAndRank weight tuning:**
- Starting point: graph 0.6, vector 0.4
- After 1–2 weeks of real use: log which files from the merged list specialists actually read
- If they mostly use graph-surfaced files → increase graph weight
- If they mostly use vector-surfaced files → increase vector weight

**Token budget for repomap:**
- Default: 1024 tokens
- For large context window models (Claude Sonnet/Opus): try 2048–4096
- Larger = more files surfaced, but more tokens consumed per orchestrator call

---

## Full implementation checklist

### Phase 1: repomap-mcp
- [ ] Confirm MCP client setup with user — show me how tools are currently registered
- [ ] Install repomap-mcp (pinned version)
- [ ] Register repomap as MCP server
- [ ] Identify where in orchestrator to call repo_map (before decomposition)
- [ ] Call repo_map and log raw output — understand the exact format
- [ ] Inject repo_map output into orchestrator system prompt
- [ ] Test: run a real task and verify specialists get relevant files
- [ ] Add `.repomap.tags.cache/` to `.gitignore`

### Phase 2: ChromaDB + Ollama
- [ ] Confirm Ollama is installed and running locally
- [ ] Pull nomic-embed-text (or nomic-embed-code)
- [ ] Install chromadb and chokidar npm packages
- [ ] Implement embed() and verify it returns a vector
- [ ] Implement getCollection() and indexProject()
- [ ] Wire indexProject() to run at studio startup after first repo_map call
- [ ] Implement semanticSearch()
- [ ] Implement mergeAndRank() — write parser for repomap output first
- [ ] Replace single repo_map call with Promise.all([repo_map, semanticSearch])
- [ ] Test: run real tasks, compare retrieval quality with/without vector search
- [ ] Implement chokidar watcher — wire to ChromaDB upsert/delete
- [ ] Add `./chroma/` to `.gitignore`
- [ ] Tune mergeAndRank weights after real usage data
