# clef-guard

Replaces Claude Code's built-in **auto-mode safety classifier** with a
[clef](https://ollama.com/library/clef) decision model served by your own
Ollama instance.

In `auto` mode, Claude Code asks a hosted model classifier to approve or deny
tool calls that your permission rules don't already cover. clef-guard moves
that decision to a local, single-pass 27B decision model you host: tool calls
are judged by clef, verdicts carry probabilities, and every failure falls back
to the stock pipeline.

```
tool call → tool.check hook → rules allow/deny? → keep
                              ↘ ask + auto mode → clef verdict + harm check
                                                  → allow / deny / fall through
```

## How it works

- A `tool.check` hook passes rule-derived `allow`/`deny` verdicts through
  untouched and only intercepts `ask` verdicts while the session is in `auto`
  mode (mode is tracked from the engine's classic hooks).
- Each intercepted ask is one `POST /v1/systemone` call carrying:
  - a `choice` question — should this call run unattended? (`allow` / `deny` /
    `uncertain`)
  - a `noul` question — could running it cause serious harm?
- The state sent to clef is the tool name, its arguments (capped), the working
  directory, and the last few transcript messages. Untrusted content lands
  only in the `state` field; the questions are code constants.
- **Policy** (thresholds configurable):
  - **allow** — clef chooses `allow` with P ≥ 0.7 *and* P(harm) < 0.5
  - **deny** — clef chooses `deny` with P ≥ 0.7 *or* P(harm) ≥ 0.5
  - **otherwise `ask`** — the stock pipeline (built-in classifier or dialog)
    decides
- A `classic.PermissionRequest` backstop gives clef one more chance if a
  dialog is about to open in `auto` mode anyway.

Every failure — clef unreachable, malformed reply, below threshold — falls
back to the stock pipeline. The mod can never fail into allow-all; its worst
case is stock behavior.

## Install

Serve a decision model on Ollama (0.35.1+):

```
ollama pull clef
```

Then load the plugin by one of:

```sh
# per launch
claude --plugin-dir /path/to/clef-guard

# every session: in ~/.claude/settings.json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/clef-guard" } }
```

Point it at your Ollama host with `/config` → clef-guard → **Endpoint** (the
default is `http://localhost:11434/v1/systemone`).

## Use

- `/clef` — endpoint, mode, thresholds, last verdict, last error
- `/config` → clef-guard — thresholds, enforce, transport, mTLS, timeout

| Setting | Default | Meaning |
| --- | --- | --- |
| Endpoint | `http://localhost:11434/v1/systemone` | Ollama decision endpoint |
| Model | `clef` | model name passed to the endpoint |
| Transport | `curl` | `curl` shells out (mTLS capable, hard timeout); `http` uses the engine's fetch |
| Enforce | on | off = observe only: clef annotates the status line, never decides |
| Allow threshold | 0.7 | minimum P(allow) to allow |
| Deny threshold | 0.7 | minimum P(deny) to deny |
| Harm threshold | 0.5 | P(harm) that denies (and vetoes an allow) |
| Timeout (ms) | 8000 | how long clef gets before the stock pipeline takes over |

## Privacy and security

- **What leaves the machine:** each consult sends the tool call and a small
  conversation context to the endpoint you configure. Point it only at
  servers you trust; verdict reasons from that server are shown to the model
  and in dialogs.
- **Plaintext HTTP by default.** On an untrusted network, use the mTLS
  settings (CA / client cert / key, `curl` transport) or an SSH tunnel.
- **Trust shift.** This swaps Anthropic's hosted classifier for a local
  decision model. Tool input can carry prompt injection aimed at the judge;
  the dual-question policy, thresholds, and harm veto are the mitigations —
  tune them for your risk tolerance, or set **Enforce** off to shadow-run it
  first.
- **Fail-safe.** Rule-derived decisions always win; clef only decides
  uncovered asks in `auto` mode; any error falls back to the stock pipeline.

## Development

```sh
claude plugin validate .   # what the engine will refuse, before a session loads it
claude plugin test .       # 14 tests: decision policy + hook behavior
```

`hooks/register.ts` is the entry; the engine's scanner requires `$` to flow
only through same-file top-level functions, so the transport (`clefPost`) and
consult logic live there, while the pure decision policy (`lib/decide.ts`) and
request shapes (`lib/clef.ts`) stay `$`-free.

## License

[Apache-2.0](LICENSE)
