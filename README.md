# FlagDock

FlagDock is a local Docker-based workspace manager for solving CTF challenges with OpenCode and Codex.

It scans a configurable challenge root directory, starts one workspace container per challenge/backend, and syncs final outputs back into the source challenge directory.

## Requirements

- Node.js 22+
- Docker
- Optional OpenCode or Codex credentials/config if you want to use those backends

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
  challengesDir: ./challenges

attach:
  host: 192.168.0.214

backend:
  mode: opencode
```

- `workspace.bindHost`: bind address for published container ports
- `workspace.challengesDir`: challenge root directory, relative to the repo root or an absolute path
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

## Concepts

- A `challenge` is the source problem directory. It contains the prompt (`challenge.md`) and any distributed files.
- A `workspace` is the disposable runtime environment created from a challenge for one backend. It includes the live container, agent sessions, and a working copy of the challenge files.
- `challenge` commands act on the challenge lifecycle and its persisted solution state.
- `workspace` commands act only on runtime state. They stop or delete the live working environment without deleting saved outputs.

## Challenge Layout

Each challenge must live under `workspace.challengesDir` (default `challenges/`) and include `challenge.md`:

```text
challenges/<name>/
  challenge.md
  distfiles/
```

FlagDock keeps two kinds of internal state under `.flagdock/`:

```text
.flagdock/
  solutions/
    <challenge>-<scope>/
      opencode/
        flag.txt
        wp.md
      codex/
        flag.txt
        wp.md
  workspaces/
    <challenge>/
      <backend>/
        challenge/
```

- Runtime workspace copies live under `.flagdock/workspaces/<challenge>/<backend>/challenge/`.
- Canonical solution outputs live under `.flagdock/solutions/<challenge>-<scope>/<backend>/`, where `<scope>` is derived from the resolved challenge directory.

## Common Commands

```bash
node bin/flagdock.js status
node bin/flagdock.js challenges
node bin/flagdock.js sessions <challenge>
node bin/flagdock.js challenge start <challenge> --mode auto
node bin/flagdock.js challenge start <challenge> --mode manual
node bin/flagdock.js challenge start --all --mode manual
node bin/flagdock.js challenge reset <challenge>
node bin/flagdock.js challenge reset --all
node bin/flagdock.js workspace stop <challenge>
node bin/flagdock.js workspace stop --all
node bin/flagdock.js workspace stop --solved
node bin/flagdock.js workspace clear <challenge>
node bin/flagdock.js workspace clear --all
node bin/flagdock.js workspace clear --solved
node bin/flagdock.js attach
node bin/flagdock.js attach <challenge>
node bin/flagdock.js attach <challenge> --backend opencode
node bin/flagdock.js attach <challenge> --backend codex
node bin/flagdock.js stop
```

- Use `challenge start` to create or resume a workspace from a challenge and optionally start solving.
- Use `challenge start --all` to batch-start every challenge currently in `available` state.
- Use `workspace stop` to keep the current workspace state but stop its containers.
- Use `workspace clear` to discard the runtime workspace while keeping saved outputs such as `flag.txt` and `wp.md`.
- Add `--solved` to `workspace stop` or `workspace clear` to apply that action only to solved workspaces.
- Use `challenge reset` to return a challenge to a clean `available` state.
- Use `attach` without a backend to print a table of available OpenCode URLs and Codex tmux commands.

## Modes

- `auto`: start solving immediately, continue until a flag is found, then generate a writeup
- `manual`: create the workspace but do not drive the agent

## Notes

- If a backend already has a non-empty `flag.txt`, `challenge start --mode auto` skips it
- `race` starts both backends; use `--backend` for commands like `attach`, `sessions`, and `session new`

## Acknowledgements

FlagDock's CTF agent prompt and sandbox environment are adapted from [verialabs/ctf-agent](https://github.com/verialabs/ctf-agent).
