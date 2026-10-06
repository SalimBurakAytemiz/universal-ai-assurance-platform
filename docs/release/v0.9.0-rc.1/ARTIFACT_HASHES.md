# Artifact Hashes — v0.9.0-rc.1

SHA-256 over the release artifacts. Content hashes are reproducible from the repository; the desktop
binary hash is recorded from the dev/unsigned build on the audit host (an Electron package is not
bit-for-bit reproducible across machines/time, so it is reproducible-by-command, not bit-identical).

## Source of record
- **Repository:** `SalimBurakAytemiz/universal-ai-assurance-platform` (private)
- **RC version:** `0.9.0-rc.1` (root `package.json` + `package-lock.json`)
- **RC commit:** the merge commit of PR `audit/final-acceptance-rc` into `main` (the exact SHA is
  recorded in `.ai/FINAL_SYSTEM_ACCEPTANCE_REPORT.md` and on the `v0.9.0-rc.1` tag once the PR merges).
- **Frozen audit base:** `a80694299c0f292793e7efd46a16ff88e4e8dbe9`

## Repository artifacts (reproducible)
| Artifact | SHA-256 |
|----------|---------|
| `docs/release/v0.9.0-rc.1/SBOM.json` | `2d1b2405955e17c84cd4a7ba2f7143636fbd589a9d8df0128f0a22f9252f9c96` |
| `CHANGELOG.md` | `e5f624f454081b0845807fcc67f8b42071272f295fe115aae59fab1b7dff412a` |

> These two hashes cover the point-in-time content committed with this RC. Other tracked source files
> are integrity-anchored by the Git commit SHA above (recompute any file with
> `git hash-object` or `sha256sum`).

## Desktop package (dev / UNSIGNED)
Recorded in `.ai/PACKAGING_EVIDENCE.json`. Regenerate with `cd apps/desktop && npm run package:dir`.

| Field | Value |
|-------|-------|
| Artifact | `apps/desktop/dist/UAAP-win32-x64/UAAP.exe` (gitignored) |
| Kind | `DEV_UNSIGNED` (Electron 32.3.3, `@electron/packager`) |
| SHA-256 (recorded) | `ed17ab79df4cf7862b404c8221941bd63282df1d8a19d953c847f2f2a22fde06` |
| Signed | **false** — production code-signing is `DESKTOP_SIGNING_REQUIRED` (no certificate) |
| Startup smoke | exit 0; agentsTotal 72; securityLocked true (packaged binary renders real state) |

**This RC ships NO signed production binary.** Do not represent the dev/unsigned package as a signed
release.
