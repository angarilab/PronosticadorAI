import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectForecasts, normalizeFixture, competitions } from '../lib/api-football.js';
const now = new Date('2026-10-07T12:00:00Z');
const season = { year: 2026, start: '2026-08-01', end: '2027-05-31', current: true };
function fixture(id, days, leagueId, status = 'FT') {
  return { fixture: { id, date: new Date(now.getTime() + days * 86400000).toISOString(), status: { short: status } }, league: { id: leagueId, season: 2026 }, teams: { home: { id: 1, name: 'Test local' }, away: { id: 2, name: 'Test visitante' } }, score: { fulltime: { home: status === 'FT' ? 2 : null, away: status === 'FT' ? 1 : null } } };
}
const envelope = (response, page = 1, total = 1) => new Response(JSON.stringify({ errors: [], response, paging: { current: page, total } }));

test('API-Football discovers current seasons and normalizes five league histories', async () => {
  const calls = [];
  const result = await collectForecasts({ key: 'mock-apisports-key', now, fetchImpl: async (address, options) => {
    const url = new URL(address); calls.push(url);
    assert.equal(url.origin, 'https://v3.football.api-sports.io');
    assert.equal(options.headers['x-apisports-key'], 'mock-apisports-key');
    assert.equal(options.redirect, 'error');
    if (url.pathname === '/leagues') {
      assert.equal(url.searchParams.get('current'), 'true');
      return envelope([{ league: { id: Number(url.searchParams.get('id')) }, seasons: [season] }]);
    }
    assert.equal(url.pathname, '/fixtures');
    assert.equal(url.searchParams.get('season'), '2026');
    const league = Number(url.searchParams.get('league'));
    return envelope([...Array.from({ length: 40 }, (_, i) => fixture(league * 1000 + i, -i - 1, league)), fixture(league * 1000 + 100, 1, league, 'NS'), fixture(league * 1000 + 101, 2, league, 'NS'), fixture(league * 1000 + 102, 1, league, 'PST')]);
  } });
  assert.equal(calls.length, 10);
  assert.equal(result.forecasts.length, 10);
  assert.equal(new Set(result.forecasts.map(item => item.id)).size, 10);
  assert.equal(result.forecasts.filter(item => item.access === 'free').length, 5);
  assert.ok(result.forecasts.every(item => item.provider === 'API-Football' && item.homeGoals === 2 && item.training.leagueMatches === 40));
});

test('API-Football normalization rejects wrong league/season and excludes extra time and in-progress scores', () => {
  const competition = competitions[0];
  for (const status of ['AET', 'PEN', 'HT', 'LIVE', 'TBD', 'CANC', 'PST']) assert.equal(normalizeFixture(fixture(1, -1, competition.id, status), competition, season).status, 'EXCLUDED');
  assert.throws(() => normalizeFixture(fixture(1, -1, 999), competition, season), /Formato de partido inválido/);
  const bad = fixture(1, -1, competition.id); bad.league.season = 2025;
  assert.throws(() => normalizeFixture(bad, competition, season), /Formato de partido inválido/);
});

test('API-Football handles HTTP-200 errors, missing key, unavailable seasons and quota failures', async () => {
  let called = false;
  await assert.rejects(collectForecasts({ fetchImpl: () => { called = true; } }), /Falta API_FOOTBALL_KEY/);
  assert.equal(called, false);
  await assert.rejects(collectForecasts({ key: 'mock', fetchImpl: async () => new Response(JSON.stringify({ errors: { token: 'mock rejected key' }, response: [] })) }), /notificó un error/);
  await assert.rejects(collectForecasts({ key: 'mock', fetchImpl: async () => envelope([]) }), /temporada actual válida/);
  await assert.rejects(collectForecasts({ key: 'mock', fetchImpl: async () => new Response('{}', { status: 429 }) }), /límite de peticiones/);
});

test('API-Football follows advertised fixture pages without duplicating matches', async () => {
  const calls = [];
  const result = await collectForecasts({ key: 'mock', now, fetchImpl: async address => {
    const url = new URL(address);
    if (url.pathname === '/leagues') return envelope([{ league: { id: Number(url.searchParams.get('id')) }, seasons: [season] }]);
    const league = Number(url.searchParams.get('league')), page = Number(url.searchParams.get('page') || 1);
    calls.push(page);
    const historic = Array.from({ length: 40 }, (_, i) => fixture(league * 1000 + i, -i - 1, league));
    return page === 1 ? envelope(historic, 1, 2) : envelope([historic[0], fixture(league * 1000 + 100, 1, league, 'NS')], 2, 2);
  } });
  assert.equal(result.forecasts.length, 5);
  assert.ok(result.forecasts.every(item => item.training.leagueMatches === 40));
  assert.deepEqual(calls, [1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
});
