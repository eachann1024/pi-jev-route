import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, parseSettings } from '../lib/store.ts';
import { routeTask } from '../lib/router.ts';

const dir = mkdtempSync(join(tmpdir(), 'pi-jev-route-audit-'));
const previousKey = process.env.TYPESAFE_API_KEY;
process.env.TYPESAFE_API_KEY = 'audit-test-key';
const models = [
  { id: 'p/low', name: 'Low', reasoning: true, description: '', enabled: true },
  { id: 'p/main', name: 'Main', reasoning: true, description: '', enabled: true },
];
const settings = parseSettings({ fallbackModel: 'p/low' });
try {
  const signal = new AbortController().signal;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  const http = await routeTask('bounded task', 'worker', models, settings, models[1], signal);
  assert.equal(http.audit.reasonCode, 'http_error');
  assert.equal(http.audit.fallbackSource, 'configured');
  assert.equal(http.audit.candidateIds.length, 2);
  assert.equal(http.audit.rules.confidenceThreshold, settings.confidenceThreshold);
  assert.equal(http.audit.httpStatus, 503);
  assert.equal(http.audit.timeoutMs, settings.timeoutMs);
  assert.equal(http.model, 'p/low');

  globalThis.fetch = async () => { throw new TypeError('network detail must not persist'); };
  const network = await routeTask('bounded task', 'worker', models, settings, models[1], signal);
  assert.equal(network.audit.reasonCode, 'network_error');
  assert(!JSON.stringify(network).includes('network detail'));

  const store = openStore(join(dir, 'route.sqlite'));
  const base = { id: 'audit-unique-one', at: new Date().toISOString(), sessionId: 's', toolCallId: 't', agent: 'worker', taskHash: 'hash', outcome: 'fallback', requestedModel: 'p/low:low', reason: 'fallback', note: '', audit: http.audit, asyncId: 'async-1' };
  store.addLog(base);
  store.addLog({ ...base, id: 'audit-unique-two' });
  assert.equal(store.findLog('audit-unique-one').log.id, base.id);
  assert.equal(store.findLog('audit-unique').ambiguous, true);
  assert.equal(store.findLog('%').log, undefined);
  assert.equal(store.findLog('_').log, undefined);
  assert.equal(store.getLatestLog().id, 'audit-unique-two');
  store.updateLog(base.id, { runId: 'run-1', actualStatus: 'accepted' });
  assert.equal(store.getLog(base.id).runId, 'run-1');
  assert.throws(() => store.addLog({ ...base, id: 'bad-audit', audit: { ...http.audit, reasonCode: 'x'.repeat(65) } }));
  store.close();
  console.log('audit: structured failure causes, fallback source, safe persistence, lookup ambiguity and async identifiers passed');
} finally {
  if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey;
  rmSync(dir, { recursive: true, force: true });
}
