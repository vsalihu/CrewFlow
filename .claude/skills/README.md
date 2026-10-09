# Project skills

Third-party skills vendored into this repository so every Claude Code session
(including ephemeral cloud sessions) has them. Each was read and reviewed before
being added; update by re-fetching upstream, reviewing the diff and committing.

| Skill | Upstream | Commit | Licence | Notes |
|---|---|---|---|---|
| `design-taste-frontend` | Leonxlnx/taste-skill `skills/taste-skill` (tasteskill.dev) | `18dfc928` | MIT | Aimed at landing pages/portfolios; its §13 says dashboards/data tables are out of scope, so apply only the general parts (contrast, states, consistency, copy) to the operations app |
| `image-to-code` | Leonxlnx/taste-skill `skills/image-to-code-skill` | `18dfc928` | MIT | Requires an image-generation tool; image-first workflow is for marketing pages |
| `web-design-guidelines` | vercel-labs/agent-skills + vercel-labs/web-interface-guidelines | `063bee94` / `434b7f91` | MIT | Modified: rules pinned locally in `guidelines.md` instead of fetched at run time |
| `playwright-cli` | microsoft/playwright-cli `skills/playwright-cli` | `b85c7a73` | Apache-2.0 | Needs the `playwright-cli` command (`npm i -g @playwright/cli@0.1.22`) |
| `design-md-catalog` | VoltAgent/awesome-design-md `design-md/*/DESIGN.md` | `13be5c05` | MIT | Reference catalogue; SKILL.md written for this repo |

## playwright-cli in a cloud container

The cloud container ships Playwright's Chromium rather than Google Chrome. Point
the CLI at it per shell (not committed, because the path is container-specific):

```bash
export PLAYWRIGHT_MCP_BROWSER=chromium PLAYWRIGHT_MCP_EXECUTABLE_PATH=/opt/pw-browsers/chromium
```
