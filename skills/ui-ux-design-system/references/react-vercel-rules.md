# React 19 & Composition Patterns (Vercel Engineering Rules)

Load this reference when editing or reviewing React / Next.js codebases.

## 1. Eliminate Async Waterfalls
- **Parallel Independent Fetches**: Use `Promise.all([...])` or start promises before awaiting so sequential round-trips never stack latency.
- **Suspense Boundaries**: Wrap slow data subtrees in `<Suspense fallback={...}>` instead of blocking the entire route shell.

## 2. Bundle Size & Barrel Hygiene
- **Avoid Barrel Re-Exports**: Import directly from component or utility paths (`./ui/Button`) instead of mega `index.ts` barrels, preserving tree-shaking and fast dev cold-starts.
- **Lazy Heavy Modules**: Load charts, rich-text editors, or 3D scenes via `React.lazy` / dynamic `import()`.

## 3. Component Architecture & React 19
- **Avoid Boolean Prop Proliferation**: Replace multi-flag components (`isCompact`, `isDark`, `isOutline`) with explicit `variant` unions or compound subcomponents (`<Card.Header>`, `<Card.Body>`).
- **Direct `ref` Prop**: In React 19+, accept `ref` as a standard prop instead of wrapping components in `forwardRef`.
- **Children over Render Props**: Prefer slot/children composition and explicit state/actions context interfaces over deeply nested render callbacks.

## 4. Native React View Transitions (`<ViewTransition>`)
- **Communicate Spatial Continuity**: Only wrap transitions that express a clear relationship, in priority order: (1) Shared element (`name`), (2) Suspense reveal (`enter`/`exit`), (3) List reorder identity (per-item `key`), (4) State enter/exit, (5) Route change.
- **Directional vs Lateral**: Reserve directional slides (`addTransitionType('nav-forward' | 'nav-back')`) for hierarchical list->detail or ordered sequences; use subtle fade or `default="none"` for lateral tabs and silent background revalidations.
- **Graceful Degradation**: Trigger via `startTransition` / `useDeferredValue` / `<Suspense>` so unsupported browsers skip motion cleanly with zero JS runtime overhead.

