import { predict } from './model.js';
import { scenarios } from './scenarios.js';

export function getDataset(db) {
  const stored = db.prepare("SELECT value FROM settings WHERE key='dataset'").get();
  return stored ? JSON.parse(stored.value) : { mode: 'demo', syncedAt: null, coverage: [] };
}
export function getForecasts(db, now = new Date()) {
  const dataset = getDataset(db);
  if (dataset.mode === 'demo') return scenarios.map(item => ({ ...item, demo: true }));
  // Never quietly substitute synthetic scenarios if a live snapshot has no upcoming matches.
  return db.prepare('SELECT payload FROM forecasts').all().map(row => JSON.parse(row.payload)).filter(item => Date.parse(item.kickoff) > now.getTime()).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
}
export function forecastDetail(item) {
  const result = predict(item.homeGoals, item.awayGoals);
  const labels = { home: item.home, draw: 'el empate', away: item.away };
  const [favorite, probability] = Object.entries(result.probabilities).slice(0, 3).sort((a, b) => b[1] - a[1])[0];
  return {
    ...item, ...result,
    explanation: `${item.demo ? 'En este escenario hipotético' : 'En esta estimación exploratoria'}, el modelo asigna ${(probability * 100).toFixed(1)} % a ${labels[favorite]}. Los goles esperados son ${item.homeGoals.toFixed(2)} para el local y ${item.awayGoals.toFixed(2)} para el visitante. Se combinan dos distribuciones Poisson independientes y se suman sus probabilidades por mercado.`,
    method: `Poisson independiente · ${item.demo ? 'parámetros sintéticos' : 'regularización con cinco partidos equivalentes'} · versión 0.2`,
    source: item.demo ? 'Parámetros sintéticos elegidos para demostrar la interfaz. No proceden de estadísticas históricas.' : `${item.provider || 'football-data.org'} · temporada ${item.training.season.startDate} a ${item.training.season.endDate}. ${item.training.leagueMatches} partidos de liga; ${item.training.homeMatches} del local en casa y ${item.training.awayMatches} del visitante fuera. Consulta: ${item.syncedAt}.`,
    limitations: `${item.demo ? 'Sin entrenamiento.' : 'Estimada con resultados de la misma liga y temporada anteriores a la consulta.'} Sin validación histórica fuera de muestra. No considera lesiones, alineaciones ni dependencia entre goles. No hay intervalos de incertidumbre ni cuotas disponibles.`,
    analysisType: 'Explicación matemática reproducible. La explicación IA se solicita por separado.'
  };
}
