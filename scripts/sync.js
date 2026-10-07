import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { collectForecasts } from '../lib/api-football.js';
import { openDatabase } from '../lib/database.js';

try {
  const snapshot = await collectForecasts({ key: process.env.API_FOOTBALL_KEY });
  const root = fileURLToPath(new URL('..', import.meta.url));
  const db = openDatabase(process.env.DATA_DIR || join(root, '.data'));
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM forecasts').run();
    const insert = db.prepare('INSERT INTO forecasts(id,payload) VALUES(?,?)');
    for (const forecast of snapshot.forecasts) insert.run(forecast.id, JSON.stringify(forecast));
    db.prepare("INSERT OR REPLACE INTO settings VALUES('dataset',?)").run(JSON.stringify({ mode: 'live', provider: snapshot.provider, syncedAt: snapshot.syncedAt, coverage: snapshot.coverage }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
  console.log(`Sincronización completada: ${snapshot.forecasts.length} partidos con estimación exploratoria.`);
  for (const row of snapshot.coverage) console.log(`${row.competition}: ${row.published} publicados, ${row.insufficientData} omitidos por datos insuficientes.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
