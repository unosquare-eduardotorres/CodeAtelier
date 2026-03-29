# Code Atelier Design Compliance Checklist

Use this checklist when reviewing any PR that touches UI components, styles, or visual elements.

## Colors

- [ ] No hardcoded Tailwind color classes (`bg-purple-*`, `text-amber-*`, `bg-green-*`, etc.)
- [ ] All colors use semantic tokens from `main.css` (`surface-*`, `text-*`, `border-*`, `primary`, `accent`, status tokens)
- [ ] No pure white (`#FFFFFF`, `#FFF`, `white`) or pure black (`#000000`, `#000`, `black`)
- [ ] Gold accent `#B8976A` used for interactive elements, borders, and highlights
- [ ] Status colors use semantic tokens: `success`, `warning`, `danger`, `info`
- [ ] Agent-specific colors use `--color-agent-*` tokens

## Typography

- [ ] No sans-serif fonts (Inter, Arial, Roboto, Helvetica, system-ui)
- [ ] Headings use Cormorant Garamond at weight 400 (not bold/semibold)
- [ ] Body text uses EB Garamond
- [ ] Code/monospace uses JetBrains Mono
- [ ] UI labels use uppercase Cormorant Garamond with `letter-spacing: 0.15em`
- [ ] Italic EB Garamond for descriptive/explanatory text

## Icons

- [ ] Agent icons are custom SVG line-art (1.2px stroke, `fill="none"`, agent color)
- [ ] No emoji used for agent icons
- [ ] Generic UI icons from Lucide React are acceptable
- [ ] Icons inherit color from parent via `currentColor`

## Spacing & Layout

- [ ] Border-radius max 4px (no `rounded-xl`, `rounded-2xl`, `rounded-full` on containers)
- [ ] Card padding: `24px 20px`
- [ ] Borders use gold-based rgba: `rgba(184, 151, 106, 0.08)` default, `0.18` hover
- [ ] No sharp box shadows — use gold-tinted drop-shadows or none

## Motion & Animation

- [ ] Easing uses `cubic-bezier(0.16, 1, 0.3, 1)` — slow, graceful
- [ ] Transition durations: minimum 200ms (fast), 500ms (normal), 1200ms (slow)
- [ ] No snappy/instant transitions on visible elements
- [ ] Hover cards use `translateY(-2px)` lift pattern
- [ ] `prefers-reduced-motion` respected

## Electron-Specific

- [ ] `backgroundColor` matches `#0F1517`
- [ ] `nativeTheme.themeSource = 'dark'` enforced
- [ ] Tray icon uses `Template` suffix for macOS auto light/dark
- [ ] 80px left padding for macOS traffic lights in title bar

## Accessibility

- [ ] Text contrast meets WCAG AA (4.5:1 normal, 3:1 large text)
- [ ] Focus rings visible (2px solid gold with offset)
- [ ] Touch targets minimum 44x44px
- [ ] `aria-*` attributes on interactive elements
- [ ] Color alone never conveys meaning — icons/text also used
