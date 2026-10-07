import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { openDatabase } from './lib/database.js';
import { getDataset, getForecasts, forecastDetail } from './lib/forecast-service.js';
import { explain, explanationKey, defaultModel } from './lib/openai.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = process.env.DATA_DIR || join(root, '.data');
const db = openDatabase(dataDir);
const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const attempts = new Map();
const aiRequests = new Map();
const aiAttempts = new Map();
let aiBudget = { count: 0, until: Date.now() + 3600000 };
const publicUser = user => user ? { id: user.id, email: user.email, plan: user.plan } : null;

function respond(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}
function getUser(req) {
  const token = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  if (!token) return null;
  return db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires>?').get(digest(token), Date.now()) || null;
}
function cookie(token, req, age = 604800) {
  return `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`;
}
function session(user, req) {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), user.id, Date.now() + 604800000);
  return cookie(token, req);
}
async function body(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (Buffer.byteLength(value) > 8192) throw new Error('Solicitud demasiado grande.');
  }
  try { return JSON.parse(value); } catch { throw new Error('Solicitud JSON inválida.'); }
}
function detail(item) {
  const forecast = forecastDetail(item);
  const cached = db.prepare('SELECT payload FROM explanations WHERE cache_key=?').get(explanationKey(forecast, process.env.AI_MODEL || defaultModel));
  return { ...forecast, aiExplanation: cached ? JSON.parse(cached.payload) : null, aiAvailable: Boolean(process.env.PRONOSTICADOR_AI_KEY) };
}

