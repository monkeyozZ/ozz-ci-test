# Ozz Console Design System

## Overview

Light, violet-accented product UI derived from the user's Ozz reference. Prioritize project organization, state clarity and daily operational work. The product context is recorded in [PRODUCT.md](PRODUCT.md), and business behavior follows the [PRD](docs/prd.md). The current [v3 interactive prototype](designs/console-v3/index.html) adopts the Zeabur interactions actually observed in Chrome, with complete service and management flows. Its [coverage plan](designs/console-v3/coverage-plan.md) preserves the earlier requirements and identifies existing versus planned capabilities. A prototype does not certify a shipped application.

## Colors

| Role                              | Light     | Dark      |
| --------------------------------- | --------- | --------- |
| Canvas                            | `#F6F7FB` | `#171822` |
| Main surface                      | `#FCFCFE` | `#20212D` |
| Sidebar surface                   | `#F4F2FA` | `#1C1B2B` |
| Primary text                      | `#242536` | `#EBEBF4` |
| Secondary text                    | `#626579` | `#A6A6BC` |
| Borders                           | `#E4E6EF` | `#353545` |
| Primary action and selected state | `#6544E8` | `#AC95FF` |

- Light is the established default for desktop administration in normal room lighting. Dark supports the same tasks in dim lighting; it is a complete theme, including menus, dialogs, forms, logs and status indicators.
- Provide Light, Dark and System preferences. Theme changes preserve page context and unsaved form input. The v2 preview also provides explicit dark-theme views, including the mobile log and recovery examples.
- Success, caution and error each use a dedicated icon, text label and lightly tinted background. Status color never carries meaning alone.
- Implementation may express the tokens in OKLCH after visual/contrast checks. Avoid pure black/white expanses, decorative gradients and thick colored side stripes.

## Typography

- Product sans: Inter with PingFang SC, Noto Sans SC and system fallbacks for Chinese.
- Titles: approximately 24–28 px, medium/semibold; section titles 16–18 px.
- Body content and primary form text: 14 px; metadata: 13 px. Keep these readable at 390, 1024 and 1440 px instead of shrinking text to fit a desktop layout.
- Commit, IP, digest and logs: monospace; align numeric metrics with tabular numerals.
- Prefer concise Chinese labels and actual resource names. Long identifiers have a compact display and a clear way to access their full value in the eventual implementation.

## Layout

- Desktop workspace sidebar: 224 px. Project workspace sidebar: 248 px, including the project, environment and inherited Cluster context. Desktop global header: 64 px.
- Final mobile header: 60 px. In the final `stitch-ready` delivery, shared preprocessing aligns `.header`, `.topbar` and `.appbar`, places the navigation drawer below that header and removes duplicate sidebar branding. Earlier batch HTML dimensions are not the mobile design specification.
- Main page spacing: 24–32 px on desktop and 16 px horizontally on mobile; related fields use 12–16 px gaps.

| Review width                   | Layout behavior                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1440 px desktop                | Full workspace/project navigation, readable tables and two-column detail layouts where useful. Wider Stitch canvases use the same fluid content layout.      |
| 1024 px compact desktop/tablet | Preserve resource context; reduce secondary columns and wrap action groups before shrinking text. Wide data tables keep their own scrolling area.            |
| 390 px mobile                  | One-column content, collapsed navigation drawer, reachable primary actions and dialogs within the viewport. Logs and tables scroll within their own regions. |

- Mobile primary buttons and form controls have at least a 44 px target. Do not rely on horizontal page scrolling to reach confirmations or error messages.
- Global navigation contains Projects, Servers and Settings. Project navigation contains project context/settings/integrations, Add service and the actual service list. Aggregate resources stay in Settings, with an All resources shortcut; activities remain available in the header. Global pages do not inherit a fake production environment.
- Entering a project from the project list opens its service workspace when a service is available; the project overview remains reachable. Keep the inherited deployment target visible. Hide the environment selector only after a complete, successful read confirms one environment; show it for multiple environments, pagination and unresolved context. Environment management lives in project settings and never changes the Cluster.
- A global service list is an aggregate view that leads into the owning project and environment. Creating a service from a global entry still requires that context.
- Use predictable columns, readable tables and restrained section boundaries. Cards should group meaningful content, not wrap every label or number.
- Put actionable issues and in-progress tasks ahead of decorative location maps.

## Components

