# Technical reference

This document contains detailed behavior and operational notes for the npm package. For the short overview, see the [README](../README.md) in the repository.

## Requirements and installation

Requires Node.js 22.18+ and Pi 0.85.1+. The extension uses Pi's native TypeScript loader and Node built-ins; there are no additional runtime dependencies. Install `pi-subagents` if it is not already installed, then install this package and run `/reload` in Pi:

```sh
pi install npm:pi-subagents@0.69.0
pi install npm:@each1024/pi-jev-route-setting
```

Routing is enabled by default. The first local interactive session displays the English welcome page and starts the local console server for its settings link. `/pi-jev-route-setting welcome` opens that welcome page again. `/pi-jev-route-setting` opens the settings and audit console directly. Installing the package does not itself open a browser.

## Routing behavior

The main session should clarify the request, investigate risks, define complete bounded work, coordinate delegation, make key decisions, and summarize results. The extension routes eligible structured native Pi calls of the form `subagent({agent, task})`; omit the per-call `model` to allow selection. It first relies on `subagent({action:"list", capabilities:true})` to discover available agent capabilities.

Jev selects a model from `settings.json` `enabledModels`, using configured model descriptions and routing instructions. Independent work can be dispatched in parallel. Ordinary work generally prefers a lightweight configured model. Styling uses the current main model with low thinking when that model is enabled in the allowed scope. Models that do not support reasoning use `off`.

Explicit per-run or agent-profile model pins are kept only when they resolve to an allowed `enabledModels` entry. Out-of-list model names—including other providers and the plugin name `pi-jev-route`—are ignored and Jev selects from the allowed list. The extension writes a validated `provider/model:thinking` override immediately before execution. The existing subagent extension continues to own launching, parallelism, tools, permissions, budgets, and results. The main session's model and thinking level are never changed, and routing grants no additional permissions.

## First-run welcome and local console

On the first use in a local interactive Pi session, the extension presents an English welcome page with an **Open settings** action. `/pi-jev-route-setting welcome` reopens it. The welcome flow starts the loopback console server to serve the page; the server is not started merely by installing the npm package. `/pi-jev-route-setting` opens settings and logs.

The console lists every `settings.json` `enabledModels` entry and autosaves changes. It supports Chinese and English; later log text follows the selected language. It includes fallback model, styling policy, and advanced routing options. There is no notes field. Descriptions for temporarily unavailable models are retained. A settings change during classification blocks that attempt. Concurrent settings edits are rejected rather than silently overwritten.

The server binds to `127.0.0.1`, uses a token-protected page, and closes after five idle minutes or a session transition. It loads no external scripts, fonts, or assets. On remote/headless Pi, opening HTML requires a local interactive session; no public listener or tunnel is created.

### Commands

```text
/pi-jev-route-setting          Open settings and logs
/pi-jev-route-setting welcome  Reopen the welcome page
/pi-jev-route-setting last     Show the newest persistent audit record
/pi-jev-route-setting log <id-or-unique-prefix>  Show one unambiguous audit record
/pi-jev-route-setting status   Show enabled state and coverage
/pi-jev-route-setting on       Enable child routing
/pi-jev-route-setting off      Disable child routing; keep current models
```

## Coverage and audit

**Covered:** model-originated, structured single-native-Pi-child `subagent` calls, including `async:true`, after agent capability discovery.

**Not intercepted:** workflow scripts/templates and their inner `runs.run/all`, `/run`, schedules, other extensions' direct RPC/delegation, and external CLI/job runners. Nested routing depends on whether the child loads this extension and is not guaranteed. Unsupported model-facing workflow/remote dispatch calls are logged as skipped and left unchanged; direct `/run` and other bypasses do not produce a routing log. This is not a global launch-policy enforcement layer.

The public capability-list response is cached for the current session. Refresh it after changing agent definitions externally. In-session create/update/delete results invalidate the cache. An unknown native/external runner is not guessed: the launch is blocked with instructions to list capabilities first. This discovery check cannot prevent a trusted agent configuration from changing after listing.

The terminal audit mark shows a short reason, requested model, and audit ID; it does not imply execution. Compatible structured fields include a reason code, routing duration, candidate IDs, fallback source, and limited rule snapshot. Transport failures are distinguished without storing raw errors, response bodies, task text, or credentials. `last` and `log` query durable SQLite records; ambiguous prefixes are rejected.

Async acceptance is recorded as **accepted**, not completion. Foreground executor configuration is reported only when supplied in the tool result. There is no background polling or invented completion evidence. Returned async/run identifiers do not confirm completion or the actual model. The original subagent result is preserved and receives an appended model-visible receipt with route ID, requested/reported model, outcome, execution evidence state, and query command. The read-only `jev_route_history` tool lists recent records for the current session or fetches one by ID; `allSessions` explicitly opts into cross-session search. It does not store task or result text. `last` shows the newest persistent record across sessions; `log` retrieves one exact ID or unambiguous literal prefix. Exit code zero is evidence of tool-reported execution completion, not independent verification of the work.

## Privacy, credentials, and failures

The extension calls TypeSafe directly and reuses the existing credential source:

1. `TYPESAFE_API_KEY`
2. `~/.config/typesafe/api_key`

No Gateway account or new credential file is needed. Keys are never returned to the HTML page or stored in logs. Keep the key file private (for example, mode `600`).

Classification sends the child task, agent name, candidate model IDs/descriptions, and routing instructions to TypeSafe. It does not send the main conversation, system prompt, tool results, or reasoning. Classification is separately billed. Obvious credential-like inputs are skipped; this lexical check is not a complete privacy or secret scanner. Oversized tasks/requests are skipped, not silently truncated.

No classification occurs for ordinary main-session turns, management calls, in-list explicit model pins, or recognized external runners. Each eligible dispatch makes at most one request; the default deadline is five seconds and there are no retries. Timeout, missing credentials, malformed responses, sensitive input, or low confidence fall back to the configured allowed model, an allowed `low` alias, or the allowed main model, in that order. With no safe fallback, dispatch is blocked. A human-first decision blocks dispatch. Low classification confidence is not a measured probability that coding will succeed.

Settings and audit records live in `jev-route.sqlite` under Pi's agent directory, honoring `PI_CODING_AGENT_DIR`, using owner-only permissions. Logs retain a task hash, not task text or the raw classifier response. Notes and model descriptions are user-authored local data; do not put credentials in them. No automatic log deletion is performed. On Node 22, the built-in SQLite module may emit an experimental warning.

## Development and migration

This package replaces the earlier local experiment that offered main-session `auto`/`shadow` routing. Remove that old extension from Pi's discovery directory before installing this package; do not load both under `/pi-jev-route-setting`. It does not replace or modify Pi Jev Reply, which independently reviews completed replies.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Checks use mocked classification and isolated temporary storage; they do not consume model credits. `npm run check` runs TypeScript without emitting files. The package contains TypeScript source for Pi's native extension loader and plain HTML.
