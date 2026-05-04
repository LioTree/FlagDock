# FlagDock

FlagDock is a local Docker-based workspace manager for solving CTF challenges with OpenCode and Codex.

It scans `challenges/`, starts one workspace container per challenge/backend, and syncs final outputs back into the source challenge directory.

## Requirements

- Node.js 22+
- Docker
- Optional OpenCode config under `.local/opencode/`
- Optional Codex config under `.local/codex/`

## Quick Start

Install dependencies and copy the workspace config:

```bash
npm install
cp flagdock.yaml.example flagdock.yaml
```

Prepare config directories:

```bash
mkdir -p .local/opencode .local/codex
```

Copy the example configs you want to use:

```bash
cp config_examples/opencode/opencode.json.example .local/opencode/opencode.json
cp config_examples/codex/config.toml.example .local/codex/config.toml
cp config_examples/codex/env.example .local/codex/env
```

Start the manager and launch a challenge:

```bash
node bin/flagdock.js start
node bin/flagdock.js challenge start <challenge> --mode auto
node bin/flagdock.js attach <challenge>
```

First run may take a while because FlagDock builds missing Docker images automatically.

## Configuration

`flagdock.yaml` controls network binding and which backend(s) to start:

```yaml
workspace:
  bindHost: 0.0.0.0

attach:
  host: 192.168.0.214

backend:
  mode: opencode
```

- `workspace.bindHost`: bind address for published container ports
- `attach.host`: host/IP shown by `flagdock attach`
- `backend.mode`: `opencode`, `codex`, or `race`

Provider config files:

```text
.local/opencode/opencode.json
.local/opencode/auth.json
.local/codex/config.toml
.local/codex/env
```

Example files live in `config_examples/`:

- `config_examples/opencode/opencode.json.example`
- `config_examples/codex/config.toml.example`
- `config_examples/codex/env.example`

`auth.json` is intentionally not included as an example. Copy it from an existing OpenCode setup, or generate it by logging into OpenCode first and then placing the resulting file at `.local/opencode/auth.json`.

## Challenge Layout

Each challenge must live under `challenges/` and include `challenge.md`:

```text
challenges/<name>/
  challenge.md
  distfiles/
  opencode_solution/
    flag.txt
    wp.md
  codex_solution/
    flag.txt
    wp.md
```

Runtime copies live under `.flagdock/workspaces/<challenge>/<backend>/challenge/`. Only final outputs are synced back to the source tree:

- `opencode_solution/flag.txt`
- `opencode_solution/wp.md`
- `codex_solution/flag.txt`
- `codex_solution/wp.md`

## Common Commands

```bash
node bin/flagdock.js status
node bin/flagdock.js challenges
node bin/flagdock.js sessions <challenge>
node bin/flagdock.js challenge start <challenge> --mode auto
node bin/flagdock.js challenge start <challenge> --mode manual
node bin/flagdock.js attach <challenge> --backend opencode
node bin/flagdock.js attach <challenge> --backend codex
node bin/flagdock.js stop
```

## Modes

- `auto`: start solving immediately, continue until a flag is found, then generate a writeup
- `manual`: create the workspace but do not drive the agent

## Notes

- If a backend already has a non-empty `flag.txt`, `challenge start --mode auto` skips it
- `race` starts both backends; use `--backend` for commands like `attach`, `sessions`, and `session new`

## Check

```bash
npm test
```

## Acknowledgements

FlagDock's CTF agent prompt and sandbox environment are adapted from [verialabs/ctf-agent](https://github.com/verialabs/ctf-agent).
