# MSBuild Best Practices

Step-by-step workflow for auditing MSBuild project files for anti-patterns with detection commands and fix recipes.

## When to use

- Build is slow or flaky
- Reviewing project file quality
- Migrating legacy projects to SDK-style
- Onboarding to a new .NET codebase

## When NOT to use

- Runtime performance issues (use [performance-patterns.md](performance-patterns.md))
- NuGet version management only (see CPM section in main SKILL.md)
- Code-level patterns (use main SKILL.md conventions)

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Solution or directory path | Yes | Root containing .csproj/.props/.targets files |
| Legacy migration? | No | Whether this is a legacy-to-SDK migration (triggers modernization checklist) |

## Workflow

### Step 1: Discover all project files

```bash
find . -name '*.csproj' -o -name '*.props' -o -name '*.targets' | head -50
ls Directory.Build.props Directory.Packages.props global.json 2>/dev/null
```

### Step 2: Run anti-pattern detection

For each file found, check against AP-01 through AP-15 below.

### Step 3: Classify findings by severity

| Severity | Anti-patterns | Action |
|----------|---------------|--------|
| Critical | AP-03 (hardcoded paths), AP-06 (HintPath) | Must fix — breaks on other machines |
| Moderate | AP-01, AP-02, AP-07, AP-08, AP-09, AP-11 | Should fix — build quality/correctness |
| Info | AP-04, AP-05, AP-10, AP-12, AP-13, AP-14, AP-15 | Clean up — maintainability |

### Step 4: Apply fixes per anti-pattern

### Step 5: If legacy migration flagged, run modernization checklist (see below)

## Anti-pattern catalog

### AP-01: Exec for operations that have built-in tasks

```xml
<!-- BAD -->
<Exec Command="mkdir $(OutputPath)logs" />
<Exec Command="copy config.json $(OutputPath)" />

<!-- GOOD -->
<MakeDir Directories="$(OutputPath)logs" />
<Copy SourceFiles="config.json" DestinationFolder="$(OutputPath)" />
```

Built-in tasks are cross-platform, support incremental build, and emit structured logging.

### AP-02: Unquoted condition expressions

```xml
<!-- BAD: Breaks if property is empty or has spaces -->
<PropertyGroup Condition="$(Configuration) == Release">

<!-- GOOD: Always quote both sides -->
<PropertyGroup Condition="'$(Configuration)' == 'Release'">
```

### AP-03: Hardcoded absolute paths

```xml
<!-- BAD -->
<ToolPath>C:\tools\mytool\mytool.exe</ToolPath>

<!-- GOOD -->
<ToolPath>$(MSBuildThisFileDirectory)tools/mytool/mytool.exe</ToolPath>
```

Preferred path properties:
- `$(MSBuildThisFileDirectory)` — directory of the current .props/.targets file
- `$(MSBuildProjectDirectory)` — directory of the .csproj
- `$([MSBuild]::NormalizePath(...))` — combine and normalize path segments

### AP-04: Restating SDK defaults

```xml
<!-- BAD: All defaults — adds noise -->
<OutputType>Library</OutputType>
<EnableDefaultItems>true</EnableDefaultItems>
<RootNamespace>MyLib</RootNamespace>  <!-- matches project name -->

<!-- GOOD: Only non-default values -->
<TargetFramework>net9.0</TargetFramework>
```

### AP-05: Manual file listing in SDK-style projects

SDK-style projects automatically glob `**/*.cs`. Remove explicit `<Compile Include>` entries.

### AP-06: Reference with HintPath for NuGet packages

```xml
<!-- BAD: Legacy packages.config pattern -->
<Reference Include="Newtonsoft.Json">
  <HintPath>..\packages\Newtonsoft.Json.13.0.3\lib\...</HintPath>
</Reference>

<!-- GOOD -->
<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
```

### AP-07: Missing PrivateAssets on analyzer packages

```xml
<!-- BAD: Analyzers flow as transitive dependencies -->
<PackageReference Include="StyleCop.Analyzers" Version="1.2.0" />

<!-- GOOD -->
<PackageReference Include="StyleCop.Analyzers" Version="1.2.0" PrivateAssets="all" />
```

