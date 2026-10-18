# Continuing development on Ubuntu

Everything the code needs is in git: the migrations (`packages/db/migrations/0001`–`0007`), all packages, the tests,
the golden vectors in `testdata/`, the ADRs and the plan. Nothing has to be rebuilt by hand. Only generated or private
things are left out (see the end).

## Set up

```bash
# Node 24 is required (engines: ">=24"); nvm is the easiest way
nvm install 24 && nvm use 24

git clone https://github.com/shahabannas058-bot/Point-of-Sale.git
cd Point-of-Sale
npm ci            # exact versions from package-lock.json (it lists the Linux native packages too)
npm run check     # typecheck + eslint + prettier + vitest; expect 40 test files / 762 tests
```

If `npm ci` fails while building `better-sqlite3` (no prebuilt binary for your Node), install the build tools and retry:
`sudo apt install -y build-essential python3`.

## Run it

- `npm run dev` serves the POS at http://localhost:5173 in a browser. The browser build keeps its database in
  IndexedDB (sql.js). An empty database loads the kiryana demo; add `?fresh=1` to see the first-run wizard.
- `npx tsx scripts/demo.ts` and `npx tsx scripts/service-smoke.ts` run the service without a UI.
- `npm run vectors` regenerates `testdata/*.json` (migration checksums, invoice hash vectors).

## What does not run on Ubuntu

- `apps/shell-dotnet/PosShell.App` is the Windows desktop window (WPF + WebView2, ADR-0010). It builds and runs on
  Windows only. The two C# test projects (`PosShell.Core.Tests`, `PosShell.Infrastructure.Tests`) target `net10.0`; they
  have not been tried on Linux. `PosShell.Core.Tests` already fails to compile (`GoldenVectorTests.cs(92,70)`, CS0411)
  and one `WebBridgeTests` test fails; both were like that before this work.
- Windows-only pieces planned for the shell (DPAPI, ESC/POS printing) cannot be tested here.

## What comes next on Linux

The server (`apps/server`: ASP.NET Core on .NET 10 + PostgreSQL, ADR-0002), the admin panel (`apps/admin`, React)
and the OpenAPI client are all not started and are fine to build on Ubuntu. See `PLAN.md` (Phase 2a) and
`docs/adr/`. Install the .NET 10 SDK and PostgreSQL first.

## Not in git on purpose

`node_modules/`, `dist/`, `coverage/`, `bin/`, `obj/` (rebuilt by `npm ci` and the builds), `*.db` / `*.sqlite` (shop
data, never commit), `*.pem` / `*.key` / `license-private*` (the licence signing key must never enter the repo), and
`.claude/settings.local.json` (personal settings).

## Good to know

- Linux file names are case-sensitive. `npm run typecheck` catches an import with the wrong case.
- Line endings are LF everywhere (`.gitattributes`, `.editorconfig`, Prettier); no CRLF is stored in git.
- The repository is public: do not commit anything private (licence keys, real shop data, customer details).
- One test (`auth.test.ts`, "equal PINs give different hashes") failed once during a full run on a PC that was short of
  memory and passed on every rerun; if you see it fail on a slow machine, rerun before digging.
