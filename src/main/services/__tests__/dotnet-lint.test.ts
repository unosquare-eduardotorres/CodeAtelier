/**
 * `dotnet format` lint baseline for C# repositories.
 *
 * Pure tests only — no SDK invocation. The report fixture is a REAL
 * `dotnet format style --report` output (dotnet 10.0.102), not a guess at the
 * schema, so the parser is pinned to the shape the SDK actually emits.
 *
 * The `--verify-no-changes` assertion is the important one: `dotnet format`
 * REWRITES SOURCE by default, so losing that flag would make an audit silently
 * reformat the user's repository.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  realpathSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { test, describe, summary } from './test-harness'
import {
  parseFormatReport,
  buildFormatArgs,
  toProjectRelativeIncludes,
  findDotnetProject,
  isSdkStyleProject,
  classifyDotnetError,
  describeFailure,
  planDotnetRun,
  DOTNET_FORMAT_TIMEOUT_MS
} from '../dotnet-lint'

const REPORT_FIXTURE = readFileSync(
  path.resolve(process.cwd(), 'src/main/services/__tests__/fixtures/dotnet-format-report.json'),
  'utf-8'
)

/** Scratch tree, removed by the caller. */
function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'dotnet-lint-test-'))
}

// ── The flag that protects the user's source ────────────────────────────────

describe('buildFormatArgs', () => {
  test('ALWAYS passes --verify-no-changes', () => {
    const args = buildFormatArgs('/repo/App.csproj', '/tmp/report', [])
    assert.ok(
      args.includes('--verify-no-changes'),
      'without this flag `dotnet format` rewrites the repository being audited'
    )
  })

  test('stays offline-viable and writes a machine-readable report', () => {
    const args = buildFormatArgs('/repo/App.csproj', '/tmp/report', [])
    assert.ok(args.includes('--no-restore'), 'must not hit the network mid-audit')
    assert.equal(args[args.indexOf('--report') + 1], '/tmp/report')
    assert.equal(args[0], 'format')
    assert.equal(args[1], 'style')
    assert.equal(args[2], '/repo/App.csproj')
  })

  test('includes are appended only when present', () => {
    assert.ok(!buildFormatArgs('/repo/App.csproj', '/tmp/r', []).includes('--include'))
    const args = buildFormatArgs('/repo/App.csproj', '/tmp/r', ['Services/A.cs', 'B.cs'])
    assert.deepEqual(args.slice(args.indexOf('--include')), ['--include', 'Services/A.cs', 'B.cs'])
  })
})

// ── Include paths — absolute silently matches NOTHING ───────────────────────

describe('toProjectRelativeIncludes', () => {
  test('rewrites absolute paths to project-relative', () => {
    // Measured against the SDK: an absolute --include matches zero files and
    // the run exits 0 with an empty report — a FALSE clean, worse than an error.
    const rels = toProjectRelativeIncludes(
      ['/repo/src/App/Services/Order.cs', '/repo/src/App/Program.cs'],
      '/repo/src/App'
    )
    assert.deepEqual(rels, ['Services/Order.cs', 'Program.cs'])
  })

  test('drops paths outside the project rather than emitting `..`', () => {
    const rels = toProjectRelativeIncludes(['/repo/other/Thing.cs'], '/repo/src/App')
    assert.deepEqual(rels, [], 'an escaping include would scope the run to nothing')
  })

  test('drops the project directory itself', () => {
    assert.deepEqual(toProjectRelativeIncludes(['/repo/src/App'], '/repo/src/App'), [])
  })
})

// ── Report parsing (pinned to a real SDK report) ────────────────────────────

describe('parseFormatReport', () => {
  test('reads every diagnostic, including repeats of the same file', () => {
    const diags = parseFormatReport(REPORT_FIXTURE)
    // The SDK emits ONE ENTRY PER DIAGNOSTIC — Program.cs appears twice.
    assert.equal(diags.length, 3)
    assert.equal(diags.filter((d) => d.file.endsWith('Program.cs')).length, 2)
  })

  test('carries id, line, column and description', () => {
    const first = parseFormatReport(REPORT_FIXTURE)[0]
    assert.equal(first.id, 'IDE0059')
    assert.equal(first.line, 7)
    assert.equal(first.column, 18)
    assert.ok(first.description.includes('Unnecessary assignment'))
  })

  test('relativises paths against the workspace', () => {
    const diags = parseFormatReport(REPORT_FIXTURE, '/tmp/fixture-app')
    assert.equal(diags[0].file, 'Program.cs')
    assert.equal(diags[2].file, 'Models/Widget.cs')
  })

  test('a clean run parses to no diagnostics', () => {
    assert.deepEqual(parseFormatReport('[]'), [])
  })

  test('malformed output is empty, never a throw', () => {
    assert.deepEqual(parseFormatReport('not json'), [])
    assert.deepEqual(parseFormatReport('{"unexpected":"object"}'), [])
    assert.deepEqual(parseFormatReport('[{"FileName":"A.cs"}]'), [])
  })
})

// ── Project discovery ───────────────────────────────────────────────────────