- One button vocabulary: violet primary, neutral secondary, quiet text action, explicit danger only for destructive actions.
- Controls and cards use approximately 8 px corners, thin borders and restrained elevation.
- Tabs, fields, badges, menus and tables should map naturally to shadcn-vue/Reka UI components.
- Project creation selects one registered Cluster and creates the default production environment. A registered but unverified target can hold project metadata; deployment requires a working connection, permissions and the required capabilities. Show those states separately.
- Project.clusterId is the only configurable placement source at creation and is not editable through ordinary settings. A Cluster may host multiple projects. Environment and Service inherit the project target; their forms show it as context rather than another selector. Existing environments cannot be reassigned to another project through ordinary settings; cross-project copies create target environments.
- Server shows its own host and associated Node; Cluster owns the node list and associated projects. A single-node Cluster may use its server name as a display label, but all selection and routing resolves to that Cluster. A Server without an associated Cluster leads to onboarding. Multi-node servers must not become duplicate deployment targets or imply that a project is pinned to that host.
- Project detail presents services within the selected environment and shows only dependencies backed by known configuration. Service creation and template instantiation inherit that project and environment. Project-level environment copies stay in the same Cluster; separate clusters require separate projects.
- Project configuration copies allocate new resource identities and remap dependencies; imports into an existing project inherit its Cluster. Cross-cluster data migration uses a target project and an explicit restore, verification and cutover flow under F48. Ordinary target editing must not imply data migration.
- Service detail has adjacent but distinct draft, published-snapshot and observed-runtime summaries.
- Service workspaces use six tabs: status, variables, usage, network, data/storage and settings. Deployment review, logs and deployment history open contextual panels. Visited editors retain their unsaved inputs between tabs; variables and runtime settings share one draft. Existing tab URLs continue to locate the corresponding editor or panel.
- Add service opens a dialog over the original project/service page. GitHub, Docker, application templates and databases are four source rows. Back returns one step and preserves each source draft; closing checks only creation drafts and preserves the background editor. Desktop dialogs are bounded and scroll internally; mobile dialogs fill the viewport.
- Configuration submission first saves a service draft and retains its identity, then opens deployment review in the same dialog. Copy states this write explicitly. Returning to edit updates that service. In-flight requests and uncertain creation results cannot return to a new source; retry uses the same request and idempotency key. Successful saves clear secret input values. Refreshing an accepted result verifies its project, environment and source before resuming.
- Cross-page links preserve the project, environment, inherited Cluster and selected service. Task, revision, Pod and container are carried when relevant. A node alert without a service identity leads to its Cluster or project; missing or stale context must not silently fall back to the blog/web-app sample.
- Publishing, restoring and rolling back have separate result states. Completed flows retain their result when returning to service details. Logs and terminals use that same source; a stopped service has no current instance to connect to, and history remains a separate capability.
- A design-preview marker identifies the Stitch demonstration context, including sample data and planned capabilities; the eventual live product uses actual data and timestamps.

## Motion and Interaction

Use short functional transitions and respect reduced-motion preferences. Preserve visible focus, semantic control labels and keyboard access to tabs, dialogs and menus. Log following must pause when the user moves away from the newest output, retain an unread count and offer an explicit return to the bottom.

The v2 source prototypes include these interaction patterns and targeted DOM checks. Visual layout, keyboard focus, Chinese IME, contrast, 200% zoom and long-running streams still require appropriate real-browser checks. Prototype and Stitch checks are recorded separately from future Vue application, API, infrastructure and data-recovery acceptance.

Following the user’s 2026-10-29 scope decision, accessibility, assistive-technology testing, real screen-reader checks and WCAG conformance are excluded from current requirements and acceptance gates (`excluded-by-user`). Existing semantic labels, component behavior and historical evidence remain. Keyboard, focus, IME, responsive layout, zoom and feedback stay in normal UX acceptance; historical failures are not changed to passes.

## Current Revision

The user’s 2026-10-29 direction is to adopt Zeabur’s interaction model and complete the prototype without omitting existing functions. The [v3 prototype](designs/console-v3/README.md) and [observed reference](designs/console-v3/reference-notes.md) are the current interaction reference; the v2 Stitch set remains historical design and coverage material. Project, service, infrastructure, data, delivery, settings and explicit planning flows retain loading, empty, failure, confirmation and recovery states. P0/P1/P2 business priorities and the 83 development task IDs remain; current UX requirements follow the scope decision above.

Use the v3 shell for current navigation and workflow placement, preserving the established theme and viewport sizes. The [implementation record](docs/console-v3-interaction.md) distinguishes prototype checks from actual Console, API and infrastructure validation. Earlier batch HTML and acceptance evidence remain traceable historical sources. The Vue 3, shadcn-vue/Reka and Tailwind CSS application has the corresponding S1–S4 local acceptance. S5 storage, database and template surfaces use real APIs and have passed controlled and real local browser flows; four Linux ARM64 images from frozen source passed Compose and archive verification. S6 fixed Git builds through HTTPS, stopped/running Webhook flows, real Console screens and seven Linux Builder fault scenarios have passed their local checks. Those checks do not certify this subsequent UX revision.

[OOM diagnostics and partial-application protection](docs/acceptance/g-mvp-workload-fault-local-lab.md), [C node/PVC persistence](docs/acceptance/g-mvp-node-persistence-local-lab.md), and [old/final backup restoration with original-database reconciliation](docs/acceptance/g-mvp-recovery-local-lab.md) have separate passing evidence. The recovery record covers two bounded continuity windows. Post-recovery Console HTTPS authentication and [final S6 Linux ARM64 delivery](docs/acceptance/S6-deployment.md) have passed. A new [joint recovery measurement](docs/acceptance/g-mvp-recovery-joint-timing.md) verified the logical snapshot, reconciled Builder and K3s, and completed a new diagnostic in 21.560 seconds; the window through return to the original environment was 35.584 seconds. The exact physical snapshot RPO remains unknown. External infrastructure checks remain open. The [screen-reader record](docs/acceptance/g-mvp-screen-reader.md) retains failed attempts and their state-restoration evidence as history; screen-reader acceptance is excluded by the user’s scope decision above. Overall S6 acceptance is still in progress; [the local acceptance matrix](docs/g-mvp-local-acceptance-plan.md) and [G-MVP evidence report](docs/acceptance/G-MVP.md) track the remaining work. A designed screen does not establish that its backend feature is complete.

The earlier v1 delivery comprises five light-theme desktop images: overview, cluster detail, service detail, infrastructure onboarding and service creation. Those images and their sample data remain historical design references; they do not limit this iteration's page or interaction coverage.
