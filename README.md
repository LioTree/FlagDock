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

Then build the workspace image:

```bash
docker build -t flagdock-workspace .
```

The workspace image is the one FlagDock launches per challenge.

## Configuration

Copy the workspace config example:

```bash
cp flagdock.yaml.example flagdock.yaml
```

`flagdock.yaml` controls host binding and URLs printed by `attach`:

```yaml
workspace:
  bindHost: 0.0.0.0

attach:
  host: 192.168.0.214
```

For remote SSH/server usage, keep `workspace.bindHost` conservative and set `attach.host` to the host name or IP you open in your browser.

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

Agent and session prompts live in:

```text
prompts/agents/ctf.md
prompts/sessions/initial.md
prompts/sessions/continue.md
prompts/sessions/writeup.md
```

## Challenges

Put local test challenges under `challenges/`:

```text
challenges/<name>/
  challenge.md
  distfiles/
```

`flag.txt` is treated as the solve marker. If `flag.txt` exists and is non-empty, `challenge start --mode auto` skips workspace creation (use `--mode manual` to inspect solved challenges).

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
```

Create or control sessions:

```bash
node bin/flagdock.js session new <challenge> --mode auto
node bin/flagdock.js session new <challenge> --mode manual
node bin/flagdock.js mode set <challenge> --session <session_id> auto
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
| `auto` | The agent works autonomously. On start, it immediately receives the `initial` prompt. When each model turn stops, FlagDock checks for `flag.txt`; if the flag is still missing, it immediately sends a `continue` prompt. Once solved, it auto-generates a writeup. |
| `manual` | No automatic prompts are sent. You drive the agent yourself through the OpenCode web UI. Use this mode to inspect already-solved challenges (auto mode skips solved ones). |

Use `manual` mode when you want full control or need to poke at a finished challenge.

## Check

Run `node --check` (JavaScript syntax validation) across all source files:

```bash
npm test
```

## Acknowledgements

FlagDock's CTF agent prompt and Docker sandbox environment are adapted from [verialabs/ctf-agent](https://github.com/verialabs/ctf-agent), an autonomous CTF solver by Veria Labs. Thanks to Veria Labs for publishing the original prompt and sandbox work.
