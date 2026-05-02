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

`flag.txt` is treated as the solve marker. If `flag.txt` exists and is non-empty, auto start is skipped for that challenge.

`challenges/` is ignored by git.

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

## Check

Run `node --check` (JavaScript syntax validation) across all source files:

```bash
npm test
```

## Acknowledgements

FlagDock's CTF agent prompt and Docker sandbox environment are adapted from [verialabs/ctf-agent](https://github.com/verialabs/ctf-agent), an autonomous CTF solver by Veria Labs. Thanks to Veria Labs for publishing the original prompt and sandbox work.
