import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimate } from '../lib/estimator.js';
import { collectForecasts } from '../lib/football-data.js';
import { explain, explanationKey } from '../lib/openai.js';
import { forecastDetail, getForecasts } from '../lib/forecast-service.js';
import { openDatabase } from '../lib/database.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = new Date('2026-10-07T12:00:00Z');
function match(id, days, code = 'PL', status = 'FINISHED', goals = [2, 1]) {
  return { id, competition: { code }, season: { id: 2026, startDate: '2026-08-01', endDate: '2027-05-31' }, utcDate: new Date(now.getTime() + days * 86400000).toISOString(), status, homeTeam: { id: 1, name: 'Equipo de prueba A' }, awayTeam: { id: 2, name: 'Equipo de prueba B' }, score: { duration: 'REGULAR', fullTime: { home: goals[0], away: goals[1] } } };
}
const history = Array.from({ length: 40 }, (_, i) => match(i + 1, -i - 1));

test('estimator uses only finished results before prediction time, same season and league', () => {
  const fixture = match(100, 1, 'PL', 'TIMED');
  const base = estimate(fixture, history, now);
  assert.equal(base.homeGoals, 2);
  assert.equal(base.awayGoals, 1);
  const invalid = [match(101, 2, 'PL', 'FINISHED', [9, 0]), match(102, -2, 'PL', 'SCHEDULED', [9, 0]), match(103, -1, 'PD', 'FINISHED', [9, 0]), { ...match(104, -1), season: { id: 2025 } }, { ...match(105, -1), score: { duration: 'EXTRA_TIME', fullTime: { home: 9, away: 0 } } }];
  assert.deepEqual(estimate(fixture, [...history, ...invalid, history[0]], now), base);
  assert.equal(estimate(fixture, history.slice(0, 20), now), null);
  assert.equal(estimate({ ...fixture, homeTeam: { id: 999 } }, history, now), null);
  // Even when requested retrospectively, later finished results do not enter the fit.
  assert.equal(estimate(match(200, -20), history, now), null);
});

test('football provider sends auth only to fixed HTTPS host and collects five leagues sequentially', async () => {
  const calls = [];
  const snapshot = await collectForecasts({ token: 'test-only-token', now, fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers['X-Auth-Token'], 'test-only-token');
    assert.equal(options.redirect, 'error');
    const code = url.split('/').at(-2);
    const offset = calls.length * 1000;
    return new Response(JSON.stringify({ matches: [...history.map(item => ({ ...item, id: item.id + offset, competition: { code } })), match(offset + 100, 1, code, 'TIMED'), match(offset + 101, 2, code, 'SCHEDULED'), match(offset + 102, 8, code, 'TIMED')] }));
  } });
  assert.equal(calls.length, 5);
  assert.ok(calls.every(url => url.startsWith('https://api.football-data.org/v4/competitions/')));
  assert.equal(snapshot.forecasts.length, 10);
  assert.equal(new Set(snapshot.forecasts.map(item => item.id)).size, 10);
  assert.equal(snapshot.forecasts.filter(item => item.access === 'free').length, 5);
  assert.ok(snapshot.forecasts.every(item => item.demo === false && item.training.leagueMatches === 40));
  let requests = 0;
  await assert.rejects(collectForecasts({ now, fetchImpl: () => { requests++; } }), /Falta FOOTBALL_DATA_TOKEN/);
  assert.equal(requests, 0);
  await assert.rejects(collectForecasts({ token: 'test-only-token', now, fetchImpl: async () => new Response('{}', { status: 429 }) }), /límite de peticiones/);
  await assert.rejects(collectForecasts({ token: 'test-only-token', now, fetchImpl: async () => new Response('{}') }), /Respuesta de partidos inválida/);
});

test('OpenAI receives computed evidence, strict schema, no storage and no user credentials', async () => {
  const forecast = forecastDetail({ id: 'test', home: 'Ejemplo A', away: 'Ejemplo B', homeGoals: 1.8, awayGoals: 0.9, demo: true });
  const content = { interpretation: 'El modelo favorece al equipo local en este escenario ficticio.', assumptions: 'Se supone independencia entre los goles.', cautions: 'El ejemplo no está validado y no garantiza resultados.' };
  const result = await explain(forecast, { key: 'test-only-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer test-only-key');
    const payload = JSON.parse(options.body);
    assert.equal(payload.store, false);
    assert.equal(payload.text.format.strict, true);
    assert.equal(JSON.parse(payload.input).probabilities.home, forecast.probabilities.home);
    assert.equal(payload.input.includes('test-only-key'), false);
    assert.equal(payload.input.includes('email'), false);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(content) }] }] }));
  } });
  assert.equal(result.interpretation, content.interpretation);
  assert.equal(result.provider, 'OpenAI');
  assert.notEqual(explanationKey(forecast), explanationKey({ ...forecast, homeGoals: 2 }));
  assert.notEqual(explanationKey(forecast), explanationKey(forecast, 'different-model'));
});

test('AI missing keys, quota errors, incomplete responses and invented numeric text fail visibly', async () => {
  await assert.rejects(explain({}), /falta configurar/);
  await assert.rejects(explain({}, { key: 'test-only-key', fetchImpl: async () => new Response('{}', { status: 429 }) }), /límite de uso/);
  await assert.rejects(explain({}, { key: 'test-only-key', fetchImpl: async () => new Response(JSON.stringify({ status: 'incomplete' })) }), /no completó/);
  const bad = { interpretation: 'Ganará con 99 % de probabilidad.', assumptions: 'Poisson.', cautions: 'Ejemplo.' };
  await assert.rejects(explain({}, { key: 'test-only-key', fetchImpl: async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(bad) }] }] })) }), /no cumple el formato/);
});

test('live snapshots never fall back to fictional examples when all fixtures expire', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pronosticador-dataset-'));
  const db = openDatabase(directory);
  try {
    assert.equal(getForecasts(db, now).length, 6);
    db.prepare("INSERT INTO settings VALUES('dataset',?)").run(JSON.stringify({ mode: 'live', syncedAt: now.toISOString() }));
    assert.deepEqual(getForecasts(db, now), []);
    db.prepare('INSERT INTO forecasts VALUES(?,?)').run('expired', JSON.stringify({ id: 'expired', kickoff: new Date(now.getTime() - 1).toISOString() }));
    assert.deepEqual(getForecasts(db, now), []);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
