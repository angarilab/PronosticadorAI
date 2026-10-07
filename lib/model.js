// Independent Poisson goals. Inputs are expected goals, not event probabilities.
function distribution(lambda) {
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 10) throw new RangeError('Los goles esperados deben estar entre 0 y 10.');
  const values = [Math.exp(-lambda)];
  let mass = values[0];
  for (let k = 1; k < 100 && 1 - mass > 1e-12; k++) {
    values.push(values[k - 1] * lambda / k);
    mass += values[k];
  }
  return { values, mass };
}

export function predict(homeGoals, awayGoals) {
  const home = distribution(homeGoals), away = distribution(awayGoals);
  const mass = home.mass * away.mass;
  const probabilities = { home: 0, draw: 0, away: 0, over25: 0, bothScore: 0 };
  const scores = [];
  for (let h = 0; h < home.values.length; h++) {
    for (let a = 0; a < away.values.length; a++) {
      const p = home.values[h] * away.values[a] / mass;
      probabilities[h > a ? 'home' : h === a ? 'draw' : 'away'] += p;
      if (h + a > 2) probabilities.over25 += p;
      if (h > 0 && a > 0) probabilities.bothScore += p;
      scores.push({ home: h, away: a, probability: p });
    }
  }
  scores.sort((a, b) => b.probability - a.probability);
  return { probabilities, scores: scores.slice(0, 5), omittedMass: Math.max(0, 1 - mass) };
}
