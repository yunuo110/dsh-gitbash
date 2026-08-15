# dsh-gitbash

English · [中文](./README.md)

A DeepSeek Harness (DSH) bundle plugin: **no new preset mode, no extra tool**. On Windows it points DSH's existing `bash` tool at Git for Windows Bash, hides/disables `pwsh`, and lets the model naturally use Git Bash.

Inspired by Reasonix's approach.

## Design Goals

- **Not a preset mode**: no new mode to select; existing mode names stay unchanged.
- **Not an extra tool**: it does not register a `gitbash` tool; the model still sees DSH's native `bash` tool.
- **Git Bash by default**: on Windows the `bash` tool runs `Git\bin\bash.exe -lc <command>`.
- **PowerShell hidden**: `pwsh` is removed from the prompt and rejected by a guard even if a stale catalog tries to call it.
- **Dynamic description**: the `bash` tool description is rewritten with Git Bash/MSYS2 rules so the model writes bash syntax.
- **Windows-only**: the plugin no-ops on non-Windows and leaves native bash untouched.

## Project Structure

```text
dsh-gitbash/
├── package.json
├── cordis.patch.yml        # inserts dsh-gitbash, disables pwsh, enables bash
├── lib/
│   ├── index.js            # shell provider + prompt rewrite + guard
│   └── gitbash-core.mjs    # pure helpers: path detection/argv/render/validation
└── test/
    └── gitbash-core.test.mjs
```

## Install (web profile)

Run from the plugin repository root. If you cloned from GitHub, enter the cloned directory first:

```powershell
cd dsh-gitbash
```

### Option A: `dsh` is already on PATH

```powershell
dsh plugin --profile web add .
```

### Option B: you normally start DSH with `npx @deepseek-ai/dsh web`

Many people do not have `dsh` globally installed. If you start DSH like this:

```powershell
npx @deepseek-ai/dsh web
```

then install the plugin through `npx` too:

```powershell
npx @deepseek-ai/dsh plugin --profile web add .
```

Note: run this from the plugin repository root, because `add .` uses the current directory.

If you want to use the `dsh` command directly in the future, install DSH globally:

```powershell
npm install -g @deepseek-ai/dsh
```

Then you can use:

```powershell
dsh plugin --profile web add .
```

### After installing

The install will:

1. Add `dsh-gitbash` as a bundle to `~/.dsh/profiles/web`;
2. Provide a Git Bash `shell` executor on Windows;
3. Re-enable the host-level `tool-bash`;
4. Disable `pwsh-sandbox` / `tool-pwsh`.

Then **fully restart DSH**. Both new and old conversations will use the same `bash` tool, which actually executes Git Bash.

### GitHub install (recommended)

If you don't want to depend on a local source directory, install directly from GitHub:

```powershell
dsh plugin --profile web add github:yunuo110/dsh-gitbash
```

If you previously installed a local version, remove it first:

```powershell
dsh plugin --profile web remove dsh-gitbash
dsh plugin --profile web add github:yunuo110/dsh-gitbash
```

It is recommended to pin a version so future repository changes do not silently affect you (current latest tag: `v0.1.0`):

```powershell
dsh plugin --profile web add github:yunuo110/dsh-gitbash#v0.1.0
```

This keeps a GitHub dependency in the profile instead of a local `link` dependency, so DSH updates will not wipe it.

## Usage

- Ask the model to run shell/git commands in a new or old conversation, e.g. "check git status" or "run npm test".
- The model sees the `bash` tool, and its description says it runs Git Bash.
- On Windows the model does not see `pwsh`; even if a stale cache tries `pwsh`, it is rejected and told to use `bash`.
- If the current session sandbox is not full access, the first call may fail with an escalation hint. Have the model use:
  ```json
  {
    "command": "git status",
    "description": "Check git status",
    "sandbox_permissions": "danger-full-access",
    "justification": "Git Bash cannot start in the restricted sandbox; full access is required to run git status."
  }
  ```
  Or switch the session permission to **full access** in settings.

## Configuration

By default Git Bash is auto-detected from: `GIT_BASH` env var → Program Files / Program Files (x86) / ProgramW6432 / LocalAppData / Scoop → PATH (excluding the System32 WSL bash).

To pin a path, override the plugin row in the profile's `cordis.patch.yml` (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: dsh-gitbash
  config:
    shellPath: 'C:\Program Files\Git\bin\bash.exe'
    timeoutMs: 120000
    maxTimeoutMs: 600000
    maxOutputBytes: 64000
    maxSpillBytes: 67108864
    graceMs: 3000
```

| Field | Default | Description |
| --- | --- | --- |
| `shellPath` | auto-detected | Pin the Git Bash path |
| `timeoutMs` | 120000 | Default per-command timeout |
| `maxTimeoutMs` | 600000 | Maximum timeout |
| `maxOutputBytes` | 64000 | stdout bytes kept in memory; overflow spills to a file |
| `maxSpillBytes` | 67108864 | Spill file cap |
| `graceMs` | 3000 | SIGTERM → SIGKILL grace period |

## Tool Behavior

- Each call is a fresh non-interactive `bash.exe -lc`: **no `cd` / `export` / alias state persists**.
- Use POSIX/bash syntax: `$VAR`, `export`, `ls`, `grep`, `find`, `sed`, `awk`, pipes, `&&`/`||`, command substitution.
- Paths: prefer `/d/WorkSpace` or `C:/WorkSpace`; avoid raw backslashes unless quoted.
- Environment variables: `$VAR` / `${VAR}`, not PowerShell's `$env:VAR`.
- Supports DSH's native `bash` tool parameters: `workdir`, `timeoutMs`, `run_in_background`, `sandbox_permissions` + `justification`.

## Token Comparison

Only compares the original DSH configuration with this plugin:

| Configuration | Visible shell tool | Extra system prompt | Per-turn token impact |
| --- | --- | --- | --- |
| Original DSH (Windows) | `pwsh` | none | baseline |
| This plugin | `bash` (actually Git Bash) | none | roughly the same (replaces the `pwsh` schema with the `bash` schema; no extra tool) |

## Tests

```powershell
npm run check
```

Current tests cover: Git Bash path detection, argv construction, environment merging, argument validation, timeout clamping, workdir resolution, result rendering, config validation, and shell tool filtering.

## Compatibility

- DeepSeek Harness `0.1.0-rc.6`
- Windows + Git for Windows (MSYS2)
- Node.js 22.19+

## Note

This tool was entirely made by DSH.
