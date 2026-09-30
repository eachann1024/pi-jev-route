# Pi Jev Route


![Pi Jev Route — eligible subagent task → Jev selection → enabled model](https://raw.githubusercontent.com/eachann1024/pi-jev-route/main/web/assets/route-hero.png)

Route eligible Pi subagent tasks to a suitable model with Jev—without changing the main session’s model or thinking level.

```sh
pi install npm:pi-subagents@0.69.0
pi install npm:@each1024/pi-jev-route
```

Already using `pi-subagents`? Keep it; the extension uses its native launcher. Requires Node **22.18+** and Pi **0.85.1+**. After installation, run `/reload`. Routing is enabled by default. [简体中文](README.zh-CN.md)

https://github.com/user-attachments/assets/0d24fb0a-7fe9-46b9-b279-f0272d98c4f4

## Get started

On first use in an interactive local Pi session, the extension opens its English welcome page in your browser. Choose **Open settings** to review the available models and routing options. To open the welcome page again, run `/pi-jev-route-setting welcome`.

The `/pi-jev-route-setting` command opens the local settings and audit console. The first-run welcome flow also starts its loopback server to show the welcome page; installing the npm package alone does not open a browser. The server shuts down after inactivity and does not create a public listener or tunnel.



## How routing works

- The main session clarifies the request, investigates risks, delegates bounded work, makes key decisions, and summarizes results.
- Jev selects from configured `enabledModels` for eligible structured native Pi subagent calls. The existing subagent extension owns launching, parallelism, tools, permissions, budgets, and results.
- Independent tasks may run in parallel. Ordinary work generally prefers a lightweight model; styling uses the current main model with low thinking when allowed. The main model and thinking level never change.

The extension covers model-originated structured calls to a single native Pi subagent. It does not globally intercept workflow scripts, `/run`, schedules, other extensions’ direct delegation, or external CLI/job runners. Nested routing is not guaranteed. [Coverage and audit details](https://github.com/eachann1024/pi-jev-route/blob/main/docs/reference.md#coverage-and-audit).

## Local console

![Model controls and routing audit — feature overview](https://raw.githubusercontent.com/eachann1024/pi-jev-route/main/web/assets/route-control.png)

**Model controls and routing audit.** Choose allowed models and fallback policy; inspect selections and fallback events. Feature diagram, not a UI screenshot; audit does not prove task completion.

The console lists configured models and exposes routing, fallback, and audit settings. Choose English or Simplified Chinese at the top of the page. Edits save automatically, and “Saved” appears at the top right. Leaving the page does not ask for confirmation. Restoring defaults keeps the interface language and saves automatically; refreshing the audit log preserves edits that are still being saved. Conflicting edits require an explicit settings reload. It uses no external scripts, fonts, or assets. Remote or headless sessions do not automatically open a local browser.

## Privacy and credentials

Classification sends the child task, agent name, candidate model IDs/descriptions, and routing instructions to TypeSafe—not the main conversation, system prompt, tool results, or reasoning. It may incur separate charges. Credentials are reused from `TYPESAFE_API_KEY` or `~/.config/typesafe/api_key`; logs store a task hash, not task text or credentials. Keep secrets out of model descriptions. Full privacy details are in the [technical reference](https://github.com/eachann1024/pi-jev-route/blob/main/docs/reference.md#privacy-credentials-and-failures).

## Failures and audit

Each eligible dispatch makes at most one request, with a five-second default deadline and no retries. Missing credentials, timeouts, invalid responses, sensitive or oversized input, and low confidence use an allowed fallback; otherwise dispatch is blocked. Credential detection is not a complete secret scanner.

Async acceptance is not completion; audit records and run IDs do not independently prove execution or correctness. See [audit details and query commands](https://github.com/eachann1024/pi-jev-route/blob/main/docs/reference.md#coverage-and-audit).

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests use mocked classification and isolated temporary storage; they do not consume model credits. [Full technical reference](docs/reference.md)

MIT License.
