const MIN_LEAGUE_MATCHES = 30;
const MIN_TEAM_MATCHES = 3;
const PRIOR_MATCHES = 5;

// Predict now for a future fixture; never train on later results.
export function estimate(fixture, matches, asOf = new Date()) {
  const cutoff = Math.min(new Date(fixture.utcDate).getTime(), asOf.getTime());
  if (!Number.isFinite(cutoff)) throw new Error('Fecha de partido inválida.');
  const seen = new Set();
  const history = matches.filter(match => {
    if (seen.has(match.id)) return false;
    const score = match.score?.fullTime;
    const valid = Number.isInteger(match.id) && match.status === 'FINISHED'
      && match.competition?.code === fixture.competition?.code
      && match.season?.id === fixture.season?.id
      && Number.isFinite(Date.parse(match.utcDate)) && Date.parse(match.utcDate) < cutoff
      && (match.score?.duration === 'REGULAR')
      && Number.isInteger(score?.home) && score.home >= 0
      && Number.isInteger(score?.away) && score.away >= 0;
    if (valid) seen.add(match.id);
    return valid;
  });
  const local = history.filter(match => match.homeTeam?.id === fixture.homeTeam.id);
  const visitor = history.filter(match => match.awayTeam?.id === fixture.awayTeam.id);
  if (history.length < MIN_LEAGUE_MATCHES || local.length < MIN_TEAM_MATCHES || visitor.length < MIN_TEAM_MATCHES) return null;
  const average = (items, side) => items.reduce((total, match) => total + match.score.fullTime[side], 0) / items.length;
  const leagueHome = average(history, 'home'), leagueAway = average(history, 'away');
  if (leagueHome <= 0 || leagueAway <= 0) return null;
  const regularized = (items, side, prior) => (average(items, side) * items.length + PRIOR_MATCHES * prior) / (items.length + PRIOR_MATCHES);
  const homeGoals = regularized(local, 'home', leagueHome) * regularized(visitor, 'home', leagueHome) / leagueHome;
  const awayGoals = regularized(visitor, 'away', leagueAway) * regularized(local, 'away', leagueAway) / leagueAway;
  if (![homeGoals, awayGoals].every(value => Number.isFinite(value) && value >= 0 && value <= 10)) return null;
  const dates = history.map(match => match.utcDate).sort();
  return {
    homeGoals, awayGoals,
    training: { leagueMatches: history.length, homeMatches: local.length, awayMatches: visitor.length, from: dates[0], to: dates.at(-1), asOf: asOf.toISOString(), priorMatches: PRIOR_MATCHES, season: fixture.season, leagueHome, leagueAway }
  };
}
