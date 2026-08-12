# Code Atelier — Brand & Design System Specification

## For UX Specialist Agent / Claude Instance

> **Purpose**: This document is the single source of truth for replicating the Code Atelier visual identity across any system, interface, or deliverable. It is designed to be consumed by an AI agent (Claude) acting as a UX Specialist. Attached brand assets should be provided alongside this document as context.

---

## 1. Brand Identity

### 1.1 Name

- **Full name**: Code Atelier™
- **Abbreviation**: CA
- **Pronunciation**: "kohd ah-teh-LYAY"
- **Meaning**: "Atelier" is French for an artist's or craftsman's workshop. The brand positions software development as a form of fine craftsmanship — each line of code shaped with the precision of a Renaissance artisan.

### 1.2 Brand Essence

- **Tagline**: "Where Craft Meets Code"
- **Tone**: Mysterious, refined, authoritative. Renaissance meets technology. Not playful, not corporate — artisanal and elevated.
- **Personality**: A master craftsman's workshop where code is shaped like art. Think Leonardo da Vinci's bottega, but for software architecture.

### 1.3 Visual Metaphors

The brand uses two primary symbols:

**Cathedral Arched Window** — the heritage mark. Used in marketing, the landing page hero, and brand storytelling. It represents:

- A window into code (panes containing code symbols: `<`, `>`, `→`, `−`, `×`, `#A`)
- Craftsmanship and permanence (the arch, the ornamental details)
- Structure and order (the grid of panes, the symmetry)
- The intersection of art and engineering (decorative elements alongside functional symbols)

**Ornate Diamond Sigil** — the application mark. Used as the app icon, tray icon, favicon, and compact branding. It contains:

- A rotated square (diamond) with triple concentric frames: outer bold, middle medium, inner subtle
- `</>` code brackets centered inside in monospace (JetBrains Mono / Menlo)
- Copper jewel dots (#C4714A) at all four cardinal vertices (top, bottom, left, right) with the top jewel being the largest and having a triple-glow effect
- Smaller gold dots (#B8976A) at the four diagonal positions
- Tick marks extending outward from each cardinal vertex
- "ATELIER" text below the diamond in Georgia serif, wide letter-spacing (7-8px), flanked by thin decorative lines with copper dot endpoints

---

## 2. Color System

### 2.1 Primary Palette

| Token               | Name          | Hex       | RGB           | Usage                                                       |
| ------------------- | ------------- | --------- | ------------- | ----------------------------------------------------------- |
| `--ca-bg-primary`   | Deep Obsidian | `#0F1517` | 15, 21, 23    | Primary background, app canvas                              |
| `--ca-bg-secondary` | Dark Teal     | `#1C272D` | 28, 39, 45    | Secondary surfaces, cards                                   |
| `--ca-bg-elevated`  | Muted Teal    | `#1E2E33` | 30, 46, 51    | Elevated panels, modals, hero backgrounds                   |
| `--ca-gold-primary` | Atelier Gold  | `#B8976A` | 184, 151, 106 | Primary accent: borders, lines, icons, interactive elements |
| `--ca-gold-bright`  | Bright Gold   | `#C8B89A` | 200, 184, 154 | Headings, primary text on dark backgrounds                  |
| `--ca-gold-muted`   | Muted Gold    | `#8B6F4A` | 139, 111, 74  | Gradient endpoints, subtle accents, pressed states          |

### 2.2 Panel / Pillar Colors

These four colors represent the "Four Pillars of Craftsmanship" and are used for categorical coloring:

| Token                   | Name           | Hex       | RGB         | Pillar       | Usage                                   |
| ----------------------- | -------------- | --------- | ----------- | ------------ | --------------------------------------- |
| `--ca-panel-olive`      | Olive Charcoal | `#3A3531` | 58, 53, 49  | Architecture | Structural/foundational elements        |
| `--ca-panel-terracotta` | Terracotta     | `#6A4638` | 106, 70, 56 | Artistry     | Creative/design-related elements        |
| `--ca-panel-teal`       | Forest Teal    | `#3C4B46` | 60, 75, 70  | Precision    | Data/precision-related elements         |
| `--ca-panel-navy`       | Deep Navy      | `#283337` | 40, 51, 55  | Vision       | Infrastructure/future-oriented elements |

### 2.3 Semantic / Accent Colors

| Token                    | Name         | Hex                      | Usage                                                                 |
| ------------------------ | ------------ | ------------------------ | --------------------------------------------------------------------- |
| `--ca-jewel`             | Jewel Copper | `#C4714A`                | Ornamental dots, important callouts, jewel accents on the window icon |
| `--ca-text-secondary`    | Mist         | `#8A9A9E`                | Secondary text, labels, timestamps                                    |
| `--ca-text-tertiary`     | Fog          | `#6A7A7E`                | Tertiary text, descriptions, placeholders                             |
| `--ca-text-dim`          | Dim          | `#4A5A5E`                | Disabled text, subtle metadata                                        |
| `--ca-border-subtle`     | Border       | `rgba(184,151,106,0.08)` | Subtle card borders                                                   |
| `--ca-border-medium`     | Border Hover | `rgba(184,151,106,0.18)` | Hover state borders                                                   |
| `--ca-surface-highlight` | Highlight    | `rgba(184,151,106,0.06)` | Hover card backgrounds                                                |

### 2.4 Agent-Specific Colors

Each specialist agent has a designated muted color for its icon and label:

| Agent                | Color        | Hex       |
| -------------------- | ------------ | --------- |
| React Architect      | Soft Cyan    | `#7ABFDB` |
| .NET Architect       | Soft Purple  | `#9B7FD4` |
| Agentic Architect    | Gold         | `#D4A843` |
| PostgreSQL Architect | Steel Blue   | `#6B9EC4` |
| UX/UI Specialist     | Dusty Rose   | `#C87A9B` |
| Git/GitHub           | Silver       | `#8A9A9E` |
| Requirements PO/BA   | Sage Green   | `#5DB88A` |
| Code Planner         | Slate        | `#8A9A8E` |
| Execution Planner    | Burnt Orange | `#D49353` |
| CI/CD DevOps         | Muted Red    | `#C46B6B` |
| Cloud Infra          | Teal         | `#5BB8A8` |

### 2.5 Color Rules

- **NEVER** use pure white (`#FFFFFF`) for text. Always use the gold family (`--ca-gold-bright` for headings, `--ca-gold-primary` for accents).
- **NEVER** use pure black (`#000000`) for backgrounds. The darkest background is `--ca-bg-primary` (#0F1517).
- Gradients should use gold tones: `linear-gradient(135deg, #B8976A, #8B6F4A)` for CTAs.
- Background gradients are radial, centered: `radial-gradient(ellipse at 50% 30%, #1E2E33 0%, #161F22 40%, #0F1517 100%)`.
- All borders are gold-based with low opacity: `1px solid rgba(184,151,106, 0.08)` default, `0.18` on hover.
- No shadows except subtle `drop-shadow` on the window icon with gold glow: `drop-shadow(0 20px 60px rgba(184,151,106,0.15))`.

---

## 3. Typography

### 3.1 Font Stack

| Role                | Font               | Weight          | Fallback                         | Usage                                               |
| ------------------- | ------------------ | --------------- | -------------------------------- | --------------------------------------------------- |
| Display / Headings  | Cormorant Garamond | 400 (regular)   | Playfair Display, Georgia, serif | h1, h2, section titles, brand name                  |
| Body / Descriptions | EB Garamond        | 400, italic 400 | Cormorant Garamond, serif        | Paragraphs, descriptions, taglines                  |
| Code / Monospace    | JetBrains Mono     | 400             | Fira Code, monospace             | Code snippets, diff viewer, technical data          |
| UI Labels           | Cormorant Garamond | 500-600         | Georgia, serif                   | Buttons, navigation, agent names, small caps labels |

### 3.2 Font Import

```css
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=EB+Garamond:ital,wght@0,400;0,500;1,400;1,500&family=JetBrains+Mono:wght@400&display=swap');
```

### 3.3 Typography Scale

| Element                                | Font               | Size                       | Weight  | Color         | Letter Spacing | Other                              |
| -------------------------------------- | ------------------ | -------------------------- | ------- | ------------- | -------------- | ---------------------------------- |
| Brand title "Code Atelier"             | Cormorant Garamond | `clamp(42px, 8vw, 88px)`   | 400     | `#C8B89A`     | 0.04em         | Space between words: 0.18em        |
| Section eyebrow (e.g., "THE ENSEMBLE") | Cormorant Garamond | 13px                       | 400     | `#B8976A`     | 0.35em         | text-transform: uppercase          |
| Section heading                        | Cormorant Garamond | `clamp(28px, 5vw, 48px)`   | 400     | `#C8B89A`     | —              | line-height: 1.2                   |
| Subsection heading                     | Cormorant Garamond | `clamp(26px, 3.5vw, 38px)` | 400     | `#C8B89A`     | —              | line-height: 1.2                   |
| Body text                              | EB Garamond        | 15-17px                    | 400     | `#6A7A7E`     | —              | line-height: 1.7-1.8, often italic |
| Agent name                             | Cormorant Garamond | 16px                       | 600     | (agent color) | 0.02em         | —                                  |
| Agent description                      | EB Garamond        | 13.5px                     | 400     | `#5E6E72`     | —              | line-height: 1.6                   |
| Button text                            | Cormorant Garamond | 16px                       | 500-600 | varies        | 0.15em         | text-transform: uppercase          |
| Tagline                                | Cormorant Garamond | `clamp(14px, 2.2vw, 20px)` | 300     | `#8A9A9E`     | 0.25em         | text-transform: uppercase          |
| Code                                   | JetBrains Mono     | 12px                       | 400     | varies        | —              | line-height: 2.1                   |

### 3.4 Typography Rules

- **NEVER** use Arial, Inter, Roboto, or any sans-serif system font. This is a serif-first brand.
- Headings are always weight 400 (regular), never bold. The elegance comes from the typeface, not weight.
- Use italic EB Garamond for descriptive/explanatory text to convey the artisanal voice.
- Button/label text uses uppercase with generous letter-spacing (0.15em).
- The "™" mark appears at the top-right of the brand name, smaller (11px), at 50% opacity.

---

## 4. Iconography

### 4.1 App Icon: Ornate Diamond Sigil

The primary application icon is the ornate diamond sigil. It scales across all contexts:

**Construction at 1024px (canonical size):**

- Background: `#1C272D` rounded rect (rx=224)
- Outer diamond: 560px side, rotated 45°, stroke `#B8976A` 14px, rx=24
- Middle diamond: 488px side, rotated 45°, stroke `#B8976A` 4px, opacity 0.2
- Inner diamond: 420px side, rotated 45°, stroke `#B8976A` 2px, opacity 0.1
- Center text: `</>` in JetBrains Mono/Menlo, 176px, color `#C8B89A`, letter-spacing -4
- Top jewel: three concentric circles at apex — 26px `#C4714A`, 16px `#D4885A` 50%, 8px `#E8A070` 35%
- Bottom jewel: 20px `#C4714A` at 30% opacity
- Side jewels: 20px `#C4714A` at 22% opacity
- Diagonal dots: 12px `#B8976A` at 12-15% opacity
- ATELIER text: Georgia serif, 56px, color `#B8976A`, letter-spacing 28, flanked by 2px lines and 8px copper dot endpoints

**Required export sizes for macOS:**

| File                 | Size      | Usage              |
| -------------------- | --------- | ------------------ |
| `icon_16x16.png`     | 16×16     | Finder list view   |
| `icon_32x32.png`     | 32×32     | Finder list @2x    |
| `icon_64x64.png`     | 64×64     | Dock small         |
| `icon_128x128.png`   | 128×128   | Finder preview     |
| `icon_256x256.png`   | 256×256   | Finder preview @2x |
| `icon_512x512.png`   | 512×512   | App Store          |
| `icon_1024x1024.png` | 1024×1024 | App Store @2x      |
| `icon.svg`           | Vector    | Source of truth    |

### 4.2 macOS Tray Icon (Menu Bar)

The tray icon is a **monochrome template image**. macOS automatically applies the appropriate color (light on dark menu bar, dark on light menu bar).

**Construction:**

- ViewBox: 22×22
- Single diamond frame: 15px side, rotated 45°, stroke black 1.6px, rx=1.2
- Top jewel dot: r=1.6, filled black
- Center text: `</>` in Menlo/monospace, 7px, filled black
- No ATELIER text (too small)
- No inner frames or decorative dots (too small)

**Required files:**

| File                  | Size  | Usage                 |
| --------------------- | ----- | --------------------- |
| `trayTemplate.png`    | 18×18 | Menu bar @1x          |
| `trayTemplate@2x.png` | 36×36 | Menu bar @2x (Retina) |

**CRITICAL**: The filenames must end in `Template` (e.g., `trayTemplate.png`) for macOS to treat them as template images that auto-adapt to light/dark mode. Without the `Template` suffix, the icon will render as a fixed color.

**Electron tray integration:**

```javascript
const { app, Tray, nativeImage } = require('electron')
const path = require('path')

let tray
app.whenReady().then(() => {
  const iconPath = path.join(__dirname, 'resources', 'trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true) // Required for macOS auto light/dark
  tray = new Tray(icon)
  tray.setToolTip('Code Atelier')
})
```

### 4.3 Agent Icons

All agent icons are **custom SVG line drawings** in the gold-line Renaissance style. They must:

- Use thin strokes (1.2px) in the agent's designated color
- Have `fill="none"` (outline only, no filled shapes except rare small dots)
- Fit a 24×24 viewBox
- Feel like they could be etchings in a cathedral window pane

Icon descriptions for each agent:

| Agent                | Icon Description                                                                     |
| -------------------- | ------------------------------------------------------------------------------------ |
| React Architect      | Three intersecting orbital ellipses with center dot (atom)                           |
| .NET Architect       | Rounded rectangle frame with chevron arrow inside, corner dot                        |
| Agentic Architect    | Hub-and-spoke: one circle at top connected to three circles at bottom via lines      |
| PostgreSQL Architect | Database cylinder: top ellipse, vertical sides, bottom curve, middle divider line    |
| UX/UI Specialist     | Rounded square containing a small circle, small rectangle, and two horizontal lines  |
| Git/GitHub           | Merge graph: two circles at top converging via curved paths to one circle at bottom  |
| Requirements PO/BA   | Document rectangle with three horizontal lines and a checkmark at bottom             |
| Code Planner         | Three connected module rectangles in an inverted-V arrangement with connecting paths |
| Execution Planner    | Calendar/Gantt rectangle with header line and three progress bars of varying width   |
| CI/CD DevOps         | Circular arrows (deploy cycle) with gear-spoke lines radiating outward               |
| Cloud Infrastructure | Cloud outline with three short vertical lines below (rain/connection metaphor)       |

### 4.4 Brand Mark: CA Monogram

- Letters "CA" in Georgia / Cormorant Garamond, weight 600
- Used in footer, compact branding contexts
- Default color: `#C8B89A` on dark backgrounds, `#1E2A2F` on light backgrounds

---

## 5. Spatial & Layout Principles

### 5.1 Composition

- **Generous negative space**: The brand breathes. Sections have 100-120px vertical padding.
- **Centered vertical flow**: Content is center-aligned with max-width constraints (960-1100px).
- **Asymmetric feature panels**: Alternating left-right layout for feature descriptions, creating visual rhythm.
- **Renaissance framing**: Decorative double-border frames (1px outer, 0.5px inner, gold at low opacity) around important sections.

### 5.2 Cards & Containers

- Card background: `rgba(184,151,106, 0.02)` default, `0.06` on hover
- Card border: `1px solid rgba(184,151,106, 0.08)` default, `0.18` on hover
- Card border-radius: `4px` (subtle, not rounded)
- Card padding: `24px 20px`
- Hover lift: `translateY(-2px)` with `0.5s cubic-bezier(0.16,1,0.3,1)` easing

### 5.3 Dividers

- Section dividers: `linear-gradient(90deg, transparent, rgba(184,151,106,0.12), transparent)` — a centered gold fade
- Content dividers: `1px solid rgba(184,151,106, 0.05)`

### 5.4 Buttons

- **Primary CTA**: `linear-gradient(135deg, #B8976A, #8B6F4A)`, text `#0F1517`, no border, radius 2px
- **Secondary CTA**: transparent bg, `1px solid rgba(184,151,106,0.3)`, text `#B8976A`, radius 2px
- **Both**: Cormorant Garamond, 16px, weight 500-600, uppercase, letter-spacing 0.15em, padding 14px 40px
- **Hover**: `translateY(-2px)` + `box-shadow: 0 8px 32px rgba(184,151,106, 0.2)`

---

## 6. Motion & Animation

### 6.1 Page Load Sequence

Staggered reveal on hero section:

1. Window icon: fade + scale from 0.92 → 1.0 (2.2s, delay 0.1s)
2. Title: fade + translateY from 30px → 0 (2.0s, delay 0.5s)
3. Divider line: width expands from 0 → 120px (1.5s, delay 0.8s)
4. Tagline: fade in (2.0s, delay 1.2s)
5. Subtitle: fade in (2.0s, delay 1.5s)
6. CTA buttons: fade + translateY from 20px → 0 (1.5s, delay 1.8s)

All use `cubic-bezier(0.16, 1, 0.3, 1)` — a gentle, decelerating ease.

### 6.2 Scroll Reveals

- Sections fade + translateY from 30-40px → 0 on intersection
- Agent cards stagger with 0.06s delay per card
- Feature panels slide in from left/right alternating (translateX ±40px)
- Transition: `all 0.5-1.0s cubic-bezier(0.16, 1, 0.3, 1)`
- Intersection Observer threshold: 0.05-0.15

### 6.3 Background Atmosphere

- **Floating symbols**: Mathematical and code symbols (∑, ∫, λ, Δ, →, ∞, #, {}, <=>) float in the hero background
  - Animation: `symbolFloat` — fade in to 12% opacity, drift upward 20px with 5° rotation, fade out
  - Duration: 15-30s per symbol, randomized delays 0-8s
  - Color: `#B8976A`, max opacity 12%
- **Grain overlay**: SVG fractalNoise texture at 3% opacity with `mix-blend-mode: overlay`
- **Radial glow**: 700px circle centered behind the window icon, `rgba(184,151,106, 0.1)` fading to transparent

### 6.4 Scroll Indicator

- Text "Descend" + down arrow at bottom of hero
- `scrollPulse` animation: translateY 0→8px (2s, ease-in-out, infinite)
- Opacity: 40%

---

## 7. Asset Reference

When implementing this design system, the following brand assets should be provided as attachments:

| Asset            | Filename                | Description                                                       |
| ---------------- | ----------------------- | ----------------------------------------------------------------- |
| App Icon (SVG)   | `icon.svg`              | Ornate diamond sigil — vector source of truth                     |
| App Icon (1024)  | `icon_1024x1024.png`    | Full-size app icon for App Store                                  |
| App Icon (512)   | `icon_512x512.png`      | App Store standard                                                |
| App Icon (256)   | `icon_256x256.png`      | Finder preview @2x                                                |
| App Icon (128)   | `icon_128x128.png`      | Finder preview                                                    |
| App Icon (64)    | `icon_64x64.png`        | Dock                                                              |
| App Icon (32)    | `icon_32x32.png`        | Finder list @2x                                                   |
| App Icon (16)    | `icon_16x16.png`        | Finder list                                                       |
| Tray Icon @1x    | `trayTemplate.png`      | 18×18 monochrome template for macOS menu bar                      |
| Tray Icon @2x    | `trayTemplate@2x.png`   | 36×36 monochrome template for Retina menu bar                     |
| Cathedral Window | `Atelier_Door.png`      | The arched window icon with code symbols (transparent background) |
| Four Panels      | `Atelier_Paint.png`     | The four Renaissance-style panels (transparent background)        |
| CA Logo          | `Atelier_CA.jpg`        | The CA monogram and simplified window mark, split layout          |
| Full Name        | `Atelier_NameFont.jpg`  | "Code Atelier™" wordmark with window icon above                   |
| Window Detail    | `Aterlier_Window.jpg`   | Detailed view of the cathedral window with ornamental elements    |
| Panels (framed)  | `Atelier_-_Windows.jpg` | Four panels in ornate 3D frame on gallery wall                    |

### 7.1 Asset Usage Rules

- The **ornate diamond sigil** is the app icon and tray icon — it represents the application itself
- The **cathedral window** is the heritage/brand mark — used in marketing, landing pages, and the hero section
- The **four panels** image is used for the "Philosophy" or "Pillars" section
- The **CA monogram** is used in compact contexts: footer, compact header
- When assets have transparent backgrounds, they should float over the dark radial gradient without any container box
- Never stretch, crop into, or overlay text on top of the brand assets
- Tray icon filenames MUST end in `Template` for macOS auto light/dark adaptation

---

## 8. Electron / macOS Desktop Application Guidelines

This design system targets a **macOS Electron desktop application**. Follow these rules for platform-native integration:

### 8.1 Window Configuration

```javascript
const mainWindow = new BrowserWindow({
  width: 1400,
  height: 900,
  minWidth: 1000,
  minHeight: 700,
  backgroundColor: '#0F1517', // Match --ca-bg-primary to prevent white flash
  titleBarStyle: 'hiddenInset', // Native macOS traffic lights, content behind title bar
  trafficLightPosition: { x: 16, y: 16 },
  vibrancy: undefined, // Do NOT use macOS vibrancy — the app has its own dark theme
  transparent: false,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: path.join(__dirname, 'preload.js')
  }
})
```

### 8.2 Tray Icon Setup

```javascript
const { Tray, nativeImage, Menu } = require('electron')

function createTray() {
  const iconPath = path.join(__dirname, 'resources', 'trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true) // CRITICAL: enables macOS auto light/dark

  const tray = new Tray(icon)
  tray.setToolTip('Code Atelier')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Code Atelier', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Active Agents: 0', enabled: false },
    { label: 'Current Workspace: None', enabled: false },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' }
  ])
  tray.setContextMenu(contextMenu)
  return tray
}
```

### 8.3 App Icon for electron-builder

```json
{
  "build": {
    "appId": "com.codeatelier.app",
    "productName": "Code Atelier",
    "mac": {
      "icon": "resources/icon.icns",
      "category": "public.app-category.developer-tools",
      "darkModeSupport": true,
      "target": ["dmg", "zip"]
    },
    "directories": {
      "buildResources": "resources"
    }
  }
}
```

Generate `.icns` from the PNG set:

```bash
# Create iconset folder
mkdir icon.iconset
cp icon_16x16.png icon.iconset/icon_16x16.png
cp icon_32x32.png icon.iconset/icon_16x16@2x.png
cp icon_32x32.png icon.iconset/icon_32x32.png
cp icon_64x64.png icon.iconset/icon_32x32@2x.png
cp icon_128x128.png icon.iconset/icon_128x128.png
cp icon_256x256.png icon.iconset/icon_128x128@2x.png
cp icon_256x256.png icon.iconset/icon_256x256.png
cp icon_512x512.png icon.iconset/icon_256x256@2x.png
cp icon_512x512.png icon.iconset/icon_512x512.png
cp icon_1024x1024.png icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset
```

### 8.4 Title Bar & Window Chrome

- Use `titleBarStyle: 'hiddenInset'` so the native macOS traffic lights (close/minimize/zoom) are preserved
- Add a custom drag region at the top of the React app:

```css
.titlebar-drag-region {
  -webkit-app-region: drag;
  height: 38px;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
}
.titlebar-drag-region button,
.titlebar-drag-region input {
  -webkit-app-region: no-drag;
}
```

- Leave 80px of space on the left for the traffic lights
- The title bar area uses `--ca-bg-primary` (#0F1517) — the same as the app background, creating a seamless look

### 8.5 Typography in Electron

Electron renders web fonts. Include the Google Fonts import in the renderer HTML:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link
  href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=EB+Garamond:ital,wght@0,400;0,500;1,400;1,500&family=JetBrains+Mono:wght@400&display=swap"
  rel="stylesheet"
/>
```

For offline/bundled builds, download the font files and reference them locally:

```
resources/fonts/
  CormorantGaramond-Regular.woff2
  CormorantGaramond-Medium.woff2
  CormorantGaramond-SemiBold.woff2
  EBGaramond-Regular.woff2
  EBGaramond-Italic.woff2
  JetBrainsMono-Regular.woff2
```

### 8.6 Electron Resource Structure

```
resources/
  icon.icns                    # macOS app icon (generated from PNGs)
  icon.svg                     # Vector source
  icon_16x16.png ... 1024.png  # All PNG sizes
  trayTemplate.png             # 18×18 monochrome tray
  trayTemplate@2x.png          # 36×36 monochrome tray (Retina)
  fonts/                       # Bundled web fonts
  brand/                       # Marketing assets
    Atelier_Door.png
    Atelier_Paint.png
    Atelier_CA.jpg
    Atelier_NameFont.jpg
    Aterlier_Window.jpg
```

### 8.7 macOS-Specific Behaviors

- **Dock badge**: Use `app.dock.setBadge('3')` to show active agent count
- **Dock bounce**: Use `app.dock.bounce('informational')` when an agent completes
- **Native notifications**: Use Electron's `Notification` API for agent completion, errors, PR created
- **Touch Bar** (if supporting older MacBooks): Show agent status icons using the diamond sigil SVGs
- **Dark mode**: The app is ALWAYS dark. Do not respond to `nativeTheme.shouldUseDarkColors` — override it:

```javascript
nativeTheme.themeSource = 'dark' // Force dark mode always
```

---

## 9. Implementation Prompt Template

When instructing another Claude instance to implement a UI using this design system, use the following prompt structure:

```
You are the UX/UI Specialist for Code Atelier, a macOS Electron desktop application — an AI-powered software development studio.

PLATFORM: macOS Electron app with React renderer. Use titleBarStyle 'hiddenInset', dark mode always forced, tray icon with Template suffix for auto light/dark.

BRAND REFERENCE: Attached are the brand assets and the Brand & Design System Specification document. Every UI element you create must conform to this specification.

KEY RULES:
1. COLORS: Use the exact hex values from the specification. Primary bg: #0F1517. Gold accent: #B8976A. Text: #C8B89A for headings, #6A7A7E for body.
2. TYPOGRAPHY: Cormorant Garamond for headings (weight 400), EB Garamond for body (italic for descriptions), JetBrains Mono for code. NEVER use sans-serif.
3. APP ICON: Ornate diamond sigil with </> brackets, triple frame, copper jewels at vertices, ATELIER below.
4. TRAY ICON: Monochrome template image — simplified diamond + jewel dot + </>. Must end in 'Template' for macOS auto-adaptation.
5. ICONS: All agent icons are SVG line-art with 1.2px strokes, fill="none", in the agent's designated color. No emoji. No filled icons.
6. SPACING: Generous. 100-120px section padding. 24px card padding. The brand breathes.
7. MOTION: Scroll-triggered reveals with cubic-bezier(0.16,1,0.3,1). Staggered card animations.
8. ATMOSPHERE: Grain overlay (3% opacity fractalNoise), radial gold glow behind key elements.
9. DARK THEME: Always. Force nativeTheme.themeSource = 'dark'. Never light mode. Darkest bg is #0F1517, never pure black.
10. ELECTRON: hiddenInset title bar, 80px left padding for traffic lights, backgroundColor '#0F1517' to prevent white flash.

ATTACHED ASSETS:
- [Attach: icon.svg] — Ornate diamond sigil (vector source)
- [Attach: trayTemplate.png] — 18×18 monochrome tray icon
- [Attach: trayTemplate@2x.png] — 36×36 monochrome tray icon (Retina)
- [Attach: Atelier_Door.png] — Cathedral window icon (transparent bg)
- [Attach: Atelier_Paint.png] — Four Renaissance panels (transparent bg)
- [Attach: Atelier_CA.jpg] — CA monogram
- [Attach: Atelier_NameFont.jpg] — Full wordmark
- [Attach: Aterlier_Window.jpg] — Window detail reference

Now implement: [YOUR SPECIFIC UI REQUEST HERE]
```

---

## 10. CSS Variables Template

```css
:root {
  /* Backgrounds */
  --ca-bg-primary: #0f1517;
  --ca-bg-secondary: #1c272d;
  --ca-bg-elevated: #1e2e33;
  --ca-bg-input: #161f22;

  /* Gold */
  --ca-gold-primary: #b8976a;
  --ca-gold-bright: #c8b89a;
  --ca-gold-muted: #8b6f4a;
  --ca-gold-glow: rgba(184, 151, 106, 0.15);

  /* Panels */
  --ca-panel-olive: #3a3531;
  --ca-panel-terracotta: #6a4638;
  --ca-panel-teal: #3c4b46;
  --ca-panel-navy: #283337;

  /* Jewel */
  --ca-jewel: #c4714a;

  /* Text */
  --ca-text-primary: #c8b89a;
  --ca-text-secondary: #8a9a9e;
  --ca-text-tertiary: #6a7a7e;
  --ca-text-dim: #4a5a5e;
  --ca-text-body: #5e6e72;

  /* Borders */
  --ca-border-subtle: rgba(184, 151, 106, 0.08);
  --ca-border-medium: rgba(184, 151, 106, 0.18);
  --ca-border-strong: rgba(184, 151, 106, 0.3);

  /* Surfaces */
  --ca-surface-card: rgba(184, 151, 106, 0.02);
  --ca-surface-hover: rgba(184, 151, 106, 0.06);

  /* Agent colors */
  --ca-agent-react: #7abfdb;
  --ca-agent-dotnet: #9b7fd4;
  --ca-agent-agentic: #d4a843;
  --ca-agent-postgres: #6b9ec4;
  --ca-agent-ux: #c87a9b;
  --ca-agent-git: #8a9a9e;
  --ca-agent-requirements: #5db88a;
  --ca-agent-codeplanner: #8a9a8e;
  --ca-agent-execution: #d49353;
  --ca-agent-cicd: #c46b6b;
  --ca-agent-cloud: #5bb8a8;

  /* Semantic */
  --ca-success: #5db88a;
  --ca-error: #c46b6b;
  --ca-warning: #d49353;
  --ca-info: #6b9ec4;

  /* Typography */
  --ca-font-display: 'Cormorant Garamond', 'Playfair Display', Georgia, serif;
  --ca-font-body: 'EB Garamond', 'Cormorant Garamond', serif;
  --ca-font-mono: 'JetBrains Mono', 'Fira Code', monospace;

  /* Motion */
  --ca-ease: cubic-bezier(0.16, 1, 0.3, 1);
  --ca-duration-fast: 0.3s;
  --ca-duration-medium: 0.5s;
  --ca-duration-slow: 1s;
  --ca-duration-reveal: 2s;

  /* Spacing */
  --ca-section-padding: 100px 40px;
  --ca-card-padding: 24px 20px;
  --ca-card-radius: 4px;
  --ca-button-radius: 2px;
  --ca-max-width: 1100px;
  --ca-max-width-content: 960px;
}
```

---

## 11. Anti-Patterns (What NOT to Do)

| Never                                        | Instead                                            |
| -------------------------------------------- | -------------------------------------------------- |
| Use emoji for agent icons                    | Use custom SVG line-art icons                      |
| Use sans-serif fonts (Inter, Arial, Roboto)  | Use Cormorant Garamond / EB Garamond               |
| Use pure white or pure black                 | Use the gold/teal palette extremes                 |
| Use heavy font weights (700+) for headings   | Use weight 400; elegance from the typeface         |
| Use colored filled backgrounds for cards     | Use near-transparent gold overlays                 |
| Use sharp box shadows                        | Use gold-tinted drop-shadows or none               |
| Use rounded corners > 6px                    | Keep corners subtle (2-4px)                        |
| Use bright saturated accent colors           | Use muted, dusty versions of each color            |
| Place text over brand images                 | Keep images as standalone visual elements          |
| Use standard UI component libraries unstyled | Override everything to match the atelier aesthetic |
| Use light/white themes                       | Always dark with gold accents                      |
| Use quick/snappy animations                  | Use slow, graceful reveals (1-2s)                  |

---

_Document version: 2.0 — March 2026_
_Updated: Added ornate diamond sigil icon, macOS tray icon specs, Electron integration guidelines_
_Target platform: macOS Electron desktop application with React renderer_
