# Pi Jev Route

Automatic **subagent** model selection for Pi, with an on-demand local HTML console. The main session's model and thinking level are never changed.

```sh
pi install npm:pi-subagents@0.69.0
pi install npm:@each1024/pi-jev-route
```

Already using `pi-subagents`? Keep your installation. Tested with Pi **0.85.1**, pi-subagents **0.69.0**, and Node **22.22.3**. Requires Node **22.18+**. Run `/reload`. Routing is on by default; the session shows a `pi-jev-route` mark when it selects a model. Open `/pi-jev-route` only for settings and logs. [中文说明](README.zh-CN.md)

## How it works

1. The main agent clarifies the task, investigates risks, and supplies a bounded task contract.
2. It discovers agent capabilities using `subagent({action:"list", capabilities:true})`.
3. For a structured native Pi `subagent({agent, task})` call, Jev selects a model from the **current Pi scope** using your model descriptions. Omit the per-run `model` to allow routing.
4. The extension writes a validated `provider/model:thinking` override immediately before execution. The existing subagent extension still owns launching, parallelism, tools, permissions, budgets, and results.

Independent work should be dispatched in parallel to save time. Ordinary work prefers a configured lightweight model. Styling uses the current main model with low thinking, provided that model is enabled in the allowed scope. Non-reasoning models use `off`. Explicit per-run and agent-profile model pins are retained.

The agent receives concise coordination guidance, not a replacement launcher. Nothing creates extra agents merely to increase their count. Acceptance defaults to compilation unless the task explicitly requires additional checks.

## Local HTML console

`/pi-jev-route` opens a loopback-only, token-protected settings page. Settings start collapsed:

- Automatically discovered scoped models with search; an empty Pi scope means all authenticated available models.
- Per-model enablement and editable descriptions used in Jev's decision. Empty descriptions are prefilled for common lightweight (flash) and strong (gpt 6, grok, opus, …) families; the field placeholder shows how to write them.
- A fallback model, styling policy, confidence threshold, timeout, and additional routing instructions.
- Decision logs and editable notes. Logs distinguish the **routing decision**, **executor-reported launch configuration**, and **reported execution state**. They do not claim to verify the provider's actual response model.

Descriptions for temporarily unavailable or out-of-scope models are retained. A scope or settings change during classification blocks that attempt instead of applying an obsolete decision. Concurrent settings or note edits are rejected rather than silently overwritten.

```text
/pi-jev-route          Open HTML settings and logs
/pi-jev-route status   Show enabled state and coverage
/pi-jev-route on       Enable child routing
/pi-jev-route off      Disable child routing; keep all current models
```

The server is started only on demand, binds to `127.0.0.1`, and closes after five idle minutes or a session transition. No external scripts, fonts, or assets are loaded. On remote/headless Pi, the HTML command must be opened in a local interactive session; no public listener or tunnel is created.

## Coverage — important

**Covered:** model-originated, structured single-native-Pi-child `subagent` calls, including `async:true`, after the agent capability list has identified the runner.

**Not intercepted:** workflow scripts/templates and their inner `runs.run/all`, `/run`, schedules, other extensions' direct RPC/delegation, and external CLI/job runners. Nested routing depends on whether the child loads this extension and is **not guaranteed**. Unsupported model-facing workflow/remote dispatch calls are logged as skipped and left unchanged; direct `/run` and other bypasses do not produce a routing log. This is not a global launch-policy enforcement layer.

The public capability-list response is cached for the current session. Refresh it after changing agent definitions externally. In-session create/update/delete results invalidate the cache. An unknown native/external runner is not guessed: the launch is blocked with instructions to list capabilities first. This discovery check cannot prevent a trusted agent configuration from changing after listing.

## Credentials, privacy, and failures

Jev uses TypeSafe directly. The existing credential source is reused:

1. `TYPESAFE_API_KEY`
2. `~/.config/typesafe/api_key`

No Gateway account or new credential file is needed. Keys are never returned to the HTML page or stored in logs. Keep the key file private, for example mode `600`.

Classification sends the **child task, agent name, candidate model IDs/descriptions, and your routing instructions** to TypeSafe. It does not send the main conversation, system prompt, tool results, or reasoning. Classification is separately billed. Obvious credential-like inputs are skipped; this lexical check is **not** a complete privacy or secret scanner. Oversized tasks/requests are skipped, not silently truncated.

No classification occurs for ordinary main-session turns, management calls, explicit model pins, or recognized external runners. Each eligible dispatch makes at most one request; the default deadline is five seconds and there are no retries. Timeout, missing credentials, malformed responses, sensitive input, or low confidence fall back to the configured allowed model, an allowed `low` alias, or the allowed main model, in that order. With no safe fallback, dispatch is blocked. A human-first decision blocks dispatch. A low classification confidence is not a measured probability that coding will succeed.

Settings and audit records live in `jev-route.sqlite` under Pi's agent directory, honoring `PI_CODING_AGENT_DIR`, using owner-only permissions. Logs retain a task hash, not task text or the raw classifier response. Notes and model descriptions are user-authored local data; do not put credentials in them. No automatic log deletion is performed. On Node 22, the built-in SQLite module may emit an experimental warning.

Async acceptance is recorded as **accepted**, not completion. Foreground executor configuration is reported only when supplied in the tool result. There is no background polling or invented completion evidence.

## Migration and development

This package replaces the earlier local experiment that offered main-session `auto`/`shadow` routing. Remove that old extension from Pi's discovery directory before installing this package; do not load both under `/pi-jev-route`. It does not replace or modify Pi Jev Reply, which independently reviews completed replies.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Checks use mocked classification and isolated temporary storage; they do not consume model credits. The package contains TypeScript source for Pi's native extension loader and plain HTML, with no additional runtime dependencies beyond the Pi host.

MIT.
