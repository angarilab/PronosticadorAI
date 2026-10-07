import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openDatabase } from '../lib/database.js';

test('HTTP live mode and AI cache work end-to-end with explicitly mocked providers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pronosticador-live-test-'));
  const counter = join(directory, 'calls.txt');
  const preload = join(directory, 'mock-openai.mjs');
  const explanation = { interpretation: 'El modelo favorece al local bajo sus supuestos.', assumptions: 'Los goles se modelan como variables independientes.', cautions: 'Estimación exploratoria sin validación histórica ni garantías.' };
  await writeFile(preload, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url) => {
  if (url !== 'https://api.openai.com/v1/responses') throw new Error('Unexpected mock destination');
  appendFileSync(${JSON.stringify(counter)}, 'called\\n');
  await new Promise(resolve => setTimeout(resolve, 50));
  return new Response(JSON.stringify({ status:'completed', output:[{type:'message',content:[{type:'output_text',text:${JSON.stringify(JSON.stringify(explanation))}}]}] }));
};`);
  const db = openDatabase(directory);
  const now = new Date();
  db.prepare("INSERT INTO settings VALUES('dataset',?)").run(JSON.stringify({ mode: 'live', provider: 'API-Football', syncedAt: now.toISOString(), coverage: [] }));
  const future = {
    id: 'af-test', provider: 'API-Football', home: 'Equipo sintético del test A', away: 'Equipo sintético del test B', league: 'España',
    kickoff: new Date(now.getTime() + 86400000).toISOString(), demo: false, access: 'free', homeGoals: 1.5, awayGoals: 1,
    syncedAt: now.toISOString(), training: { season: { startDate: '2026-08-01', endDate: '2027-05-31' }, leagueMatches: 40, homeMatches: 5, awayMatches: 5 }
  };
  db.prepare('INSERT INTO forecasts VALUES(?,?)').run(future.id, JSON.stringify(future));
  db.close();
  const child = spawn(process.execPath, ['--import', preload, 'server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: directory, PORT: '0', HOST: '127.0.0.1', PRONOSTICADOR_AI_KEY: 'mock-key-no-real-credentials', FOOTBALL_DATA_TOKEN: '', API_FOOTBALL_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timeout: ${errors}`)), 10000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exit: ${code} ${errors}`)); });
      child.stdout.on('data', chunk => { const match = String(chunk).match(/puerto (\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    const origin = `http://127.0.0.1:${port}`;
    let cookie = '';
    const call = async (path, method = 'GET', input) => {
      const response = await fetch(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, ...(input ? { body: JSON.stringify(input) } : {}) });
      return { response, data: await response.json() };
    };
    const list = (await call('/api/forecasts')).data;
    assert.equal(list.demo, false);
    assert.equal(list.forecasts.length, 1);
    assert.equal(list.forecasts[0].id, 'af-test');
    assert.equal(list.forecasts[0].aiExplanation, null);
    const registration = await call('/api/register', 'POST', { email: 'mock-reader@example.test', password: 'mock-long-password' });
    cookie = registration.response.headers.get('set-cookie').split(';')[0];
    const results = await Promise.all([call('/api/forecasts/af-test/explanation', 'POST', {}), call('/api/forecasts/af-test/explanation', 'POST', {})]);
    assert.ok(results.every(item => item.response.status === 200 && item.data.explanation.interpretation === explanation.interpretation));
    assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 1);
    const cached = await call('/api/forecasts/af-test/explanation', 'POST', {});
    assert.equal(cached.data.cached, true);
    assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 1);
    assert.equal((await call('/api/forecasts/af-test')).data.aiExplanation.provider, 'OpenAI');
    assert.equal((await call('/api/health')).data.aiVerifiedLocally, true);
    // A failed sync without a token preserves the previous snapshot and accounts.
    const sync = spawn(process.execPath, ['scripts/sync.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: directory, FOOTBALL_DATA_TOKEN: '', API_FOOTBALL_KEY: '' }, stdio: 'ignore' });
    assert.equal((await once(sync, 'exit'))[0], 1);
    assert.equal((await call('/api/forecasts')).data.forecasts[0].id, 'af-test');
  } finally {
    const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
    await rm(directory, { recursive: true, force: true });
  }
});
