// Opt-in live acceptance. Uses real medium/high Pi sessions and real Jev requests.
// Fault-injection regression evidence remains separate from these live model runs.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { openStore } from '../lib/store.ts';
const group = process.argv[2];
assert(['normal', 'recovery', 'correction'].includes(group), 'Choose normal, recovery or correction');
const sdkPath = process.env.PI_SDK_PATH;
assert(sdkPath, 'Set PI_SDK_PATH to the installed Pi dist/index.js');
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(sdkPath).href);
const root = mkdtempSync(join(tmpdir(), `jev-live-${group}-`));
const agentDir = join(root, 'agent'), cwd = join(root, 'work'), sessions = join(root, 'sessions');
for (const p of [agentDir, cwd, sessions]) mkdirSync(p, { recursive: true });
const originalAgent = join(homedir(), '.pi/agent');
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = '1';
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ enabledModels: ['magpie/group/medium'], defaultProvider: 'magpie', defaultModel: 'group/medium', defaultThinkingLevel: 'high' }));
writeFileSync(join(cwd, 'marker.txt'), 'Acceptance marker: Goose supervision.\n');
const db = openStore(join(agentDir, 'jev-route.sqlite'));
db.saveSettings({ ...db.getSettings(), enabled: false, supervision: { ...db.getSettings().supervision, enabled: true, mode: 'recover', monitorChildren: false, pollMs: 1000, reviewIntervalMs: 1000, reviewEveryTools: 1, maxChecksPerTask: 4, decisionTimeoutMs: 15000 } });
const plugin = new URL('../index.ts', import.meta.url).pathname;
const hashes = Object.fromEntries(['index.ts', 'lib/supervision-runtime.ts', 'lib/supervision-policy.ts', 'lib/supervision-judge.ts'].map(p => [p, createHash('sha256').update(readFileSync(new URL('../' + p, import.meta.url))).digest('hex')]));
const errors = [], toolEvents = []; let session, extensionContext;
const deadline = setTimeout(() => { void session?.abort(); }, 90000);
try {
  const modelRuntime = await ModelRuntime.create({ authPath: join(originalAgent, 'auth.json'), modelsPath: join(originalAgent, 'models.json'), refreshOnCreate: false });
  const model = (await modelRuntime.getAvailable()).find(m => m.provider === 'magpie' && m.id === 'group/medium');
  assert(model?.reasoning, 'medium model with thinking must be available');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [plugin], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      pi.on('session_start', (_, ctx) => { extensionContext = ctx; });
      // Pause between tool completion and the next model request, not inside an active tool.
      pi.on('tool_execution_end', async e => { toolEvents.push({ tool: e.toolName, error: e.isError }); await new Promise(resolve => setTimeout(resolve, 4000)); });
    }],
  });
  await loader.reload(); assert.equal(loader.getExtensions().errors.length, 0);
  ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel: 'high', resourceLoader: loader, sessionManager: SessionManager.create(cwd, sessions), settingsManager, tools: ['read'] }));
  await session.bindExtensions({ onError: e => errors.push(String(e)) });
  const sessionId = session.sessionManager.getSessionId();
  assert.equal(db.getSettings().supervision.enabled, true);
  assert.equal(db.getSettings().supervision.mode, 'recover');
  console.log(JSON.stringify({ phase: 'started', group, root, sessionId, model: `${session.model.provider}/${session.model.id}`, thinking: session.thinkingLevel, supervision: 'enabled' }));
  await session.prompt('Read marker.txt exactly once using the read tool. Then respond with its acceptance marker text. This is a bounded read-only verification; do not call other tools or change files.');
  const tasks = db.getSupervisionTasks(sessionId), events = db.getSupervisionEvents(sessionId);
  assert(toolEvents.some(e => e.tool === 'read' && !e.error), 'real read tool completed');
  assert(tasks.some(t => t.checks > 0), 'production supervision ran a check while enabled');
  assert(events.some(e => e.reasonCode === 'jev_judgment'), 'real Jev response was parsed');
  assert(!events.some(e => e.kind === 'action'), 'aligned normal work was not interrupted');
  assert.equal(errors.length, 0);
  const report = { group, sessionId, model: `${session.model.provider}/${session.model.id}`, thinking: session.thinkingLevel, root, hashes, live: 'real Pi read + enabled production supervision + real Jev judgment', tasks, events, errors, limitations: group === 'normal' ? [] : ['This live model run establishes enabled integration only. Recovery/correction faults are separately injected in supervision-runtime.mjs; no real child recovery or replacement is claimed.'] };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase: 'passed', group, root, sessionId, checks: tasks.reduce((n,t) => n+t.checks, 0), report: join(root, 'report.json') }));
} catch (error) {
  writeFileSync(join(root, 'failure.json'), JSON.stringify({ group, hashes, error: String(error), errors }, null, 2));
  console.error(JSON.stringify({ phase: 'failed', group, root, error: String(error) })); process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  // SDK disposal alone does not emit extension shutdown; emit through the public runner first.
  if (session?.extensionRunner && extensionContext) await session.extensionRunner.emit({ type: 'session_shutdown' });
  session?.dispose(); db.close();
}