### AP-08: Copy-pasted properties across .csproj files

Move shared properties to `Directory.Build.props`:

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

### AP-09: Scattered package versions

Use Central Package Management. See the main SKILL.md for `Directory.Packages.props` setup, or [convert-to-cpm.md](convert-to-cpm.md) for the full migration workflow.

### AP-10: Monolithic targets

Split large targets into single-responsibility targets with `Inputs`/`Outputs` for incremental build.

### AP-11: Missing Inputs and Outputs

```xml
<!-- BAD: Runs every build -->
<Target Name="GenCode" BeforeTargets="CoreCompile">
  <Exec Command="codegen.exe" />
</Target>

<!-- GOOD: Incremental -->
<Target Name="GenCode" BeforeTargets="CoreCompile"
        Inputs="schema.json" Outputs="$(IntermediateOutputPath)Generated.cs">
  <Exec Command="codegen.exe" />
</Target>
```

### AP-12: Setting defaults in .targets instead of .props

- `.props` = defaults and settings (evaluated early)
- `.targets` = build logic and targets (evaluated late)

### AP-13: Import without Exists() guard

```xml
<!-- BAD: Fails confusingly if file missing -->
<Import Project="$(RepoRoot)eng/custom.props" />

<!-- GOOD: Guard optional imports -->
<Import Project="$(RepoRoot)eng/custom.props"
        Condition="Exists('$(RepoRoot)eng/custom.props')" />
```

### AP-14: Backslashes in paths

```xml
<!-- BAD: Breaks on Linux/macOS -->
<Import Project="$(RepoRoot)\eng\common.props" />

<!-- GOOD: Forward slashes work everywhere -->
<Import Project="$(RepoRoot)/eng/common.props" />
```

### AP-15: Unconditional property override

```xml
<!-- BAD: Silent override -->
<!-- Directory.Build.props -->
<OutputPath>bin/custom/</OutputPath>
<!-- MyProject.csproj -->
<OutputPath>bin/other/</OutputPath>

<!-- GOOD: Conditional default -->
<OutputPath Condition="'$(OutputPath)' == ''">bin/custom/</OutputPath>
```

## Project modernization checklist

### SDK-style migration indicators

Legacy indicators:
- `<Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" />`
- Explicit `<Compile Include="..." />` for every .cs file
- `ToolsVersion` attribute on `<Project>`
- `packages.config` file present
- `Properties\AssemblyInfo.cs`

Quick check: if a .csproj is more than 50 lines for a simple project, it's likely legacy.

### Migration steps

1. Replace `<Project ToolsVersion="..." xmlns="...">` with `<Project Sdk="Microsoft.NET.Sdk">`
2. Replace `<TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>` with `<TargetFramework>net472</TargetFramework>`
3. Remove all explicit `<Compile Include>` entries (SDK auto-globs)
4. Delete `Properties/AssemblyInfo.cs` (SDK auto-generates attributes)
5. Migrate `packages.config` to `<PackageReference>` entries
6. Remove SDK imports, Configuration/Platform defaults, framework references
7. Enable modern features: `<Nullable>enable</Nullable>`, `<ImplicitUsings>enable</ImplicitUsings>`

### TFM mapping

| Legacy | SDK-style |
|--------|-----------|
| `v4.6.1` | `net461` |
| `v4.7.2` | `net472` |
| `v4.8` | `net48` |
| .NET 8 | `net8.0` |
| .NET 9 | `net9.0` |
| .NET 10 | `net10.0` |

## Validation checklist

- [ ] All AP detections rerun clean
- [ ] `dotnet build` succeeds
- [ ] No `ToolsVersion` attributes remain
- [ ] No `packages.config` files remain
- [ ] `Directory.Build.props` centralizes shared properties
- [ ] Forward slashes used in all paths

## Tools

| Tool | Usage |
|------|-------|
| `dotnet try-convert` | Automated legacy-to-SDK conversion |
| .NET Upgrade Assistant | Full migration including API changes |
| Visual Studio | Right-click packages.config to migrate |