const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && staticFiles[path]) {
      const [file, type] = staticFiles[path];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      return res.end(readFileSync(join(root, 'public', file)));
    }
    if (req.method === 'GET' && path === '/api/health') return respond(res, 200, { status: 'ok', dataset: getDataset(db).mode, footballProvider: 'API-Football', footballConfigured: Boolean(process.env.API_FOOTBALL_KEY), aiConfigured: Boolean(process.env.PRONOSTICADOR_AI_KEY), aiVerifiedLocally: db.prepare('SELECT COUNT(*) AS n FROM explanations').get().n > 0, paymentsConnected: false });
    if (req.method === 'POST') {
      if (req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return respond(res, 403, { error: 'Origen de la solicitud no permitido.' });
      if (!req.headers['content-type']?.startsWith('application/json')) return respond(res, 415, { error: 'Se requiere JSON.' });
    }
    const user = getUser(req);
    if (req.method === 'GET' && path === '/api/me') return respond(res, 200, { user: publicUser(user) });
    if (req.method === 'GET' && path === '/api/forecasts') {
      const dataset = getDataset(db);
      return respond(res, 200, { demo: dataset.mode === 'demo', dataset, forecasts: getForecasts(db).map(item => {
        const accessible = item.access === 'free' || user?.plan === 'premium';
        return accessible ? { ...detail(item), locked: false } : { id: item.id, league: item.league, home: item.home, away: item.away, access: item.access, kickoff: item.kickoff, demo: item.demo, locked: true };
      }) });
    }
    if (req.method === 'GET' && path.startsWith('/api/forecasts/')) {
      const item = getForecasts(db).find(item => item.id === path.split('/').pop());
      if (!item) return respond(res, 404, { error: 'Pronóstico no encontrado.' });
      if (item.access === 'premium' && user?.plan !== 'premium') return respond(res, 403, { error: 'Este análisis requiere una suscripción activa.' });
      return respond(res, 200, detail(item));
    }
    const aiMatch = /^\/api\/forecasts\/([^/]+)\/explanation$/.exec(path);
    if (req.method === 'POST' && aiMatch) {
      if (!user) return respond(res, 401, { error: 'Inicia sesión para solicitar la explicación IA.' });
      const item = getForecasts(db).find(item => item.id === aiMatch[1]);
      if (!item) return respond(res, 404, { error: 'Pronóstico no encontrado.' });
      if (item.access === 'premium' && user.plan !== 'premium') return respond(res, 403, { error: 'Este análisis requiere una suscripción activa.' });
      const forecast = forecastDetail(item), model = process.env.AI_MODEL || defaultModel;
      const cacheKey = explanationKey(forecast, model);
      const cached = db.prepare('SELECT payload FROM explanations WHERE cache_key=?').get(cacheKey);
      if (cached) return respond(res, 200, { explanation: JSON.parse(cached.payload), cached: true });
      if (!process.env.PRONOSTICADOR_AI_KEY) return respond(res, 503, { error: 'La explicación IA aún no está disponible. El análisis matemático sí está disponible.' });
      const now = Date.now();
      for (const [id, entry] of aiAttempts) if (entry.until <= now) aiAttempts.delete(id);
      const entry = aiAttempts.get(user.id) || { count: 0, until: now + 60000 };
      if (entry.count >= 3) return respond(res, 429, { error: 'Espera un minuto antes de pedir más explicaciones.' });
      if (aiBudget.until <= now) aiBudget = { count: 0, until: now + 3600000 };
      if (!aiRequests.has(cacheKey) && aiBudget.count >= 20) return respond(res, 429, { error: 'Se ha alcanzado el límite temporal de explicaciones IA.' });
      entry.count++; aiAttempts.set(user.id, entry);
      if (!aiRequests.has(cacheKey)) {
        aiBudget.count++;
        const pending = explain(forecast, { key: process.env.PRONOSTICADOR_AI_KEY, model }).then(explanation => {
          db.prepare('INSERT OR REPLACE INTO explanations VALUES(?,?,?)').run(cacheKey, JSON.stringify(explanation), explanation.generatedAt);
          return explanation;
        });
        aiRequests.set(cacheKey, pending);
      }
      try { return respond(res, 200, { explanation: await aiRequests.get(cacheKey), cached: false }); }
      catch (error) { return respond(res, 502, { error: error.message }); }
      finally { aiRequests.delete(cacheKey); }
    }
    if (req.method === 'POST' && ['/api/register', '/api/login'].includes(path)) {
      const key = req.socket.remoteAddress;
      const now = Date.now();
      for (const [ip, entry] of attempts) if (entry.until < now) attempts.delete(ip);
      const entry = attempts.get(key) || { count: 0, until: now + 60000 };
      entry.count++; attempts.set(key, entry);
      if (entry.count > 15) return respond(res, 429, { error: 'Demasiados intentos. Espera un minuto.' });
      const input = await body(req);
      if (!input || typeof input.email !== 'string' || typeof input.password !== 'string') return respond(res, 400, { error: 'Introduce email y contraseña.' });
      const email = input.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || input.password.length < 10 || input.password.length > 128) return respond(res, 400, { error: 'Introduce un email válido y una contraseña de 10 a 128 caracteres.' });
      let account = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      if (path === '/api/register') {
        if (account) return respond(res, 409, { error: 'Ya existe una cuenta con ese email.' });
        const salt = randomBytes(16).toString('hex');
        const hash = (await derive(input.password, salt, 64)).toString('hex');
        try { db.prepare('INSERT INTO users(email,salt,password_hash) VALUES(?,?,?)').run(email, salt, hash); }
        catch (error) { if (error.code?.startsWith('ERR_SQLITE')) return respond(res, 409, { error: 'No se pudo registrar la cuenta. Comprueba el email.' }); throw error; }
        account = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      } else {
        const hash = await derive(input.password, account?.salt || 'unknown-account-salt', 64);
        if (!account || !timingSafeEqual(hash, Buffer.from(account.password_hash, 'hex'))) return respond(res, 401, { error: 'Email o contraseña incorrectos.' });
      }
      return respond(res, path === '/api/register' ? 201 : 200, { user: publicUser(account) }, { 'Set-Cookie': session(account, req) });
    }
    if (req.method === 'POST' && path === '/api/logout') {
      const token = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
      return respond(res, 200, { ok: true }, { 'Set-Cookie': cookie('', req, 0) });
    }
    return respond(res, 404, { error: 'Ruta no encontrada.' });
  } catch (error) {
    if (['Solicitud demasiado grande.', 'Solicitud JSON inválida.'].includes(error.message)) return respond(res, 400, { error: error.message });
    console.error('Error interno:', error.code || error.name);
    return respond(res, 500, { error: 'No se pudo completar la solicitud.' });
  }
});
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log(`PronosticadorAI escuchando en el puerto ${server.address().port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
