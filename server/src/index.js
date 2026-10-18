import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { startWorker } from './worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.DB_PATH || path.join(here, '..', 'data', 'ops.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = openDb(dbFile);
const seeded = seed(db); // only runs on an empty database
if (!seeded.skipped) console.log('Seeded demo data:', seeded);
db.exec('ANALYZE'); // give the query planner real statistics (cheap on this size)

startWorker(db);
const app = createApp(db, { clientDir: path.join(here, '..', '..', 'client', 'dist') });
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`API listening on http://localhost:${port}  (db: ${dbFile})`));
