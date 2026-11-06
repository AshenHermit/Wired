# Documentation Site Refactor — Design Doc

## Intent and Why

Move documentation from embedded homepage viewer to a dedicated `/docs` route with full sidebar navigation and syntax highlighting. This makes documentation more discoverable, reduces homepage clutter, and provides a better reading experience with anchors and code highlighting.

## Goals

- Create a standalone `/docs` route with docsify-style layout
- Implement sidebar tree navigation with internal anchors
- Add syntax highlighting to code blocks via highlight.js
- Replace homepage documentation viewer with simple links to `/docs`
- Preserve homepage styling: background, backdrop panels, and visual consistency

## Non-Goals

- Server-side documentation generation or build pipeline
- Documentation search functionality (can be added later)
- Auto-generated API docs from code comments
- Version-specific documentation branches

## Anti-Goals

- Changing homepage styling or removing the documentation links
- Breaking existing documentation content (4 markdown files)
- Adding complex routing or dynamic documentation loading

## Constraints

- All documentation lives in `frontend/public/docs/` as markdown files
- i18n support via next-intl (en/ru messages)
- React 19, Next.js 16 App Router, Tailwind v4
- Preserve existing doc content without modification
- Sidebar anchors auto-generated from markdown headings

## Approaches

**Option A: Docsify-style client-side site (chosen)**
- Build a custom React layout mirroring docsify: sidebar with tree nav + main content area
- Parse markdown headings to generate anchor links automatically
- Use highlight.js for syntax highlighting in react-markdown
- Minimal dependencies, full control over styling and behavior
- Trade-off: Manual anchor generation, no pre-built UI library

**Option B: Use an npm docsify wrapper**
- Wrap docsify.js library inside Next.js
- Pro: mature, feature-rich out of the box
- Con: adds external JS runtime dependency, harder to style consistently with Tailwind
- Rejected: over-engineered for our use case

**Option C: Static generation with Vitepress/Nextra**
- Pre-build documentation at Next.js build time
- Pro: fast, SEO-friendly
- Con: requires build step, breaks dev workflow, not needed for our scale
- Rejected: unnecessary complexity

## How It Gets Built

- **Routing:** New `app/(browser)/docs/page.tsx` serving `/docs` with layout
- **Components:**
  - `DocsPage`: Main layout container with sidebar + content area
  - `DocsSidebar`: Tree navigation, reads all markdown files, generates anchors from headings
  - `DocViewer`: Updated to accept `docName` prop and render with highlight.js integration
  - `MarkdownRenderer`: Utility to parse markdown, extract headings for anchors
- **Dependencies:** `highlight.js` added to frontend
- **Homepage:** Remove `DocViewer` and `DocsNav`, add simple "Documentation" section with 4 links to `/docs/<docName>`
- **Styling:** Copy backdrop panel and background styles from homepage to `/docs` route
- **i18n:** Update message keys for "Documentation" section link labels

## What's Left to the Builder

- Anchor ID generation algorithm (slugify heading text)
- Sidebar styling refinement (hover states, active indicators)
- Code block language detection and highlighting configuration
- Responsive sidebar behavior on mobile (collapse/expand)
