# Skills

**Skills** are knowledge packages that give your AI specialists deeper expertise in specific technologies or patterns. Think of skills as "cheat sheets" that agents can reference to produce better, more accurate code.

---

## What is a Skill?

A skill is a structured document (called a `SKILL.md` file) that contains expert-level knowledge about a specific technology, framework, or pattern. When a specialist has access to a skill, it can produce code that follows best practices, avoids common pitfalls, and matches your project's conventions.

For example:

- The **Electron Pro** skill teaches agents about secure IPC patterns, window management, and Electron-specific gotchas
- The **SQLite Patterns** skill provides database query patterns, migration strategies, and performance tips
- The **Design System** skill contains your application's design tokens, component library patterns, and styling conventions

---

## How Skills Work

1. **Skills are stored** as markdown files in your workspace's `.claude/skills/` directory
2. **Specialists are assigned** specific skills based on their area of expertise
3. **When a specialist starts**, it reads its assigned skills before beginning work
4. **Skills guide behavior** — the specialist follows the patterns and rules defined in the skill

> **Think of it like this:** If a specialist is the employee, a skill is the training manual they read before starting work. A database specialist with the "SQLite Patterns" skill knows exactly how your project handles migrations, queries, and error handling.

---

## Available Skills

Agent Studio comes with a comprehensive set of built-in skills:

| Skill | What it covers | Used by |
|-------|---------------|---------|
| **Electron Pro** | Electron security, IPC, window management | React Architect, Electron Architect |
| **.NET Architect** | C# patterns, API design, .NET conventions | .NET Architect |
| **Claude CLI** | Claude command-line tool usage | Electron Architect, Agentic Architect |
| **Claude Architect** | Agent configuration and orchestration | Agentic Architect |
| **SQLite Patterns** | Database queries, migrations, performance | Database Architect |
| **UI/UX Pro Max** | User experience best practices | UX/UI Specialist |
| **Design** | Visual design principles | UX/UI Specialist |
| **Design System** | Component library, tokens, styling | UX/UI Specialist |
| **Brand** | Brand guidelines and consistency | UX/UI Specialist |
| **Git Workflow** | Branching, merging, PR conventions | Git/GitHub Specialist |
| **IPC Patterns** | Inter-process communication patterns | Multiple architects |
| **Mermaid Diagrams** | Diagram syntax and best practices | Docs/Diagrams Specialist |
| **Design Docs** | Technical documentation standards | Docs/Diagrams Specialist |
| **General Dev** | General development best practices | Generalist Developer |

---

## Viewing Skill Details

1. Open **Workspace Settings** (gear icon)
2. Navigate to the skills section
3. Click on any skill to see:
   - **Name** — The skill's identifier
   - **Description** — What the skill covers
   - **Content preview** — The actual SKILL.md file contents
   - **Assigned agents** — Which specialists use this skill

---

## Skill Files in Your Workspace

Skills are stored as files in your project's `.claude/skills/` directory:

```
.claude/skills/
├── electron-pro/
│   └── SKILL.md
├── sqlite-patterns/
│   └── SKILL.md
├── design-system/
│   ├── SKILL.md
│   └── references/
│       └── tokens.json
└── git-workflow/
    └── SKILL.md
```

Each skill directory contains:
- **SKILL.md** — The main skill document (required)
- **references/** — Optional supporting files (code examples, configurations, etc.)

---

## Deploying Skills to Your Workspace

When you set up a workspace, skills are deployed (copied) to your project's `.claude/skills/` directory. This happens:

- **Automatically** during workspace activation
- **On demand** when you click "Deploy" in the settings
- **During sync** when you update agent configurations

After deployment, skills become part of your project directory and can be customized to match your specific needs.

---

## Customizing Skills

You can customize skills to match your project's specific patterns:

1. Navigate to the skill file in your workspace (`.claude/skills/[skill-name]/SKILL.md`)
2. Edit the markdown content to include your project-specific conventions
3. Save the file — the next time a specialist uses this skill, it will follow your customizations

> **Tip:** Customized skills are powerful. For example, if your project uses a specific coding style or architecture pattern, adding those details to the relevant skill ensures all agents follow the same conventions.

---

## Frequently Asked Questions

**Q: Can I create my own skills?**
Yes. Create a new directory under `.claude/skills/` with a `SKILL.md` file, then assign it to the appropriate specialist in the agent YAML configuration.

**Q: Do skills update automatically?**
Built-in skills may be updated when Agent Studio releases new versions. Your customizations are preserved during updates.

**Q: How do skills differ from Memory?**
**Skills** are static knowledge — pre-written guides that don't change during conversations. **Memory** is dynamic — it evolves as agents learn about your project. Skills tell agents *how* to do things; Memory tells agents *what* your project is.

**Q: Can one specialist use multiple skills?**
Yes. Most specialists have access to multiple skills. For example, the UX/UI Specialist uses Design, Design System, Brand, and UI/UX Pro Max skills together.
