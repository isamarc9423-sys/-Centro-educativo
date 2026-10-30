const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });

const db = new Database(path.join(DIR, 'portal.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, user TEXT UNIQUE NOT NULL, nom TEXT, mail TEXT,
  rol TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, estado TEXT NOT NULL, creado INTEGER);
CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY, uid INTEGER NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);`);

const ROLES = ['docente', 'secre', 'apoyo', 'admin'];
const ESTADOS = ['activo', 'pendiente', 'rechazada', 'desactivada'];
const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
async function makeHash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: (await scrypt(pw, salt)).toString('hex') };
}
async function checkPw(pw, u) {
  const h = await scrypt(pw, u.salt), b = Buffer.from(u.hash, 'hex');
  return b.length === h.length && crypto.timingSafeEqual(b, h);
}
const clean = s => String(s ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, 120);
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const pub = u => ({ id: u.id, user: u.user, nom: u.nom, mail: u.mail, rol: u.rol, estado: u.estado });
const cookie = (req, n) => {
  const p = (req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(([k]) => k === n);
  return p && p[1];
};

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'], formAction: ["'self'"], frameAncestors: ["'none'"] } } }));
app.use(express.json({ limit: '6mb' }));

// Protección CSRF: las peticiones que modifican datos deben traer esta cabecera propia.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('x-requested-with') !== 'fetch')
    return res.status(403).json({ error: 'Solicitud no válida.' });
  next();
});

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos.' } });

function auth(req, res, next) {
  const t = cookie(req, 'sid');
  if (t) {
    const u = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.uid WHERE s.th = ? AND s.exp > ?')
      .get(sha(t), Date.now());
    if (u && u.estado === 'activo') { req.user = u; return next(); }
  }
  res.status(401).json({ error: 'Inicia sesión.' });
}
const need = (...r) => (req, res, next) =>
  r.includes(req.user.rol) ? next() : res.status(403).json({ error: 'No tienes permiso.' });

const schoolData = () => { const r = db.prepare("SELECT v FROM kv WHERE k='school'").get(); return r ? JSON.parse(r.v) : null; };

// Estado público: si hay que crear el administrador y los datos de marca del centro (para la pantalla de entrada).
app.get('/api/status', (req, res) => {
  const first = !db.prepare('SELECT 1 FROM users').get();
  const d = schoolData();
  res.json({ first, center: d && d.C ? d.C : null });
});

app.post('/api/register', limiter, async (req, res) => {
  const { user, pw, nom, mail, rol } = req.body || {};
  const u = String(user || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,20}$/.test(u)) return res.status(400).json({ error: 'Usuario inválido: 3 a 20 letras, números, punto o guion.' });
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  if (!clean(nom)) return res.status(400).json({ error: 'Escribe tu nombre completo.' });
  if (db.prepare('SELECT 1 FROM users WHERE user = ?').get(u)) return res.status(409).json({ error: 'Ese usuario ya existe. Elige otro.' });
  const { salt, hash } = await makeHash(pw);
  const first = !db.prepare('SELECT 1 FROM users').get(); // se evalúa justo antes de insertar
  try {
    db.prepare('INSERT INTO users(user,nom,mail,rol,salt,hash,estado,creado) VALUES(?,?,?,?,?,?,?,?)')
      .run(u, clean(nom), clean(mail), first ? 'admin' : (ROLES.includes(rol) && rol !== 'admin' ? rol : 'apoyo'),
        salt, hash, first ? 'activo' : 'pendiente', Date.now());
  } catch (e) { return res.status(409).json({ error: 'Ese usuario ya existe. Elige otro.' }); }
  res.json({ ok: true, first });
});

app.post('/api/login', limiter, async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE user = ?').get(String((req.body || {}).user || '').trim().toLowerCase());
  const good = await checkPw(String((req.body || {}).pw || ''), u || { salt: '00', hash: '00'.repeat(64) });
  if (!u || !good) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  if (u.estado === 'pendiente') return res.status(403).json({ error: 'Tu cuenta está pendiente de aprobación por un administrador.' });
  if (u.estado !== 'activo') return res.status(403).json({ error: 'Esta cuenta no tiene acceso. Habla con un administrador.' });
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(t), u.id, Date.now() + 8 * 3600e3);
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${PROD ? '; Secure' : ''}`);
  res.json({ user: pub(u) });
});

app.post('/api/logout', (req, res) => {
  const t = cookie(req, 'sid');
  if (t) db.prepare('DELETE FROM sessions WHERE th = ?').run(sha(t));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: pub(req.user) }));

// Administración de accesos (solo administradores)
app.get('/api/users', auth, need('admin'), (req, res) =>
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY creado').all().map(pub) }));

app.post('/api/users/:id', auth, need('admin'), (req, res) => {
  const id = Number(req.params.id), { estado, rol } = req.body || {};
  if (id === req.user.id) return res.status(400).json({ error: 'No puedes cambiar tu propia cuenta.' });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'Usuario no encontrado.' });
  if (estado !== undefined) {
    if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });
    db.prepare('UPDATE users SET estado = ? WHERE id = ?').run(estado, id);
    if (estado !== 'activo') db.prepare('DELETE FROM sessions WHERE uid = ?').run(id);
  }
  if (rol !== undefined) {
    if (!ROLES.includes(rol)) return res.status(400).json({ error: 'Cargo inválido.' });
    db.prepare('UPDATE users SET rol = ? WHERE id = ?').run(rol, id);
    db.prepare('DELETE FROM sessions WHERE uid = ?').run(id);
  }
  res.json({ ok: true });
});

app.post('/api/users/:id/password', auth, need('admin'), async (req, res) => {
  const id = Number(req.params.id), pw = (req.body || {}).pw;
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'Usuario no encontrado.' });
  const { salt, hash } = await makeHash(pw);
  db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hash, id);
  db.prepare('DELETE FROM sessions WHERE uid = ?').run(id);
  res.json({ ok: true });
});

// Datos del colegio (estudiantes, secciones, datos del centro). Leen todos; escriben administración y secretaría.
app.get('/api/data/school', auth, (req, res) => res.json({ data: schoolData() }));
app.put('/api/data/school', auth, need('admin', 'secre'), (req, res) => {
  const d = (req.body || {}).data;
  if (!d || typeof d !== 'object' || !Array.isArray(d.S)) return res.status(400).json({ error: 'Datos inválidos.' });
  if (req.user.rol !== 'admin') { // secretaría no modifica los datos del centro
    const cur = schoolData(); d.C = cur && cur.C ? cur.C : d.C;
  }
  db.prepare("INSERT INTO kv(k,v) VALUES('school',?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(d));
  res.json({ ok: true });
});

setInterval(() => db.prepare('DELETE FROM sessions WHERE exp < ?').run(Date.now()), 3600e3).unref();
app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Portal escolar en http://localhost:${PORT}`));
