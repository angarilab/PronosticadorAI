import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predict } from '../lib/model.js';

test('1X2 sums to one and agrees with symmetry', () => {
  for (const lambda of [0, 0.1, 1.5, 10]) {
    const { probabilities: p, omittedMass } = predict(lambda, lambda);
    assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-10);
    assert.ok(Math.abs(p.home - p.away) < 1e-10);
    assert.ok(omittedMass < 2e-12);
  }
});
test('markets agree with independent analytic formulas', () => {
  const h = 1.8, a = 0.9, sum = h + a;
  const { probabilities: p } = predict(h, a);
  assert.ok(Math.abs(p.bothScore - (1 - Math.exp(-h)) * (1 - Math.exp(-a))) < 1e-10);
  assert.ok(Math.abs(p.over25 - (1 - Math.exp(-sum) * (1 + sum + sum * sum / 2))) < 1e-10);
  assert.equal(predict(0, 0).probabilities.draw, 1);
});
test('invalid expected goals are rejected', () => {
  for (const input of [-1, NaN, Infinity, 11, '1']) assert.throws(() => predict(input, 1), RangeError);
});
