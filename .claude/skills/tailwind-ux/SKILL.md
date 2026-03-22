---
name: tailwind-ux
description: >
  Tailwind CSS 4 patterns, accessibility (WCAG), component design, and UX best
  practices for Electron desktop apps. Use when working on UI components, styling,
  layouts, dark mode, animations, or accessibility in Tailwind CSS projects.
user-invocable: false
---

# Tailwind CSS 4 UX Patterns for Electron Apps

> **Version**: 1.0
> **Last updated**: 2026-03-21
> **Target**: Tailwind CSS 4, React 19, Electron desktop

## Before you start

1. Check Tailwind config: look for `tailwind.config.ts` or CSS `@import "tailwindcss"` directives
2. Check existing components: `src/renderer/src/components/`
3. Check layout structure: `src/renderer/src/components/layout/`
4. Check shared components: `src/renderer/src/components/common/`
5. Confirm Tailwind version: `npm ls tailwindcss`

## Tailwind CSS 4 key changes

Tailwind CSS 4 uses CSS-first configuration — no more `tailwind.config.ts` for most setups:

```css
/* src/renderer/src/assets/main.css */
@import "tailwindcss";

/* Custom theme via CSS variables */
@theme {
  --color-primary: #6366F1;
  --color-primary-hover: #4F46E5;
  --color-surface: #1E1E2E;
  --color-surface-elevated: #252542;
  --color-border: #3D3D5C;
  --color-text-primary: #F1F5F9;
  --color-text-secondary: #94A3B8;
  --radius-default: 0.5rem;
  --font-sans: 'Inter', system-ui, sans-serif;
}
```

### What changed from v3

| v3 | v4 |
|----|-----|
| `tailwind.config.ts` | CSS `@theme` directive |
| `@apply` (overused) | Prefer utility classes directly |
| `darkMode: 'class'` config | `@variant dark { ... }` or automatic `prefers-color-scheme` |
| Plugin system | CSS `@plugin` directive |
| `content` array for purging | Automatic content detection |

## Component patterns

### Card component

```tsx
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-surface-elevated p-4 ${className ?? ''}`}>
      {children}
    </div>
  );
}
```

### Button variants

```tsx
const buttonVariants = {
  primary: 'bg-primary text-white hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary/50',
  secondary: 'bg-surface-elevated text-text-primary border border-border hover:bg-surface',
  ghost: 'text-text-secondary hover:text-text-primary hover:bg-surface-elevated',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500/50',
} as const;

function Button({
  variant = 'primary',
  children,
  ...props
}: { variant?: keyof typeof buttonVariants } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium
        transition-colors disabled:pointer-events-none disabled:opacity-50
        ${buttonVariants[variant]}`}
      {...props}
    >
      {children}
    </button>
  );
}
```

### Input fields

```tsx
function Input({ label, error, ...props }: { label: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = props.id ?? label.toLowerCase().replace(/\s+/g, '-');
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text-secondary">
        {label}
      </label>
      <input
        id={id}
        className={`rounded-md border bg-surface px-3 py-2 text-sm text-text-primary
          placeholder:text-text-secondary/50 focus:outline-none focus:ring-2
          ${error ? 'border-red-500 focus:ring-red-500/50' : 'border-border focus:ring-primary/50'}`}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...props}
      />
      {error && (
        <p id={`${id}-error`} className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
```

## Layout patterns for Electron

### Sidebar + main content

```tsx
function AppLayout() {
  return (
    <div className="flex h-screen bg-surface text-text-primary">
      {/* Sidebar — fixed width, scrollable */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface-elevated">
        <div className="p-4 font-semibold">Agent Studio</div>
        <nav className="flex-1 overflow-y-auto p-2">
          {/* nav items */}
        </nav>
      </aside>

      {/* Main content — fills remaining space */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center border-b border-border px-4 py-3">
          {/* toolbar */}
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          {/* content */}
        </div>
      </main>
    </div>
  );
}
```

### Titlebar drag region (frameless windows)

```tsx
<div className="flex h-8 items-center [-webkit-app-region:drag]">
  <span className="px-3 text-xs text-text-secondary">Agent Studio</span>
  {/* Buttons must opt OUT of drag */}
  <button className="[-webkit-app-region:no-drag]">Close</button>
</div>
```

## Accessibility (WCAG 2.1 AA)

### Required for all interactive elements

1. **Keyboard navigable**: all interactive elements reachable via Tab, activated via Enter/Space
2. **Focus visible**: use `focus-visible:ring-2` (not `focus:ring-2` — avoids ring on mouse click)
3. **Color contrast**: minimum 4.5:1 for normal text, 3:1 for large text
4. **ARIA labels**: icons without text need `aria-label`
5. **Role and state**: toggle buttons use `aria-pressed`, expandable sections use `aria-expanded`

### Focus management

```tsx
// ✅ Visible focus ring only on keyboard navigation
className="focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none"

// ❌ Shows ring on every click
className="focus:ring-2 focus:ring-primary"
```

### Screen reader patterns

```tsx
{/* Visually hidden but accessible */}
<span className="sr-only">Close sidebar</span>

{/* Icon-only button — MUST have aria-label */}
<button aria-label="Close sidebar" className="...">
  <XIcon className="h-4 w-4" />
</button>

{/* Live region for dynamic content */}
<div aria-live="polite" aria-atomic="true">
  {statusMessage}
</div>
```

### Keyboard shortcuts

```tsx
// Trap focus in modals
function Modal({ isOpen, onClose, children }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
      <div ref={ref} className="rounded-lg bg-surface-elevated p-6 shadow-xl" tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
```

## Dark mode

For Electron desktop apps, prefer system theme detection via `nativeTheme`:

```css
/* Automatic dark mode via media query */
@media (prefers-color-scheme: dark) {
  :root {
    --color-surface: #1E1E2E;
    --color-text-primary: #F1F5F9;
  }
}
```

In Electron, sync with `nativeTheme.shouldUseDarkColors` via IPC (see electron-pro skill).

## Animation guidelines

- Use `transition-colors` for hover/focus state changes (fast, 150ms default)
- Use `transition-all` sparingly — only when multiple properties change
- Prefer `transform` and `opacity` for animations (GPU-accelerated, no layout thrash)
- Respect `prefers-reduced-motion`:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

## Common pitfalls

| Pitfall | Fix |
|---------|-----|
| `focus:ring` shows on mouse click | Use `focus-visible:ring` instead |
| Icon buttons without labels | Add `aria-label` to every icon-only button |
| Fixed sidebar breaks on small windows | Use `shrink-0` on sidebar, `overflow-hidden` on main |
| Hard-coded colors instead of theme vars | Use `@theme` CSS variables via `bg-surface`, `text-text-primary` |
| Missing keyboard navigation in custom components | Ensure `tabIndex`, `onKeyDown` for Enter/Space |
| `@apply` overuse | Prefer utility classes directly; `@apply` only for base styles |
| Not testing with reduced motion | Add `prefers-reduced-motion` media query |
| Drag region covers buttons | Use `[-webkit-app-region:no-drag]` on interactive elements |
