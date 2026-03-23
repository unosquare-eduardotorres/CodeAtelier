---
name: design-docs
description: >
  Design documentation and code-to-diagram specialist skill. Provides templates for
  architecture, API, feature, database, and system design documents. Includes workflows
  for analyzing source code and generating diagrams from it. Use when creating design
  documents, technical documentation, code-to-diagram conversion, or documentation
  that includes Mermaid diagrams.
user-invocable: false
---

# Design Documentation Skill

> **Version**: 1.0
> **Last updated**: 2026-03-22
> **Pairs with**: `mermaid-diagrams` skill for diagram generation

## Decision Tree

**How this skill works:**

1. **User makes a request** — analyze intent
2. **Determine document/diagram type** — load appropriate template or guide
3. **Generate content** — using templates and code analysis
4. **Integrate diagrams** — validate before adding to markdown
5. **Output result** — with consistent file organization

```
User Request
  |
  |--> "design document", "architecture doc"  --> Load template from references/templates/
  |--> "code to diagram", "analyze code"      --> Load references/guides/code-to-diagram.md
  |--> "document this codebase"               --> Code-to-diagram + Architecture template
  |--> "diagram for this feature"             --> Analyze code + appropriate diagram type
  |--> "deployment docs"                      --> references/guides/deployment-diagrams.md
  |--> "activity/workflow docs"               --> references/guides/activity-diagrams.md
  |--> "sequence/API flow docs"               --> references/guides/sequence-diagrams.md
  |--> "architecture overview"                --> references/guides/architecture-diagrams.md
```

## Design Document Templates

Load the appropriate template based on user intent:

| Template | Reference | Use When |
|----------|-----------|----------|
| Architecture Design | [architecture-design-template.md](references/templates/architecture-design-template.md) | System-wide architecture documentation, major design decisions |
| API Design | [api-design-template.md](references/templates/api-design-template.md) | REST/GraphQL API specifications, endpoint documentation |
| Feature Design | [feature-design-template.md](references/templates/feature-design-template.md) | Feature planning, user stories, implementation approach |
| Database Design | [database-design-template.md](references/templates/database-design-template.md) | Schema design, ER diagrams, data model documentation |
| System Design | [system-design-template.md](references/templates/system-design-template.md) | Complete system documentation, scalability, infrastructure |

## Diagram Guides

Specialized guides for diagram types commonly used in documentation:

| Guide | Reference | Use When |
|-------|-----------|----------|
| Architecture Diagrams | [architecture-diagrams.md](references/guides/architecture-diagrams.md) | C4 model, component, layered, microservices, event-driven |
| Deployment Diagrams | [deployment-diagrams.md](references/guides/deployment-diagrams.md) | Infrastructure, cloud architecture, K8s, serverless |
| Sequence Diagrams | [sequence-diagrams.md](references/guides/sequence-diagrams.md) | API interactions, service communication, request/response |
| Activity Diagrams | [activity-diagrams.md](references/guides/activity-diagrams.md) | Workflows, processes, business logic, decision trees |

## Code-to-Diagram Workflow

**Full guide:** [code-to-diagram.md](references/guides/code-to-diagram.md)

### Step 1: Identify framework and patterns

Scan the codebase for telltale markers:

| Framework | File Markers | Code Markers |
|-----------|-------------|--------------|
| Spring Boot | `pom.xml`, `build.gradle` | `@SpringBootApplication`, `@RestController`, `@Service` |
| FastAPI | `requirements.txt`, `pyproject.toml` | `from fastapi import`, `@app.get`, `async def` |
| React | `package.json`, `.tsx` files | `import React`, `useState`, `useEffect` |
| Express | `package.json`, `app.js` | `express()`, `app.use`, `app.get` |
| Electron | `package.json`, `electron-builder.yml` | `BrowserWindow`, `ipcMain`, `ipcRenderer` |
| .NET | `*.csproj`, `*.sln` | `[ApiController]`, `DbContext`, `IServiceCollection` |
| Django | `manage.py`, `settings.py` | `models.Model`, `views.py`, `urls.py` |

