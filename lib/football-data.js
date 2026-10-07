import { estimate } from './estimator.js';

export const competitions = [
  { code: 'PD', league: 'España' }, { code: 'PL', league: 'Inglaterra' },
  { code: 'SA', league: 'Italia' }, { code: 'BL1', league: 'Alemania' },
  { code: 'FL1', league: 'Francia' }
];

export async function collectForecasts({ token, fetchImpl = fetch, now = new Date() }) {
  if (!token) throw new Error('Falta FOOTBALL_DATA_TOKEN. Configúralo de forma segura antes de sincronizar.');
  const forecasts = [], coverage = [];
  // Five sequential requests. No uncontrolled retry loop or requests from visitors.
  for (const competition of competitions) {
    const endpoint = `https://api.football-data.org/v4/competitions/${competition.code}/matches`;
    let response;
    try {
      response = await fetchImpl(endpoint, { headers: { 'X-Auth-Token': token }, signal: AbortSignal.timeout(20000), redirect: 'error' });
    } catch { throw new Error(`No se pudo conectar con football-data.org (${competition.code}); comprueba red y acceso.`); }
    if (!response.ok) {
      const reasons = { 401: 'token no válido', 403: 'acceso denegado o competición no incluida en tu plan', 429: 'límite de peticiones alcanzado' };
      throw new Error(`football-data.org (${competition.code}): ${reasons[response.status] || 'error del proveedor'} (HTTP ${response.status}). No se ha reemplazado el conjunto anterior.`);
    }
    let payload;
    try { payload = await response.json(); } catch { throw new Error(`Respuesta JSON inválida (${competition.code}).`); }
    if (!Array.isArray(payload.matches) || payload.matches.some(match => match.competition?.code !== competition.code || !Number.isInteger(match.id) || !Number.isInteger(match.season?.id) || !Number.isInteger(match.homeTeam?.id) || !Number.isInteger(match.awayTeam?.id))) throw new Error(`Respuesta de partidos inválida (${competition.code}).`);
    const uniqueMatches = [...new Map(payload.matches.map(match => [match.id, match])).values()];
    const future = uniqueMatches.filter(match => ['SCHEDULED', 'TIMED'].includes(match.status) && Date.parse(match.utcDate) > now.getTime() && Date.parse(match.utcDate) <= now.getTime() + 7 * 86400000).sort((a, b) => a.utcDate.localeCompare(b.utcDate));
    let skipped = 0, accepted = 0;
    for (const match of future) {
      if (!match.homeTeam?.name || !match.awayTeam?.name) { skipped++; continue; }
      const parameters = estimate(match, uniqueMatches, now);
      if (!parameters) { skipped++; continue; }
      forecasts.push({
        id: `fd-${match.id}`, league: competition.league, competition: competition.code,
        home: match.homeTeam.name, away: match.awayTeam.name,
        kickoff: match.utcDate, access: accepted === 0 ? 'free' : 'premium',
        ...parameters, demo: false, syncedAt: now.toISOString(),
        sourceUrl: endpoint, provider: 'football-data.org'
      });
      accepted++;
    }
    coverage.push({ competition: competition.code, received: uniqueMatches.length, upcoming: future.length, published: accepted, insufficientData: skipped });
  }
  return { forecasts, coverage, syncedAt: now.toISOString() };
}
