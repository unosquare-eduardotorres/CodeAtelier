# Convert to Central Package Management (CPM)

9-step workflow for migrating .NET solutions to Central Package Management, consolidating scattered PackageReference versions into a single Directory.Packages.props file.

## When to use

- Multi-project solution with inconsistent or duplicated package versions
- `Directory.Packages.props` does not exist
- Package version drift across projects causing diamond dependency conflicts
- Onboarding a new solution that needs version consolidation

## When NOT to use

- Single-project solution (CPM adds overhead with no benefit)
- CPM already enabled (`ManagePackageVersionsCentrally` is `true`)
- Project uses `packages.config` (must migrate to PackageReference first — see [msbuild-best-practices.md](msbuild-best-practices.md))

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Solution path | Yes | Path to .sln or .slnx file |

## Workflow

### Step 1: Verify prerequisites

```bash
# Check for solution file
ls *.sln *.slnx 2>/dev/null

# Check no packages.config exists (must migrate first)
find . -name 'packages.config' -type f

# Check CPM not already enabled
grep -r 'ManagePackageVersionsCentrally' Directory.Packages.props 2>/dev/null
grep -r 'ManagePackageVersionsCentrally' Directory.Build.props 2>/dev/null
```

If `packages.config` found → migrate to PackageReference first (see MSBuild modernization).
If `ManagePackageVersionsCentrally` already set → CPM is already enabled, stop.

### Step 2: Capture baseline build

```bash
# Record current build state for comparison
dotnet build --verbosity minimal > build-baseline.log 2>&1
echo "Baseline exit code: $?"
```

### Step 3: Inventory all PackageReference entries

```bash
# List all packages and versions across all projects
grep -rn 'PackageReference Include' --include='*.csproj' . | sort
```

Build a deduplicated list of all packages with their versions. Note any version conflicts.

### Step 4: Resolve version conflicts

When multiple versions of the same package exist across projects:

| Strategy | When to use |
|----------|-------------|
| Align to highest version | Default — safest for most packages |
| `VersionOverride` in specific .csproj | Project has a tested dependency on a specific version |
| Separate ItemGroup with condition | Different versions needed per TFM |

Document all conflict resolutions for the post-conversion report.

### Step 5: Create Directory.Packages.props

Create at the repository root:

```xml
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <!-- Production packages -->
    <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="9.0.0" />
    <PackageVersion Include="MediatR" Version="12.4.0" />
    <PackageVersion Include="FluentValidation" Version="11.9.0" />

    <!-- Test packages -->
    <PackageVersion Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <PackageVersion Include="xunit" Version="2.9.0" />
    <PackageVersion Include="Moq" Version="4.20.72" />
  </ItemGroup>
</Project>
```

### Step 6: Strip Version attributes from all .csproj files

For every `.csproj`, change:

```xml
<!-- BEFORE -->
<PackageReference Include="MediatR" Version="12.4.0" />

<!-- AFTER -->
<PackageReference Include="MediatR" />
```

```bash
# Verify no Version= attributes remain (except VersionOverride)
grep -rn 'PackageReference.*Version=' --include='*.csproj' . | grep -v 'VersionOverride'
```

### Step 7: Handle overrides (if needed)

For projects that need a specific version different from the central one:

```xml
<!-- In the specific .csproj -->
<PackageReference Include="Newtonsoft.Json" VersionOverride="12.0.3" />
```

### Step 8: Enable transitive pinning (recommended)

Add to `Directory.Packages.props` to pin transitive dependency versions:

```xml
<PropertyGroup>
  <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  <CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>
</PropertyGroup>
```

This ensures transitive dependencies also use the centrally defined versions.

### Step 9: Restore, build, and test

```bash
# Clean restore
dotnet restore

# Build and compare with baseline
dotnet build --verbosity minimal > build-after-cpm.log 2>&1
echo "Post-CPM exit code: $?"

# Run tests to verify nothing broke
dotnet test
```

Compare `build-baseline.log` with `build-after-cpm.log` for any new warnings or errors.

## Post-conversion report

Generate a summary:

1. **Packages consolidated**: total count of unique packages
2. **Version conflicts resolved**: list of packages with conflicting versions and chosen resolution
3. **VersionOverride used**: list of projects with overrides and justification
4. **Build comparison**: baseline vs. post-CPM (warnings, errors)
5. **Test results**: pass/fail count

## Validation checklist

- [ ] `Directory.Packages.props` exists at repo root
- [ ] `ManagePackageVersionsCentrally` is `true`
- [ ] No `Version=` attributes remain in `.csproj` files (except `VersionOverride`)
- [ ] `dotnet restore` succeeds without errors
- [ ] `dotnet build` succeeds — no new warnings vs. baseline
- [ ] `dotnet test` passes — no regressions
- [ ] No `packages.config` files remain anywhere

## Common pitfalls

| Pitfall | Solution |
|---------|----------|
| Forgetting to strip `Version=` from .csproj | Run grep verification in Step 6 |
| `packages.config` still present | Must migrate to PackageReference before CPM |
| Conditional PackageReference losing versions | Move conditions to `Directory.Packages.props` ItemGroup |
| NU1510 warning (version defined but not used) | Remove unused `PackageVersion` entries from props |
| Transitive dependency version conflicts | Enable `CentralPackageTransitivePinningEnabled` |
| Version attributes in `Directory.Build.props` | CPM versions go in `Directory.Packages.props`, not Build.props |

## Error codes reference

| Error | Meaning | Fix |
|-------|---------|-----|
| NU1008 | Projects with and without CPM in same restore graph | Enable CPM in all projects or none |
| NU1510 | PackageVersion defined but not referenced | Remove the unused entry |
| NU1507 | Package version specified in both CPM and .csproj | Remove Version from .csproj or use VersionOverride |