### Step 2: Map code to diagram types

| Code Artifact | Diagram Type | What to Extract |
|---------------|-------------|-----------------|
| Directory structure | Architecture diagram | Package/module hierarchy |
| Class hierarchy | Class diagram | Inheritance, composition, interfaces |
| API endpoints | Sequence diagram | Request/response flows |
| Business logic | Activity/Flowchart | Decision points, process steps |
| Database models | ER diagram | Tables, relationships, cardinality |
| Config files (Docker, K8s) | Deployment diagram | Infrastructure, services, networking |
| State management | State diagram | State transitions, events |
| Message queues/events | Sequence or Flowchart | Async communication patterns |

### Step 3: Generate diagrams

For each identified artifact, generate the corresponding diagram using the `mermaid-diagrams` skill syntax. Always:
- Use semantic node IDs derived from actual code names
- Include Unicode symbols for clarity
- Apply high-contrast styling
- Add explanatory comments in the diagram

## Resilient Diagram Workflow

**Key principle: NEVER add a diagram to markdown until it is validated.**

### Workflow

1. **Identify diagram type** from first line (flowchart, sequence, etc.)
2. **Generate Mermaid code** using syntax references
3. **Save as `.mmd` file** in `./diagrams/` directory
4. **Validate** with `mmdc -i file.mmd -o file.png -b transparent` (if mmdc available)
5. **On error** — check common pitfalls:
   - Reserved words as identifiers? Wrap in quotes
   - Missing `end` for subgraph? Add it
   - Wrong arrow syntax? Fix to `-->`, `-.->`, `==>`
   - Special chars in labels? Wrap in double quotes
6. **On success** — add image reference to markdown: `![Description](./diagrams/filename.png)`

### File Naming Convention

```
./diagrams/<document_name>_<num>_<type>_<title>.mmd
./diagrams/<document_name>_<num>_<type>_<title>.png
```

**Example:** `./diagrams/api_design_01_sequence_auth_flow.mmd`

## Documentation Structure Conventions

### Output organization

```
docs/
├── design/
│   ├── architecture-design.md      # Architecture document
│   ├── api-design.md               # API design document
│   ├── feature-<name>.md           # Feature design documents
│   ├── database-design.md          # Database design document
│   └── system-design.md            # System design document
└── diagrams/
    ├── architecture_01_c4_context.mmd
    ├── architecture_01_c4_context.png
    ├── api_design_01_sequence_auth.mmd
    └── ...
```

### Document metadata header

Every design document should start with:

```markdown
# [Name] - [Document Type]

**Author:** [Name]
**Date:** [YYYY-MM-DD]
**Status:** Draft | In Review | Approved
**Version:** 1.0
```

## When to Use What

| User Request | Action |
|-------------|--------|
| "Create architecture doc" | Load `architecture-design-template.md` + `architecture-diagrams.md` |
| "API design document" | Load `api-design-template.md` + `sequence-diagrams.md` |
| "Feature design for X" | Load `feature-design-template.md` + relevant diagram guides |
| "Database design" | Load `database-design-template.md` + ER diagram reference |
| "System design doc" | Load `system-design-template.md` + all diagram guides |
| "Analyze this code" | Follow code-to-diagram workflow |
| "Document the architecture" | Code-to-diagram + architecture template |
| "Show the deployment" | Code-to-diagram + `deployment-diagrams.md` |
| "Workflow diagram for X" | `activity-diagrams.md` + analyze code if provided |

## Best Practices

1. **Template first** — always start from a template, then customize
2. **Diagrams earn their place** — every diagram should communicate something text cannot
3. **One diagram = one concept** — don't overload diagrams with too much information
4. **Validate before embedding** — broken diagrams in docs are worse than no diagrams
5. **Semantic naming** — use real class/service/component names from the codebase
6. **Keep diagrams current** — regenerate from code when the code changes
7. **Layer detail progressively** — start with C4 Context, zoom in to Container, then Component