describe('findDotnetProject', () => {
  test('prefers a solution over a project in the same directory', () => {
    const root = scratch()
    try {
      writeFileSync(path.join(root, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />')
      writeFileSync(path.join(root, 'App.sln'), '')
      assert.equal(findDotnetProject(root), path.join(root, 'App.sln'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('walks up from a nested source directory', () => {
    const root = scratch()
    try {
      const nested = path.join(root, 'src', 'App', 'Services')
      mkdirSync(nested, { recursive: true })
      writeFileSync(
        path.join(root, 'src', 'App', 'App.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk" />'
      )
      assert.equal(findDotnetProject(nested), path.join(root, 'src', 'App', 'App.csproj'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('stops at the workspace root instead of escaping it', () => {
    const root = scratch()
    try {
      const nested = path.join(root, 'src')
      mkdirSync(nested, { recursive: true })
      assert.equal(
        findDotnetProject(nested, root),
        null,
        'must not adopt a project outside the repo'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('isSdkStyleProject', () => {
  test('accepts an SDK-style project', () => {
    const root = scratch()
    try {
      const p = path.join(root, 'App.csproj')
      writeFileSync(p, '<Project Sdk="Microsoft.NET.Sdk">\n</Project>')
      assert.equal(isSdkStyleProject(p), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a legacy .NET Framework project', () => {
    const root = scratch()
    try {
      const p = path.join(root, 'Legacy.csproj')
      writeFileSync(
        p,
        '<?xml version="1.0"?>\n<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n</Project>'
      )
      assert.equal(isSdkStyleProject(p), false, '`dotnet format` cannot load these')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('solutions are allowed through — their projects are mixed', () => {
    assert.equal(isSdkStyleProject('/repo/App.sln'), true)
  })
})

// ── Run planning — a wrong plan reports a FALSE clean, not an error ──

describe('planDotnetRun', () => {
  test('resolves the project through symlinks', () => {
    // Measured against the SDK: reaching a project through a symlinked path
    // (macOS /var → /private/var) makes `--include` match ZERO files, and the
    // run exits 0 with an empty report — a lint baseline that looks clean and
    // is actually empty.
    const root = scratch()
    try {
      const real = path.join(root, 'real')
      mkdirSync(real)
      writeFileSync(path.join(real, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />')
      writeFileSync(path.join(real, 'Program.cs'), 'class P { }')
      const link = path.join(root, 'link')
      symlinkSync(real, link)

      const plan = planDotnetRun([path.join(link, 'Program.cs')], link)
      assert.ok(!('failure' in plan), 'a valid project must produce a plan')
      assert.deepEqual(plan.includes, ['Program.cs'], 'includes must stay project-relative')
      assert.equal(
        plan.projectDir,
        path.dirname(plan.project),
        'the working directory must match the project it runs'
      )
      assert.equal(
        plan.projectDir,
        realpathSync(real),
        'the symlinked path must be resolved, or --include silently matches nothing'
      )
      assert.ok(!plan.includes.some((i) => i.startsWith('..') || path.isAbsolute(i)))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('reports the cause instead of planning when there is no project', () => {
    const root = scratch()
    try {
      writeFileSync(path.join(root, 'Program.cs'), 'class P { }')
      const plan = planDotnetRun([path.join(root, 'Program.cs')], root)
      assert.deepEqual(plan, { failure: 'no-project' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('reports non-SDK-style projects before invoking the SDK', () => {
    const root = scratch()
    try {
      writeFileSync(
        path.join(root, 'Legacy.csproj'),
        '<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003"></Project>'
      )
      writeFileSync(path.join(root, 'Program.cs'), 'class P { }')
      const plan = planDotnetRun([path.join(root, 'Program.cs')], root)
      assert.ok('failure' in plan && plan.failure === 'non-sdk-project')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an empty path list is not a crash', () => {
    assert.deepEqual(planDotnetRun([], '/repo'), { failure: 'no-project' })
  })
})

// ── Failure reporting — §7 wants WHICH baseline is missing ──────────────────

describe('failure classification', () => {
  test('missing project', () => {
    assert.equal(
      classifyDotnetError(
        "Unhandled exception: System.IO.FileNotFoundException: Could not find a MSBuild project file or solution file in '/repo'."
      ),
      'no-project'
    )
  })

  test('restore required', () => {
    assert.equal(
      classifyDotnetError('error NETSDK1004: Assets file project.assets.json not found.'),
      'restore-required'
    )
  })

  test('non-SDK-style project', () => {
    assert.equal(
      classifyDotnetError('MSB4025: The project file could not be loaded'),
      'non-sdk-project'
    )
  })

  test('anything else stays generic rather than guessing', () => {
    assert.equal(classifyDotnetError('some unexpected failure'), 'error')
  })

  test('every cause has a distinct human-readable explanation', () => {
    const causes = [
      'no-sdk',
      'no-project',
      'non-sdk-project',
      'restore-required',
      'timeout',
      'error'
    ] as const
    const messages = causes.map((c) => describeFailure(c, 'App.csproj'))
    assert.equal(new Set(messages).size, causes.length, 'causes must not collapse into one message')
    assert.ok(describeFailure('timeout').includes(String(DOTNET_FORMAT_TIMEOUT_MS / 1000)))
    assert.ok(describeFailure('non-sdk-project', 'App.csproj').includes('App.csproj'))
  })
})

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('dotnet-lint.test.ts')
) {
  summary()
}
