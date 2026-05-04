# FlagDock

FlagDock is a local CTF solving workspace manager built around Docker and OpenCode.

It scans local challenge directories, starts one Docker workspace per challenge, creates or discovers OpenCode sessions, and can automatically drive sessions until a flag is found.

## Requirements

- Node.js 22+
- Docker
- An OpenCode provider configuration

Install dependencies:

```bash
npm install
```

## Docker Setup

Build the sandbox base image first (includes a full CTF toolchain — this takes a while, but only needs to be done once):

```bash
docker build -f sandbox/Dockerfile.sandbox -t flagdock-sandbox-base:latest .
```

Then build the OpenCode workspace image:

```bash
docker build -f Dockerfile.opencode -t flagdock-opencode:latest .
```

Then build the Codex workspace image:

```bash
docker build -f Dockerfile.codex -t flagdock-codex:latest .
```

These are the images FlagDock launches per challenge.

## Configuration

Copy the workspace config example:

```bash
cp flagdock.yaml.example flagdock.yaml
```

`flagdock.yaml` controls host binding, attach URLs, and which backend(s) run for each challenge:

```yaml
workspace:
  bindHost: 0.0.0.0

attach:
  host: 192.168.0.214

backend:
  mode: opencode
```

For remote SSH/server usage, keep `workspace.bindHost` conservative and set `attach.host` to the host name or IP you open in your browser.

`backend.mode` supports:

- `opencode`: only OpenCode workspaces
- `codex`: only Codex workspaces
- `race`: run both backends in parallel

Put private OpenCode credentials under `.local/opencode/`:

```bash
mkdir -p .local/opencode
```

```text
.local/opencode/opencode.json
.local/opencode/auth.json
```

They are mounted into containers as:

```text
/root/.config/opencode/opencode.json
/root/.local/share/opencode/auth.json
```

If `OPENCODE_CONFIG_CONTENT` is set when the manager starts, FlagDock passes it through to newly created workspace containers. This does not disable the `.local/opencode/` file mounts; if both are present, OpenCode's own config resolution decides precedence.

Put Codex API configuration under `.local/codex/`:

```text
.local/codex/config.toml
.local/codex/env
```

`config.toml` configures the Codex model provider. `env` is passed to Codex containers as Docker `--env-file` and should contain `OPENAI_API_KEY=...`. Codex containers mount a per-challenge writable `CODEX_HOME` under `.flagdock/workspaces/`, while `config.toml` is mounted read-only.

Prompt sources live in:

```text
prompts/common/ctf.md
prompts/sessions/initial.md
prompts/sessions/continue.md
prompts/sessions/writeup.md
```

FlagDock renders backend-specific wrappers from `prompts/common/ctf.md` into:

```text
.flagdock/runtime/agent/ctf.md
.flagdock/runtime/codex/AGENTS.md
```

OpenCode uses the generated `ctf.md` agent file. Codex uses the generated project-level `AGENTS.md`, so its thread startup picks up the same CTF instructions through Codex's native instruction discovery.

## Challenges

Put local test challenges under `challenges/`:

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

`challenges/<name>` is the source challenge directory. Runtime workspaces are copied under `.flagdock/workspaces/<name>/<backend>/challenge/` and mounted into containers as `/challenge`.

Each backend syncs only final artifacts back into the source tree:

- `opencode_solution/flag.txt`, `opencode_solution/wp.md`
- `codex_solution/flag.txt`, `codex_solution/wp.md`

If any backend solution directory already has a non-empty `flag.txt`, `challenge start --mode auto` skips workspace creation (use `--mode manual` to inspect solved challenges).

## CLI

Start or stop the manager:

```bash
node bin/flagdock.js start
node bin/flagdock.js stop
```

Inspect state:

```bash
node bin/flagdock.js status
node bin/flagdock.js challenges
node bin/flagdock.js sessions <challenge>
```

Start a challenge workspace:

```bash
node bin/flagdock.js challenge start <challenge> --mode auto
node bin/flagdock.js challenge start <challenge> --mode manual
```

Attach to an OpenCode session:

```bash
node bin/flagdock.js attach <challenge>
node bin/flagdock.js attach <challenge> --session <session_id>
node bin/flagdock.js attach <challenge> --backend opencode
node bin/flagdock.js attach <challenge> --backend codex
```

Create or control sessions:

```bash
node bin/flagdock.js session new <challenge> --mode auto
node bin/flagdock.js session new <challenge> --mode manual
node bin/flagdock.js session new <challenge> --backend codex --mode manual
node bin/flagdock.js mode set <challenge> --session <session_id> auto
node bin/flagdock.js mode set <challenge> --backend codex --session <session_id> manual
node bin/flagdock.js mode set <challenge> --session <session_id> manual
```

Manage workspaces:

```bash
node bin/flagdock.js workspace stop <challenge>
node bin/flagdock.js workspace rm <challenge>
node bin/flagdock.js workspace stop-all
node bin/flagdock.js workspace rm-all
```

## Modes

The `--mode` flag (default: `auto`) controls how the AI agent operates:

| Mode | Behavior |
|------|----------|
| `auto` | The agent works autonomously. On start, it immediately receives the `initial` prompt. When each model turn stops, FlagDock checks backend solution outputs; if the flag is still missing, it immediately sends a `continue` prompt. Once solved, it auto-generates a writeup. |
| `manual` | No automatic prompts are sent. You drive the agent yourself through the OpenCode web UI. Use this mode to inspect already-solved challenges (auto mode skips solved ones). |

Use `manual` mode when you want full control or need to poke at a finished challenge.

## Check

Run `node --check` (JavaScript syntax validation) across all source files:

```bash
npm test
```

## Acknowledgements

FlagDock's CTF agent prompt and Docker sandbox environment are adapted from [verialabs/ctf-agent](https://github.com/verialabs/ctf-agent), an autonomous CTF solver by Veria Labs. Thanks to Veria Labs for publishing the original prompt and sandbox work.
