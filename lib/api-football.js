import { estimate } from './estimator.js';

export const competitions = [
  { id: 140, code: 'PD', league: 'España' }, { id: 39, code: 'PL', league: 'Inglaterra' },
  { id: 135, code: 'SA', league: 'Italia' }, { id: 78, code: 'BL1', league: 'Alemania' },
  { id: 61, code: 'FL1', league: 'Francia' }
];
const base = 'https://v3.football.api-sports.io';

async function request(path, params, key, fetchImpl) {
  const url = new URL(path, base);
  url.search = new URLSearchParams(params).toString();
  let response;
  try {
    response = await fetchImpl(url.href, { headers: { 'x-apisports-key': key }, signal: AbortSignal.timeout(20000), redirect: 'error' });
  } catch { throw new Error('No se pudo conectar con API-Football. Comprueba el acceso de red.'); }
  if (!response.ok) {
    const reason = { 401: 'clave no válida', 403: 'acceso denegado', 429: 'límite de peticiones alcanzado' };
    throw new Error(`API-Football: ${reason[response.status] || 'error del proveedor'} (HTTP ${response.status}).`);
  }
  let payload;
  try { payload = await response.json(); } catch { throw new Error('API-Football devolvió JSON inválido.'); }
  // This provider can report authentication, quota and subscription errors with HTTP 200.
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.response) || payload.errors == null || typeof payload.errors !== 'object') throw new Error('Respuesta de API-Football inválida.');
  if (Object.keys(payload.errors).length) throw new Error('API-Football notificó un error. Comprueba clave, suscripción, parámetros y cuota en el panel del proveedor. No se ha sustituido la instantánea anterior.');
  return { payload, url: url.href };
}

export function normalizeFixture(item, competition, season) {
  if (!item || !Number.isInteger(item.fixture?.id) || item.league?.id !== competition.id || item.league?.season !== season.year || !Number.isInteger(item.teams?.home?.id) || !Number.isInteger(item.teams?.away?.id) || !item.teams.home.name || !item.teams.away.name || !Number.isFinite(Date.parse(item.fixture.date))) throw new Error(`Formato de partido inválido en API-Football (${competition.code}).`);
  const status = item.fixture.status?.short;
  return {
    id: item.fixture.id, competition: { code: competition.code },
    season: { id: season.year, startDate: season.start, endDate: season.end },
    utcDate: new Date(item.fixture.date).toISOString(),
    status: status === 'FT' ? 'FINISHED' : status === 'NS' ? 'TIMED' : 'EXCLUDED',
    homeTeam: item.teams.home, awayTeam: item.teams.away,
    score: { duration: status === 'FT' ? 'REGULAR' : 'OTHER', fullTime: { home: item.score?.fulltime?.home ?? null, away: item.score?.fulltime?.away ?? null } }
  };
}

export async function collectForecasts({ key, fetchImpl = fetch, now = new Date() }) {
  if (!key) throw new Error('Falta API_FOOTBALL_KEY. Configúrala de forma segura antes de sincronizar.');
  const forecasts = [], coverage = [];
  for (const competition of competitions) {
    const metadata = await request('/leagues', { id: competition.id, current: 'true' }, key, fetchImpl);
    const league = metadata.payload.response.find(item => item.league?.id === competition.id);
    const current = league?.seasons?.filter(item => item.current === true) || [];
    if (current.length !== 1 || !Number.isInteger(current[0].year) || !Number.isFinite(Date.parse(current[0].start)) || !Number.isFinite(Date.parse(current[0].end))) throw new Error(`API-Football no identifica una temporada actual válida para ${competition.code}.`);
    const season = current[0];
    const matches = [];
    let sourceUrl;
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page++) {
      const params = { league: competition.id, season: season.year };
      if (page > 1) params.page = page;
      const result = await request('/fixtures', params, key, fetchImpl);
      const paging = result.payload.paging;
      if (!Number.isInteger(paging?.total) || paging.total < 1 || paging.total > 20 || paging.current !== page || (page > 1 && paging.total !== totalPages)) throw new Error(`Paginación de API-Football inválida (${competition.code}).`);
      totalPages = paging.total;
      sourceUrl ||= result.url;
      matches.push(...result.payload.response.map(item => normalizeFixture(item, competition, season)));
    }
    const unique = [...new Map(matches.map(match => [match.id, match])).values()];
    const future = unique.filter(match => match.status === 'TIMED' && Date.parse(match.utcDate) > now.getTime() && Date.parse(match.utcDate) <= now.getTime() + 7 * 86400000).sort((a, b) => a.utcDate.localeCompare(b.utcDate));
    let accepted = 0, skipped = 0;
    for (const match of future) {
      const parameters = estimate(match, unique, now);
      if (!parameters) { skipped++; continue; }
      forecasts.push({ id: `af-${match.id}`, league: competition.league, competition: competition.code, home: match.homeTeam.name, away: match.awayTeam.name, kickoff: match.utcDate, access: accepted === 0 ? 'free' : 'premium', ...parameters, demo: false, syncedAt: now.toISOString(), sourceUrl, provider: 'API-Football' });
      accepted++;
    }
    coverage.push({ competition: competition.code, providerLeagueId: competition.id, received: unique.length, upcoming: future.length, published: accepted, insufficientData: skipped });
  }
  return { forecasts, coverage, syncedAt: now.toISOString(), provider: 'API-Football' };
}
