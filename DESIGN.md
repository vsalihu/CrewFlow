# CDS Operations design

**Design read:** a dense, desktop-first operations tool for coordinators and dispatchers, often used in the evening and before dawn, where a missed blocker means people stranded at a field. Legibility, trust and explicit state come before decoration. Responsive web pages serve phone use.

**Dials** (taste skill): `DESIGN_VARIANCE 2` (predictable grids), `MOTION_INTENSITY 1` (no decorative motion; reduced motion honoured), `VISUAL_DENSITY 8` (cockpit: tables, hairlines, tabular numerals).

**Reference:** the `linear.app` DESIGN.md in `.claude/skills/design-md-catalog` informed the restraint (neutral surfaces, hairline borders, one accent, compact type). No Linear branding, colours or assets are used. The accent is CDS's own deep teal.

## Tokens (`apps/web/app/globals.css`)

| Token                          | Light                       | Dark                        | Use                                     |
| ------------------------------ | --------------------------- | --------------------------- | --------------------------------------- |
| canvas / surface / surface-2   | #f7f8f8 / #ffffff / #f1f3f4 | #0e1011 / #15181a / #1b1f21 | Page, panels, hover                     |
| hairline / hairline-strong     | #e1e4e6 / #c9ced2           | #272c2f / #363c40           | Dividers, inputs                        |
| ink / ink-muted / ink-subtle   | #15181b / #474e55 / #6a7178 | #eef1f2 / #c3c9cd / #8f979c | Text hierarchy                          |
| accent                         | #0f6b62                     | #3fb3a5                     | Primary actions, links, focus           |
| ok / warn / bad / info (+ -bg) | green / amber / red / blue  | lightened for dark          | Status, always paired with a text label |

Light by default; dark follows `prefers-color-scheme` (or `data-theme`). No pure black or white text on surfaces.

## Rules

- **One radius:** 6px (`--radius-ui`) for buttons, inputs and panels; 4px for badges.
- **One accent**, used only for primary actions, links and focus. Status colours never carry meaning alone: every badge has a word ("blocked", "ready", "JU 3").
- **Type:** system UI stack (no network fonts), 14px base, `tabular-nums` for counts and times, monospace for references and external IDs (`translate="no"`).
- **State is explicit:** every line shows its blockers as sentences and the next concrete action. A green summary never hides a red requirement.
- **Copy:** plain, specific verbs ("Record Decision", "I Have Sent It"); Title Case for buttons and headings; errors say what to do next; loading text ends with "…"; no em dashes in interface copy.
- **Forms:** labels above inputs, no placeholder-as-label, `htmlFor` on every label, `autocomplete="off"` on operational fields, spellcheck off for IDs, server-side validation messages shown inline at the top in an `aria-live` region.
- **Accessibility:** skip link, visible `:focus-visible` outline, semantic tables and buttons, `aria-current` on toggles, reduced-motion respected.
- **Layout:** `max-w-[1500px]` container; side panels collapse below `xl`; wide tables scroll inside their panel (positioned scroll containers so hidden labels cannot widen the page). Verified at 390px width.

## Skills used

`web-design-guidelines` (pinned rules) for accessibility and form review; `design-taste-frontend` for consistency locks (accent, radius, theme), contrast and copy discipline (its landing-page sections do not apply to this dashboard); `design-md-catalog` for the reference read; `playwright-cli` for screenshots in light and dark mode and phone-width overflow checks.
