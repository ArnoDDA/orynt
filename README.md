# Orynt.ai

Turn product context and market evidence into a traceable creative workflow.

Orynt is an experimental, local-first advertising creative workspace:

**Product URL → product review → market discovery → Campaign Card → storyboard → media production → simulated launch → learning.**

## Quick start

Requires Node.js **22.13+** with `node:sqlite`. Node.js 24 LTS is recommended.

```sh
git clone https://github.com/ArnoDDA/orynt.git
cd orynt
corepack pnpm install --frozen-lockfile
cp .env.example .env
npm start
```

Open the local URL printed in the terminal, normally `http://127.0.0.1:4173/#/home`. Keep the terminal open. The server listens on loopback; an occupied default port falls back to the next available port. An explicit `PORT` is used strictly. On macOS and Windows, `start.command` and `start-windows.cmd` are alternative launchers after installing Node.js.

The unbundled application can also start with `node scripts/preview.mjs` before installing JavaScript development dependencies. Building the optimized web assets requires the dependencies above.

This repository contains application source, tests, migrations and synthetic SVG sample assets. **It does not contain credentials, existing workspaces, collected customer data, generated films or the private Owala replay baseline.** A new checkout starts a new workspace. The fixed replay requires separately prepared, verified local media; `npm run prepare:demo` snapshots existing local production artifacts and does not download or create that case from scratch. You can create ordinary campaigns without the replay baseline.

## Optional collection and media tools

Product-page import and basic website discovery use Python 3.10+ from `PATH`. Meta browser collection additionally needs Playwright and Chromium:

```sh
python3 -m venv .local/python
.local/python/bin/python -m pip install -r services/crawler/requirements.txt
PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/browsers" .local/python/bin/python -m playwright install chromium
```

Video-template analysis uses PySceneDetect/OpenCV. Image compositing, previews and local video editing use Pillow and system `ffmpeg`/`ffprobe`:

```sh
python3 -m venv .local/video-python
.local/video-python/bin/python -m pip install -r services/video-template/requirements.txt -r services/video-production/requirements.txt
```

Install FFmpeg with your operating system package manager, then set `ORYNT_VIDEO_PYTHON` in `.env` to the **absolute** path of `.local/video-python/bin/python`. The template analyzer detects that virtual environment automatically. Windows users should use the corresponding `Scripts/python.exe` paths. `ORYNT_FFMPEG`, `ORYNT_FFPROBE`, `ORYNT_TEMPLATE_PYTHON` and `ORYNT_FONT` can override tool/font paths.

## Provider configuration and current boundaries

Copy the placeholders in `.env.example` into your local `.env`; never commit real credentials. YouMind image/video generation requires your own API key, available credits and network access. Optional Claude text planning is enabled only with `ORYNT_STRATEGY_MODEL=claude` and a configured key/model. Generation may incur provider charges. No paid generation is performed by the automated test suite.

- Public-page and Meta collection can fail because of network, robots rules, login requirements or site changes. Missing data and demonstration samples are labeled.
- Strategy and storyboard planning include local rules. Model-assisted text planning does not constitute visual quality review.
- Product images and prompts may be sent to the selected media provider when you request generation. Website collection accesses the supplied public sites. The product is not fully offline.
- Launch, performance collection and learning currently use **simulated** data; they do not publish real advertisements or prove campaign performance.
- SQLite workspace data is saved under `.local/orynt.sqlite` by default. `ORYNT_DATA_DIR` overrides the database directory; other local media/cache tools still use `.local/`. Back up the database and associated local assets together.
- The local workspace is single-user. The hosted gateway supports a shared, password-protected workspace; it is not a multi-tenant SaaS deployment.

## Development and verification

Install the video-template dependencies and FFmpeg above before running the full Node suite: it includes a real MP4/keyframe analysis check. The remaining provider and collection checks use fixtures. GitHub Actions installs the required tools explicitly.

```sh
npm test
npm run build:web
python3 -m unittest discover -s services/crawler -p 'test_*.py'
```

The Node suite checks domain transitions, persistence, frontend workflow helpers, provider contracts, HTTP access controls, real template analysis and production behavior with temporary stores and provider fixtures. The Python suite exercises the crawler with fixtures. These checks do not claim to validate current live collection or the aesthetic quality of generated videos.

For an additional HTTP workflow integration check, first install the optional video-template tools and FFmpeg, then run:

```sh
node scripts/check-main-flow.mjs
```

This creates a small synthetic test video, uses a temporary database and mocked collection/video providers, checks real template analysis, and verifies simulated launch/metrics and persistence. It makes no paid generation calls. `ORYNT_CHECK_VIDEO` can instead point to a video you supply.

## Layout

| Directory | Purpose |
| --- | --- |
| `apps/web/public` | Browser application, styles and bundled assets |
| `apps/api/src` | HTTP server, SQLite repository, job runner and provider adapters |
| `packages/domain` | Campaign state and creative/production planning |
| `packages/provider-contracts` | Provider contracts |
| `services/crawler` | Public website, product and Meta collection |
| `services/video-template` | Optional template scene analysis |
| `services/video-production` | Local image/video composition helpers |
| `supabase/migrations` | Relational schema reference; local runtime uses SQLite |
| `scripts` | Build, launch, verification and optional local production utilities |
| `deploy` | Hosted gateway configuration examples |

The optional `compose.yaml` configuration starts a password-protected replay gateway with Caddy and a persistent database volume. It requires your own domain, HTTPS configuration and separately provisioned replay assets; the source-only container does not include the private demonstration. Local packaging, fixed-tunnel and demo-production utilities also require their own local prerequisites; cloning does not restore previous sharing sessions or media.

## Third-party notices

Production checks adapted from [OpenMontage](https://github.com/calesthio/OpenMontage) retain their **AGPL-3.0-only** headers. Attribution, upstream revision and license text are in `third_party/openmontage/NOTICE` and `third_party/openmontage/LICENSE`. Lucide's license is retained in `apps/web/public/vendor/LICENSE`. External Python/Node dependencies retain their own licenses. Public repository visibility does not remove these obligations or grant additional rights in third-party brand/media assets. No separate blanket license is granted here for original project code.
