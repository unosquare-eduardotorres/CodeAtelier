/**
 * Unit tests for isExcludedPath() — Windows path separator handling and
 * directory-segment matching to prevent false positives.
 * Zero DB dependencies — pure function tests.
 */
import assert from 'node:assert/strict'
import { join, sep } from 'node:path'
import { test, describe } from './test-harness'
import {
  isExcludedPath,
  isExcludedDirName,
  isTier2CandidateDirName,
  toPosixRel,
  matchesSkipPattern
} from '../code-graph-exclusions'
import { parseIgnoreRules } from '../workspace-ignore'

describe('isExcludedPath', () => {
  // ── Forward slash paths (Unix/macOS) ──

  test('excludes path with "bin" directory segment (forward slash)', () => {
    assert.equal(isExcludedPath('src/bin/output.dll'), true)
  })

  test('excludes path with "obj" directory segment', () => {
    assert.equal(isExcludedPath('MyProject/obj/Debug/app.dll'), true)
  })

  test('excludes path with ".vs" directory segment', () => {
    assert.equal(isExcludedPath('.vs/config/applicationhost.config'), true)
  })

  test('excludes path with "Debug" directory segment', () => {
    assert.equal(isExcludedPath('build/Debug/main.o'), true)
  })

  test('excludes path with "Release" directory segment', () => {
    assert.equal(isExcludedPath('build/Release/main.o'), true)
  })

  test('excludes path with ".idea" directory segment', () => {
    assert.equal(isExcludedPath('.idea/workspace.xml'), true)
  })

  test('excludes path with "out" directory segment', () => {
    assert.equal(isExcludedPath('out/compiled.js'), true)
  })

  // ── Backslash paths (Windows) ──

  test('excludes path with backslash separators (Windows)', () => {
    assert.equal(isExcludedPath('src\\bin\\output.dll'), true)
  })

  test('excludes path with backslash "obj" directory (Windows)', () => {
    assert.equal(isExcludedPath('MyProject\\obj\\Debug\\app.dll'), true)
  })

  test('excludes path with backslash ".idea" directory (Windows)', () => {
    assert.equal(isExcludedPath('.idea\\workspace.xml'), true)
  })

  // ── Mixed separators ──

  test('handles mixed forward and backslash separators', () => {
    assert.equal(isExcludedPath('src/bin\\output.dll'), true)
  })

  // ── False-positive prevention ──

  test('does NOT exclude filename containing excluded dir name', () => {
    // "binary-utils.ts" contains "bin" but is a filename, not a directory segment
    assert.equal(isExcludedPath('src/binary-utils.ts'), false)
  })

  test('does NOT exclude file named "bin.ts" (it is the last segment = filename)', () => {
    // "bin.ts" as last segment is treated as a filename, not a directory
    assert.equal(isExcludedPath('src/bin.ts'), false)
  })

  test('does NOT exclude file named "debug-helper.ts"', () => {
    assert.equal(isExcludedPath('src/debug-helper.ts'), false)
  })

  test('does NOT exclude regular source paths', () => {
    assert.equal(isExcludedPath('src/services/my-service.ts'), false)
  })

  test('does NOT exclude file with "out" in filename', () => {
    assert.equal(isExcludedPath('src/layout.tsx'), false)
  })

  // ── Edge cases ──

  test('handles path with no directory segments (bare filename)', () => {
    assert.equal(isExcludedPath('index.ts'), false)
  })

  test('handles empty string', () => {
    assert.equal(isExcludedPath(''), false)
  })

  test('excludes when excluded dir is the first segment', () => {
    assert.equal(isExcludedPath('packages/lib/index.ts'), true)
  })

  test('excludes deeply nested excluded directory', () => {
    assert.equal(isExcludedPath('a/b/c/artifacts/d/e.ts'), true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Case-insensitive exclusion — Windows NTFS / macOS HFS+ compatibility.
// A directory named "Packages" (capital P) must match the "packages" exclusion.
// ─────────────────────────────────────────────────────────────────────────────
describe('isExcludedPath — case-insensitive matching', () => {
  test('excludes PascalCase variants (Windows/NuGet)', () => {
    assert.equal(isExcludedPath('Packages/Angularjs.1.8.2/angular.js'), true)
    assert.equal(isExcludedPath('Bin/Debug/app.exe'), true)
    assert.equal(isExcludedPath('OBJ/Release/net8.0/app.dll'), true)
  })

  test('excludes UPPER CASE directory names', () => {
    assert.equal(isExcludedPath('BIN/output.dll'), true)
    assert.equal(isExcludedPath('PACKAGES/lib/index.js'), true)
    assert.equal(isExcludedPath('ARTIFACTS/build/app.js'), true)
  })

  test('excludes mixed-case with backslash (Windows paths)', () => {
    assert.equal(isExcludedPath('MyProject\\Bin\\Debug\\app.dll'), true)
    assert.equal(isExcludedPath('src\\OBJ\\Release\\output.dll'), true)
  })
})

describe('isExcludedDirName — case-insensitive', () => {
  test('matches lowercase', () => {
    assert.equal(isExcludedDirName('packages'), true)
    assert.equal(isExcludedDirName('bin'), true)
    assert.equal(isExcludedDirName('obj'), true)
  })

  test('matches PascalCase', () => {
    assert.equal(isExcludedDirName('Packages'), true)
    assert.equal(isExcludedDirName('Bin'), true)
    assert.equal(isExcludedDirName('TestResults'), true)
    assert.equal(isExcludedDirName('BuildSystem'), true)
  })

  test('matches UPPER CASE', () => {
    assert.equal(isExcludedDirName('PACKAGES'), true)
    assert.equal(isExcludedDirName('BIN'), true)
    assert.equal(isExcludedDirName('OBJ'), true)
  })

  test('does NOT match non-excluded dirs regardless of case', () => {
    assert.equal(isExcludedDirName('src'), false)
    assert.equal(isExcludedDirName('SRC'), false)
    assert.equal(isExcludedDirName('lib'), false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Vendored dependency trees — the MULLIGAN index-bloat regression.
// A vendored NUnit copy multiplies every common symbol's edge count, which is
// how one workspace reached 279,882 tags / 5.5M edges.
// ─────────────────────────────────────────────────────────────────────────────
describe('isExcludedPath — vendored trees', () => {
  test('excludes BuildSystem/Tools/NUnit (POSIX)', () => {
    assert.equal(isExcludedPath('BuildSystem/Tools/NUnit.2.5.7/bin/nunit.core.dll'), true)
  })

  test('excludes BuildSystem\\Tools\\NUnit (Windows)', () => {
    assert.equal(isExcludedPath('BuildSystem\\Tools\\NUnit.2.5.7\\doc\\index.html'), true)
  })

  test('excludes a bare Tools/ directory', () => {
    assert.equal(isExcludedPath('Tools/nuget/NuGet.exe'), true)
  })

  test('excludes ThirdParty and NuGet caches', () => {
    assert.equal(isExcludedPath('ThirdParty/log4net/log4net.cs'), true)
    assert.equal(isExcludedPath('src/NuGet/packages.config'), true)
  })

  test('excludes ReferencedAssemblies, whatever its casing', () => {
    assert.equal(isExcludedPath('ReferencedAssemblies/Newtonsoft.Json/Linq/JObject.cs'), true)
    assert.equal(isExcludedPath('referencedassemblies/log4net/Appender.cs'), true)
    assert.equal(isExcludedPath('src\\ReferencedAssemblies\\Interop.cs'), true)
    assert.equal(isExcludedDirName('ReferencedAssemblies'), true)
  })

  test('does NOT exclude first-party names that merely contain a keyword', () => {
    assert.equal(isExcludedPath('src/Toolset/Builder.cs'), false)
    assert.equal(isExcludedPath('src/tools.ts'), false)
  })
})

// ────────────────────────────────────────────────────────────────────
// Tier 1 — tool-managed output across mobile / game / native ecosystems.
// The reported regression: the embedding indexer walked every boost header
// under apps/mobile/ios/Pods/ReactNativeDependencies.
// ────────────────────────────────────────────────────────────────────
describe('isExcludedPath — Tier 1 ecosystem additions', () => {
  test('excludes the exact reported CocoaPods path', () => {
    assert.equal(
      isExcludedPath(
        'apps/mobile/ios/Pods/ReactNativeDependencies/Headers/boost/type_traits/detail/is_mem_fun_pointer_impl.hpp'
      ),
      true
    )
  })

  test('Pods matches case-insensitively', () => {
    assert.equal(isExcludedDirName('Pods'), true)
    assert.equal(isExcludedDirName('pods'), true)
    assert.equal(isExcludedDirName('PODS'), true)
  })

  test('excludes other iOS / macOS tool output', () => {
    assert.equal(isExcludedPath('ios/Carthage/Build/iOS/Alamofire.framework/Header.h'), true)
    assert.equal(isExcludedPath('DerivedData/App-abc/Build/Products/x.swift'), true)
    assert.equal(isExcludedPath('App.xcodeproj/xcuserdata/me.xcuserdatad/x.plist'), true)
  })

  test('excludes Android / JVM generated trees', () => {
    assert.equal(isExcludedPath('app/build/gen/com/example/R.java'), true)
    assert.equal(isExcludedPath('app/captures/profile.trace'), true)
    assert.equal(isExcludedPath('Intermediates/app/classes.dex'), true)
  })

  test('excludes Unreal Engine output', () => {
    assert.equal(isExcludedPath('Binaries/Win64/Game.exe'), true)
    assert.equal(isExcludedPath('Intermediate/Build/Win64/Game.gen.cpp'), true)
    assert.equal(isExcludedPath('DerivedDataCache/0/abc.udd'), true)
    assert.equal(isExcludedPath('Saved/Logs/Game.log'), true)
  })

  test('excludes Unity caches', () => {
    assert.equal(isExcludedPath('Temp/Bin/Debug/Assembly.dll'), true)
    assert.equal(isExcludedPath('Logs/Packages-Update.log'), true)
    assert.equal(isExcludedPath('Builds/StandaloneOSX/game.app'), true)
    assert.equal(isExcludedPath('MemoryCaptures/snapshot.snap'), true)
  })

  test('excludes C/C++ vendored + CMake trees', () => {
    assert.equal(isExcludedPath('build/CMakeFiles/feature_tests.cxx'), true)
    assert.equal(isExcludedPath('cmake-build-debug/CMakeCache.txt'), true)
    assert.equal(isExcludedPath('cmake-build-release/out.o'), true)
    assert.equal(isExcludedPath('build/_deps/googletest-src/src/gtest.cc'), true)
    assert.equal(isExcludedPath('vcpkg_installed/x64-osx/include/zlib.h'), true)
    assert.equal(isExcludedPath('conan/data/boost/boost.hpp'), true)
  })

  test('excludes Python installed dependency trees', () => {
    assert.equal(isExcludedPath('env/lib/python3.11/site-packages/requests/api.py'), true)
    assert.equal(isExcludedPath('eggs/foo-1.0.egg/foo.py'), true)
    assert.equal(isExcludedPath('wheels/foo-1.0-py3.whl/foo.py'), true)
    assert.equal(isExcludedPath('.eggs/setuptools/x.py'), true)
  })

  test('excludes legacy web package roots and Go vendoring', () => {
    assert.equal(isExcludedPath('bower_components/jquery/jquery.js'), true)
    assert.equal(isExcludedPath('jspm_packages/npm/react/index.js'), true)
    assert.equal(isExcludedPath('web_modules/lodash.js'), true)
    assert.equal(isExcludedPath('Godeps/_workspace/src/foo/foo.go'), true)
  })

  test('excludes generated static-site output', () => {
    assert.equal(isExcludedPath('_site/index.html'), true)
    assert.equal(isExcludedPath('storybook-static/iframe.html'), true)
  })

  test('does NOT exclude first-party paths that merely resemble Tier 1 names', () => {
    assert.equal(isExcludedPath('src/Pods.swift'), false)
    assert.equal(isExcludedPath('src/BinariesLoader.cs'), false)
    assert.equal(isExcludedPath('src/generators/index.ts'), false)
  })
})

// ────────────────────────────────────────────────────────────────────
// Tier 2 — generic names that must NEVER be excluded without confirmation.
// Excluding `lib/` by default would silently hide first-party source.
// ────────────────────────────────────────────────────────────────────
describe('Tier 2 candidates are not excluded by default', () => {
  test('generic dependency-ish names stay indexed', () => {
    for (const name of ['lib', 'libs', 'Library', 'external', 'deps', 'plugins', 'shared']) {
      assert.equal(isExcludedDirName(name), false, `${name} must not be hardcoded-excluded`)
    }
  })

  test('paths under generic names stay indexed', () => {
    assert.equal(isExcludedPath('src/lib/format.ts'), false)
    assert.equal(isExcludedPath('Assets/Library/Player.cs'), false)
    assert.equal(isExcludedPath('packages-common/shared/util.ts'), false)
  })

  test('they ARE flagged as preflight candidates instead', () => {
    assert.equal(isTier2CandidateDirName('lib'), true)
    assert.equal(isTier2CandidateDirName('Library'), true)
    assert.equal(isTier2CandidateDirName('third-party'), true)
    assert.equal(isTier2CandidateDirName('src'), false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// toPosixRel — the Windows keying bug. The old code used
// `abs.replace(workspacePath + '/', '')`, which never matched backslash paths,
// so tags were silently keyed by ABSOLUTE paths.
// ─────────────────────────────────────────────────────────────────────────────
describe('toPosixRel', () => {
  const isWindows = sep === '\\'

  test('produces a relative POSIX path on the host platform', () => {
    const ws = join('tmp', 'MULLIGAN')
    const file = join(ws, 'src', 'Foo.cs')
    assert.equal(toPosixRel(file, ws), 'src/Foo.cs')
  })

  test('never returns an absolute path for a file inside the workspace', () => {
    const ws = join('tmp', 'MULLIGAN')
    const rel = toPosixRel(join(ws, 'a', 'b', 'c.ts'), ws)
    assert.equal(rel.startsWith('/'), false)
    assert.equal(/^[A-Za-z]:/.test(rel), false)
  })

  test('output never contains backslashes', () => {
    const ws = join('tmp', 'MULLIGAN')
    const rel = toPosixRel(join(ws, 'BuildSystem', 'Tools', 'x.dll'), ws)
    assert.equal(rel.includes('\\'), false)
    assert.equal(rel, 'BuildSystem/Tools/x.dll')
  })

  test('result feeds isExcludedPath correctly', () => {
    const ws = join('tmp', 'MULLIGAN')
    const rel = toPosixRel(join(ws, 'BuildSystem', 'Tools', 'NUnit.2.5.7', 'a.html'), ws)
    assert.equal(isExcludedPath(rel), true)
  })

  test('Windows drive-letter paths normalize (Windows only)', () => {
    if (!isWindows) return
    assert.equal(
      toPosixRel('C:\\repos\\MULLIGAN\\src\\Foo.cs', 'C:\\repos\\MULLIGAN'),
      'src/Foo.cs'
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// .atelierignore rule parsing
// ─────────────────────────────────────────────────────────────────────────────
describe('parseIgnoreRules + matchesSkipPattern', () => {
  const match = (rules: string, p: string): boolean =>
    matchesSkipPattern(p, parseIgnoreRules(rules))

  test('directory rule prunes the whole subtree', () => {
    assert.equal(match('BuildSystem/Tools/\n', 'BuildSystem/Tools/NUnit.2.5.7/a.dll'), true)
  })

  test('bare glob matches at any depth', () => {
    assert.equal(match('*.generated.html\n', 'docs/api/report.generated.html'), true)
  })

  test('comments and blank lines are ignored', () => {
    assert.deepEqual(parseIgnoreRules('# comment\n\n   \n'), [])
  })

  test('negation rules are rejected, not silently honored', () => {
    assert.deepEqual(parseIgnoreRules('!keep.ts\n'), [])
  })

  test('unrelated paths are not matched', () => {
    assert.equal(match('packages/\n', 'src/services/packager.ts'), false)
  })
})
