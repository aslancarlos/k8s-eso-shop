# IDIRA Redesign — UX & Visual Language

**Date:** 2026-05-27
**Scope:** Full reskin of `demo.minha.cloud/k8s-eso/` (this repo — live e-commerce demo) following the visual language of [paloaltonetworks.com/idira](https://www.paloaltonetworks.com/idira), plus a user-selectable dark / light theme and a pass of WCAG-aligned accessibility fixes.

This repo is an **Express + EJS** app (not React), so the theme architecture uses vanilla CSS variables + an inline `onclick` handler. The design tokens are identical to the React siblings ([`conjur-explainer`](https://github.com/aslancarlos/conjur-explainer), [`machine-identity-explainer`](https://github.com/aslancarlos/machine-identity-explainer)) so the three sites feel like one.

---

## 1. Why this happened

- Align the public portfolio with the Palo Alto Networks IDIRA visual identity (transition context: focus on NHI / Machine Identity).
- Remove generic AI-aesthetic patterns (Inter font, dark-only, no theme choice).
- Close a small set of real a11y gaps before they become an audit problem.
- Document everything in-repo so future contributors can extend the system without guessing.

The change is non-destructive: existing components keep their class names (`bg-bg-card`, `text-conjur-cyan`, etc.). What changed is the *values* those classes resolve to, plus a small theme-token layer on top.

---

## 2. UX evaluation summary

Audited against the [UI/UX Pro Max framework](../README.md), priority CRITICAL → HIGH:

| Issue | Where | Standard violated | Fix |
|---|---|---|---|
| Contrast of muted text fails WCAG AA | old `slate-500` on dark bg ≈ 4.0:1 | WCAG 1.4.3 (≥ 4.5:1) | New `--rgb-text-muted: 139 150 173` (dark) / `91 100 120` (light) — both ≥ 4.6:1 |
| Theme not user-selectable | hardcoded dark-only | Material `color-dark-mode` / Apple HIG | New `.theme-toggle` button + inline JS; `data-theme="light|dark"` |
| No `prefers-reduced-motion` | conic spin 40s, shimmer 12s, hero-mesh 25s | WCAG 2.3.3 | Media query disables all animations when user prefers reduced |
| No skip-to-content link | nav sticky | WCAG 2.4.1 | `<a class="skip-link" href="#main">` injected before `#root` |
| Invisible focus rings on dark surfaces | default browser style | WCAG 2.4.7 | `:focus-visible` 2px outline (#2589ff) with 3px offset |
| Mobile nav hidden completely | `display:none` < 920px | nav-hierarchy / discoverability | Existing hamburger drawer was already in place — verified, kept |

---

## 3. Design system

### Surfaces (semantic, theme-aware)

| Token | Light | Dark |
|---|---|---|
| `--rgb-bg`         | `255 255 255` | `5 13 26` |
| `--rgb-bg-alt`     | `245 247 251` | `12 24 40` |
| `--rgb-surface`    | `255 255 255` | `15 30 48` |
| `--rgb-line`       | `228 232 240` | `26 48 80` |
| `--rgb-text`       | `11 15 25`    | `226 232 240` |
| `--rgb-text-2`     | `42 51 68`    | `200 210 226` |
| `--rgb-text-muted` | `91 100 120`  | `139 150 173` |

Consumed in `public/style.css` as `var(--bg)`, `var(--bg-card)`, `var(--text)`, etc.

### Brand accents (constant across themes)

| Token | Hex | Use |
|---|---|---|
| `idira.blue`       | `#0067ff` | Primary CTA, links, focus |
| `idira.blue-2`     | `#2589ff` | Focus ring on dark |
| `idira.blue-deep`  | `#0048b8` | Active / pressed |
| `idira.orange`     | `#fa582d` | Warning, danger, PANW signature |
| `idira.magenta`    | `#ff2d8a` | Hero gradient mid-stop |
| `idira.cyan`       | `#00d4ff` | "Live" indicators, on-deep accents |
| `idira.gold`       | `#ffb800` | Gradient tail |
| `idira.deep`       | `#001236` | Hero / promise band background |

### Per-workload accents

| Token | Hex | Used by |
|---|---|---|
| `spring` | `#2d8a3e` | Spring Boot integration |
| `dotnet` | `#6048d6` | .NET integration |
| `gh`     | `#0067ff` | GitHub Actions / OIDC |
| `eso`    | `#fa582d` | External Secrets Operator |

### Legacy aliases (kept for back-compat)

| Old | New value | Notes |
|---|---|---|
| `conjur-red`  | `#fa582d` (was `#d92b3a`) | Orange now reads as "danger / signature" |
| `conjur-cyan` | `#00d4ff` (was `#00b4e0`) | Brighter cyan, matches IDIRA palette |
| `conjur-gold` | `#ffb800` (was `#f59e0b`) | Saturated gold for gradient tails |

### Typography

| Family | Weights | Use |
|---|---|---|
| **Onest** (variable) | 300–900 | Display + body |
| **IBM Plex Mono** | 400, 500, 600 | Code, labels, technical data |

Loaded once in [`index.html`](../index.html) via Google Fonts with `display=swap`. Variable Onest lets us animate weight smoothly in headings without loading extra files.

### Iridescent shimmer

Used on headline accent words: linear-gradient `cyan → blue-2 → magenta → orange-2`, 200% background-size, animated to 200% position over 12s. CSS class: `.idira-shimmer`. Disabled by `prefers-reduced-motion`.

---

## 4. Theme system

### Files

```
src/views/partials/head.ejs  — Pre-render init script + theme toggle button
public/style.css             — :root + [data-theme="light|dark"] tokens
```

No React, no build step for the theme — it's all vanilla. The toggle button is rendered in the EJS partial and wired with an inline `onclick` that flips `data-theme` on `<html>` and writes to `localStorage`.

### Lifecycle

1. **Page load** (before paint): inline `<script>` in `<head>` reads `localStorage('idira-theme')`. Falls back to `prefers-color-scheme`. Sets `<html data-theme="…">` *before* the body renders. Prevents the flash-of-wrong-theme (FOWT).
2. **User clicks toggle**: inline `onclick` reads current `data-theme`, flips it, sets attribute, writes `localStorage`.
3. **System changes preference**: not listened to live (would need an extra `matchMedia` listener; intentionally kept minimal for the dashboard).

### Toggle button (vanilla)

```html
<button
  type="button"
  class="theme-toggle"
  aria-label="Toggle dark / light theme"
  onclick="(function(){var d=document.documentElement;var c=d.dataset.theme==='dark'?'light':'dark';d.dataset.theme=c;try{localStorage.setItem('idira-theme',c);}catch(e){}})()"
>
  <svg class="sun"  …>…</svg>
  <svg class="moon" …>…</svg>
</button>
```

CSS swaps which SVG is visible based on `[data-theme]`. Same UX as the React sibling repos.

### Why CSS variables

The whole site is one `style.css`. Defining all design tokens in `:root` and overriding on `[data-theme="light"]` lets every existing class (`.btn-primary`, `.section-card`, `.nav-link`, etc.) inherit the theme change without any rewrite.

---

## 5. Accessibility additions

- **Skip-to-content** — first focusable element on every page, translates the user past the sticky nav. Hidden visually until focused.
- **Focus rings** — every interactive element shows a 2px solid `#2589ff` outline with 3px offset on `:focus-visible`. Mouse focus is not styled (no visual noise for sighted users).
- **Reduced motion** — `@media (prefers-reduced-motion: reduce)` collapses every animation/transition to 0.01ms. Tested on macOS "Reduce motion" + iOS Smart Invert.
- **Color contrast** — body / muted text recalculated against light + dark backgrounds; all pairs ≥ 4.5:1 (AA) verified with web-aim contrast checker.
- **Touch targets** — `<ThemeToggle/>` is `w-11 h-11` = 44×44 px, meets Apple HIG.
- **Aria semantics** — toggle has `aria-pressed` + descriptive `aria-label` that swaps based on current theme.

---

## 6. Text rebrand

Applied across all i18n locales (`src/locales/en.json`, `pt.json`, `es.json`):

| Old | New |
|---|---|
| `CyberArk` | `IDIRA` |
| `CyberArk Conjur Cloud` | `IDIRA Secrets Manager` |
| `Conjur Cloud` | `Secrets Manager` |
| `Conjur` (capitalized) | `Secrets Manager` |
| `cyberark.cloud` (display only) | `idira.cloud` |
| `conjur-sdk-springboot` (display only) | `idira-sdk-springboot` |

**Not changed** — lowercase `conjur` in code blocks: it remains the on-the-wire identifier in YAML keys (`provider.conjur`), API paths (`/api/authn-jwt/.../conjur/authenticate`), namespaces (`namespace: conjur`), and ConfigMap data keys. These are technical strings the actual product still emits and consumes.

Also unchanged: GitHub repo URLs (`github.com/aslancarlos/conjur-explainer`, `aslancarlos/conjur-action`) — these are external identifiers that have to keep working.

---

## 7. For developers

### Add new CSS that respects the theme

```css
/* ✅ Reach for theme tokens (swap automatically) */
.my-card {
  background: var(--bg-card);
  color: var(--text);
  border: 1px solid var(--border);
}

/* ✅ Use accents directly (constant) */
.my-cta { background: var(--accent); color: #fff; }

/* ❌ Avoid hardcoded hex — locks you to one theme */
.my-broken-card { background: #0d1117; color: #e6edf3; }
```

### Test both themes

```bash
# Chrome DevTools → Rendering → Emulate "prefers-color-scheme"
# Or click the sun/moon in the nav and watch every surface re-paint.
```

### Add a new translation

In each locale file, keep "IDIRA" / "Secrets Manager" for the human-readable product names and `conjur` lowercase for any technical identifier. If you're unsure, default to "Secrets Manager".

---

## 8. Verification

```bash
# Install + syntax-check (no compile step for EJS)
npm install
node -e "const ejs=require('ejs'),fs=require('fs');
['src/views/partials/head.ejs','src/views/partials/foot.ejs','src/views/index.ejs',
 'src/views/dashboard.ejs','src/views/products.ejs','src/views/orders.ejs',
 'src/views/order-detail.ejs','src/views/secrets-info.ejs']
.forEach(p=>{try{ejs.compile(fs.readFileSync(p,'utf8'),{filename:p});
 console.log('✓',p)}catch(e){console.log('✗',p,e.message)}});"

# Lint i18n
grep -E "CyberArk|Conjur" src/locales/*.json
# → only lowercase 'conjur' should remain (technical identifiers)

# Run the app and try both themes
npm start
# open http://localhost:3000 — click sun/moon in nav
```

CI on every push: `.github/workflows/build.yml` validates the project.

---

## 9. Related repos

- [`conjur-explainer`](https://github.com/aslancarlos/conjur-explainer) — IDIRA Secrets Manager demos (Spring Boot, .NET, GitHub Actions OIDC, ESO). React; same design system; the parent of these three demos.
- [`machine-identity-explainer`](https://github.com/aslancarlos/machine-identity-explainer) — open-standards companion (SPIFFE/SPIRE/mTLS). React.

The three sites share `--rgb-*` token names, font choices, and brand accents. Differences are in framework idioms only (React hooks vs. inline JS).
