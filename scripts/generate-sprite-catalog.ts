import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type SpriteCategory = 'male' | 'female' | 'soldier' | 'enemy' | 'other' | 'xmas'

interface PixelSpriteEntry {
  id: string
  category: SpriteCategory
  label: string
  designGroup: string
  variant: number | null
  totalVariants: number
  src: string
}

interface SpriteEntrySeed extends Omit<PixelSpriteEntry, 'totalVariants'> {}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SPRITES_ROOT = path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'pixel-office', 'sprites')
const OUTPUT_PATH = path.join(SPRITES_ROOT, 'index.ts')

const CATEGORY_FROM_DIR: Record<string, SpriteCategory> = {
  Male: 'male',
  Female: 'female',
  Soldier: 'soldier',
  Enemy: 'enemy',
  Other: 'other',
  Xmas: 'xmas'
}

const CATEGORY_LABEL: Record<SpriteCategory, string> = {
  male: 'Male',
  female: 'Female',
  soldier: 'Soldier',
  enemy: 'Enemy',
  other: 'Other',
  xmas: 'Xmas'
}

const CATEGORY_ORDER: SpriteCategory[] = ['male', 'female', 'soldier', 'enemy', 'other', 'xmas']

function walkFilesRecursive(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFilesRecursive(entryPath))
      continue
    }
    if (entry.isFile()) {
      files.push(entryPath)
    }
  }

  return files
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function normalizeNumber(rawValue: string): string {
  const numeric = Number.parseInt(rawValue, 10)
  if (Number.isNaN(numeric)) {
    return rawValue
  }
  return String(numeric).padStart(2, '0')
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

function toHumanLabel(value: string): string {
  const cleaned = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.replace(/\b\w/g, (char) => char.toUpperCase())
}

function parseSprite(relativePath: string): SpriteEntrySeed | null {
  const ext = path.extname(relativePath).toLowerCase()
  if (ext !== '.png') {
    return null
  }

  const dirName = relativePath.split(path.sep)[0]
  const category = CATEGORY_FROM_DIR[dirName]
  if (!category) {
    return null
  }

  const fileName = path.basename(relativePath, ext)
  const src = `./${toPosix(relativePath)}`

  if (category === 'other') {
    const slug = slugify(fileName)
    const designGroup = `other-${slug}`
    return {
      id: designGroup,
      category,
      label: toHumanLabel(fileName),
      designGroup,
      variant: null,
      src
    }
  }

  if (category === 'xmas') {
    const xmasMatch = /^pipo-xmaschara(\d+)$/i.exec(fileName)
    if (!xmasMatch) {
      const fallback = `xmas-${slugify(fileName)}`
      return {
        id: fallback,
        category,
        label: toHumanLabel(fileName),
        designGroup: fallback,
        variant: null,
        src
      }
    }

    const designNum = normalizeNumber(xmasMatch[1])
    const designGroup = `xmas-${designNum}`
    return {
      id: designGroup,
      category,
      label: `Xmas ${designNum}`,
      designGroup,
      variant: null,
      src
    }
  }

  const withVariantMatch = /^\w+\s+(\d+)-(\d+)$/i.exec(fileName)
  if (withVariantMatch) {
    const designNum = normalizeNumber(withVariantMatch[1])
    const variant = Number.parseInt(withVariantMatch[2], 10)
    const designGroup = `${category}-${designNum}`
    return {
      id: `${designGroup}-${variant}`,
      category,
      label: `${CATEGORY_LABEL[category]} ${designNum}`,
      designGroup,
      variant,
      src
    }
  }

  if (category === 'enemy') {
    const enemyNoVariantMatch = /^Enemy\s+(\d+)$/i.exec(fileName)
    if (enemyNoVariantMatch) {
      const designNum = normalizeNumber(enemyNoVariantMatch[1])
      const designGroup = `enemy-${designNum}`
      return {
        id: designGroup,
        category,
        label: `Enemy ${designNum}`,
        designGroup,
        variant: null,
        src
      }
    }
  }

  return null
}

function compareEntries(a: PixelSpriteEntry, b: PixelSpriteEntry): number {
  const categoryDiff = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
  if (categoryDiff !== 0) {
    return categoryDiff
  }

  if (a.designGroup !== b.designGroup) {
    return a.designGroup.localeCompare(b.designGroup)
  }

  if (a.variant !== b.variant) {
    if (a.variant === null) return -1
    if (b.variant === null) return 1
    return a.variant - b.variant
  }

  return a.id.localeCompare(b.id)
}

function generateSource(entries: PixelSpriteEntry[]): string {
  const entryLines = entries.map((entry) => {
    const variant = entry.variant === null ? 'null' : String(entry.variant)
    return [
      '  {',
      `    id: '${escapeSingleQuotes(entry.id)}',`,
      `    category: '${entry.category}',`,
      `    label: '${escapeSingleQuotes(entry.label)}',`,
      `    designGroup: '${escapeSingleQuotes(entry.designGroup)}',`,
      `    variant: ${variant},`,
      `    totalVariants: ${entry.totalVariants},`,
      `    src: '${escapeSingleQuotes(entry.src)}'`,
      '  }'
    ].join('\n')
  })

  return [
    '// AUTO-GENERATED by scripts/generate-sprite-catalog.ts',
    '// Do not edit manually.',
    '',
    'export interface PixelSpriteEntry {',
    '  id: string',
    "  category: 'male' | 'female' | 'soldier' | 'enemy' | 'other' | 'xmas'",
    '  label: string',
    '  designGroup: string',
    '  variant: number | null',
    '  totalVariants: number',
    '  src: string',
    '}',
    '',
    'export const PIXEL_SPRITE_CATALOG: PixelSpriteEntry[] = [',
    entryLines.join(',\n'),
    ']',
    '',
    'export function getDesignGroups(): string[] {',
    "  return [...new Set(PIXEL_SPRITE_CATALOG.map((entry) => entry.designGroup))]",
    '}',
    '',
    'export function getVariants(designGroup: string): PixelSpriteEntry[] {',
    '  return PIXEL_SPRITE_CATALOG.filter((entry) => entry.designGroup === designGroup)',
    '}',
    '',
    'export function getSpriteById(id: string): PixelSpriteEntry | undefined {',
    '  return PIXEL_SPRITE_CATALOG.find((entry) => entry.id === id)',
    '}',
    ''
  ].join('\n')
}

function main(): void {
  if (!fs.existsSync(SPRITES_ROOT)) {
    throw new Error(`Sprites directory not found: ${SPRITES_ROOT}`)
  }

  const allFiles = walkFilesRecursive(SPRITES_ROOT)
  const relativePngFiles = allFiles
    .map((absolutePath) => path.relative(SPRITES_ROOT, absolutePath))
    .filter((relativePath) => path.extname(relativePath).toLowerCase() === '.png')

  const parsed = relativePngFiles
    .map((relativePath) => parseSprite(relativePath))
    .filter((entry): entry is SpriteEntrySeed => entry !== null)

  const groupCounts = new Map<string, number>()
  for (const entry of parsed) {
    groupCounts.set(entry.designGroup, (groupCounts.get(entry.designGroup) ?? 0) + 1)
  }

  const catalog: PixelSpriteEntry[] = parsed.map((entry) => ({
    ...entry,
    totalVariants: groupCounts.get(entry.designGroup) ?? 1
  }))

  catalog.sort(compareEntries)

  const source = generateSource(catalog)
  fs.writeFileSync(OUTPUT_PATH, source, 'utf-8')

  console.log(
    `Generated ${path.relative(ROOT, OUTPUT_PATH)} with ${catalog.length} sprite entries across ${groupCounts.size} design groups.`
  )
}

main()
