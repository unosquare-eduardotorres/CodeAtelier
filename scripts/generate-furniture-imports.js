#!/usr/bin/env node
/**
 * Generates a TypeScript file that statically imports all furniture manifests and PNGs.
 * Run: node scripts/generate-furniture-imports.js
 * Output: src/renderer/src/components/pixel-office/furnitureRegistry.ts
 */

const fs = require('fs');
const path = require('path');

const FURNITURE_DIR = path.join(__dirname, '..', 'src/renderer/src/assets/pixel-office/furniture');
const OUTPUT_FILE = path.join(__dirname, '..', 'src/renderer/src/components/pixel-office/furnitureRegistry.ts');

// Recursively collect all asset entries from a manifest
function collectAssets(node, dirName) {
  const assets = [];
  if (node.type === 'asset') {
    if (node.file) {
      assets.push({ id: node.id, file: node.file, dir: dirName });
    }
  } else if (node.members) {
    for (const member of node.members) {
      assets.push(...collectAssets(member, dirName));
    }
  }
  return assets;
}

// Recursively flatten manifest into FurnitureAsset-compatible entries
function flattenManifest(node, inherited) {
  if (node.type === 'asset') {
    const orientation = node.orientation || inherited.orientation;
    const state = node.state || inherited.state;
    return [{
      id: node.id || inherited.groupId,
      name: inherited.name,
      label: inherited.name,
      category: inherited.category,
      ...(node.file ? { file: node.file } : {}),
      width: node.width || inherited.width,
      height: node.height || inherited.height,
      footprintW: node.footprintW || inherited.footprintW,
      footprintH: node.footprintH || inherited.footprintH,
      isDesk: inherited.category === 'desks',
      canPlaceOnWalls: inherited.canPlaceOnWalls || false,
      canPlaceOnSurfaces: inherited.canPlaceOnSurfaces || false,
      backgroundTiles: inherited.backgroundTiles || 0,
      groupId: inherited.groupId,
      ...(orientation ? { orientation } : {}),
      ...(state ? { state } : {}),
      ...(node.mirrorSide ? { mirrorSide: true } : {}),
      ...(inherited.rotationScheme ? { rotationScheme: inherited.rotationScheme } : {}),
      ...(inherited.animationGroup ? { animationGroup: inherited.animationGroup } : {}),
      ...(node.frame !== undefined ? { frame: node.frame } : {}),
    }];
  }

  const results = [];
  for (const member of (node.members || [])) {
    const childProps = { ...inherited };
    if (node.groupType === 'rotation' && node.rotationScheme) {
      childProps.rotationScheme = node.rotationScheme;
    }
    if (node.groupType === 'state') {
      if (node.orientation) childProps.orientation = node.orientation;
      if (node.state) childProps.state = node.state;
    }
    if (node.groupType === 'animation') {
      const orient = node.orientation || inherited.orientation || '';
      const st = node.state || inherited.state || '';
      childProps.animationGroup = `${inherited.groupId}_${orient}_${st}`.toUpperCase();
      if (node.state) childProps.state = node.state;
    }
    if (node.orientation && !childProps.orientation) {
      childProps.orientation = node.orientation;
    }
    results.push(...flattenManifest(member, childProps));
  }
  return results;
}

// Main
const dirs = fs.readdirSync(FURNITURE_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

const allImports = [];
const allAssets = [];
const catalogEntries = [];
let importIdx = 0;

for (const dirName of dirs) {
  const manifestPath = path.join(FURNITURE_DIR, dirName, 'manifest.json');
  if (!fs.existsSync(manifestPath)) continue;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  // Collect PNG assets
  const pngAssets = collectAssets(manifest, dirName);

  // If it's a simple asset type with a single file
  if (manifest.type === 'asset') {
    const file = manifest.file || `${manifest.id}.png`;
    const filePath = path.join(FURNITURE_DIR, dirName, file);
    if (fs.existsSync(filePath)) {
      pngAssets.push({ id: manifest.id, file, dir: dirName });
    }
  }

  // Deduplicate by id
  const seen = new Set();
  const uniqueAssets = [];
  for (const a of pngAssets) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      uniqueAssets.push(a);
    }
  }

  // Generate imports for each PNG
  for (const asset of uniqueAssets) {
    const varName = `img_${importIdx++}`;
    const importPath = `@renderer/assets/pixel-office/furniture/${dirName}/${asset.file}`;
    allImports.push(`import ${varName} from '${importPath}';`);
    allAssets.push({ varName, id: asset.id });
  }

  // Flatten manifest into catalog entries
  const inherited = {
    groupId: manifest.id,
    name: manifest.name,
    category: manifest.category,
    canPlaceOnWalls: manifest.canPlaceOnWalls || false,
    canPlaceOnSurfaces: manifest.canPlaceOnSurfaces || false,
    backgroundTiles: manifest.backgroundTiles || 0,
    width: manifest.width,
    height: manifest.height,
    footprintW: manifest.footprintW,
    footprintH: manifest.footprintH,
  };

  if (manifest.type === 'asset') {
    catalogEntries.push(...flattenManifest(manifest, inherited));
  } else if (manifest.type === 'group') {
    for (const member of manifest.members) {
      catalogEntries.push(...flattenManifest(member, {
        ...inherited,
        rotationScheme: manifest.rotationScheme
      }));
    }
  }
}

// Generate TypeScript
const lines = [
  '/**',
  ' * AUTO-GENERATED by scripts/generate-furniture-imports.js',
  ' * Do not edit manually. Re-run the script after updating furniture assets.',
  ' */',
  '',
  '// ── PNG imports ──',
  ...allImports,
  '',
  '/** Map of furniture asset ID → PNG URL (for loading via Image) */',
  'export const FURNITURE_PNG_MAP: Record<string, string> = {',
  ...allAssets.map(a => `  '${a.id}': ${a.varName},`),
  '};',
  '',
  '/** Pre-flattened furniture catalog entries (from manifests) */',
  'export const FURNITURE_CATALOG = ' + JSON.stringify(catalogEntries, null, 2) + ' as const;',
  '',
];

fs.writeFileSync(OUTPUT_FILE, lines.join('\n') + '\n');
console.log(`Generated ${OUTPUT_FILE}`);
console.log(`  ${allImports.length} PNG imports`);
console.log(`  ${catalogEntries.length} catalog entries`);
