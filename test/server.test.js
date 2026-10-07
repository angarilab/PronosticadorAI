import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';

test('HTTP workflow: register, persist session, deny premium, allow entitled user, logout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pronosticador-test-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: directory, PORT: '0', HOST: '127.0.0.1', FOOTBALL_DATA_TOKEN: '', API_FOOTBALL_KEY: '', PRONOSTICADOR_AI_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timeout: ${errors}`)), 10000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code} ${errors}`)); });
      child.stdout.on('data', chunk => { const match = String(chunk).match(/puerto (\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    const origin = `http://127.0.0.1:${port}`;
    let cookie = '';
    const call = async (path, method = 'GET', input, extra = {}) => {
      const response = await fetch(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      return { response, data: await response.json() };
    };
    assert.equal((await call('/api/health')).data.status, 'ok');
    const list = (await call('/api/forecasts')).data.forecasts;
    assert.equal(list.length, 6);
    const premium = list.find(item => item.locked);
    assert.equal(premium.probabilities, undefined);
    assert.equal(premium.homeGoals, undefined);
    assert.equal((await call(`/api/forecasts/${premium.id}`)).response.status, 403);
    const credentials = { email: 'reader@example.test', password: 'a-long-test-password' };
    assert.equal((await call('/api/forecasts/esp-01/explanation', 'POST', {})).response.status, 401);
    assert.equal((await call('/api/register', 'POST', credentials, { Origin: 'https://attacker.example' })).response.status, 403);
    const registration = await call('/api/register', 'POST', { ...credentials, plan: 'premium' });
    assert.equal(registration.response.status, 201);
    assert.equal(registration.data.user.plan, 'free');
    assert.equal(registration.data.user.password_hash, undefined);
    const setCookie = registration.response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    cookie = setCookie.split(';')[0];
    assert.equal((await call('/api/me')).data.user.email, credentials.email);
    assert.equal((await call('/api/register', 'POST', credentials)).response.status, 409);
    assert.equal((await call(`/api/forecasts/${premium.id}`)).response.status, 403);
    assert.equal((await call(`/api/forecasts/${premium.id}/explanation`, 'POST', {})).response.status, 403);
    assert.equal((await call('/api/forecasts/esp-01/explanation', 'POST', {})).response.status, 503);
    await call('/api/logout', 'POST', {});
    assert.equal((await call('/api/me')).data.user, null);
    assert.equal((await call('/api/login', 'POST', { ...credentials, password: 'incorrect-password' })).response.status, 401);
    const login = await call('/api/login', 'POST', credentials);
    assert.equal(login.response.status, 200);
    cookie = login.response.headers.get('set-cookie').split(';')[0];
    const db = new DatabaseSync(join(directory, 'app.sqlite'));
    const stored = db.prepare('SELECT * FROM users').get();
    assert.notEqual(stored.password_hash, credentials.password);
    db.prepare("UPDATE users SET plan='premium' WHERE email=?").run(credentials.email);
    db.close();
    const unlocked = await call(`/api/forecasts/${premium.id}`);
    assert.equal(unlocked.response.status, 200);
    assert.ok(unlocked.data.probabilities.home > 0);
    assert.ok((await call('/api/forecasts')).data.forecasts.every(item => !item.locked));
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Equipos y parámetros ficticios/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(origin + '/style.css')).status, 200);
  } finally {
    const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
