const { Pool } = require('pg');

let pool;

function db() {
  if (pool) return pool;

  const s =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING;

  if (!s) throw new Error('DATABASE_NOT_CONNECTED');

  const u = new URL(s);
  ['sslmode','ssl','uselibpqcompat','sslrootcert','sslcert','sslkey']
    .forEach(k => u.searchParams.delete(k));

  pool = new Pool({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false }
  });

  return pool;
}

const J = (res, status, data) => res.status(status).json(data);

async function init() {
  const x = db();

  await x.query(`
    CREATE TABLE IF NOT EXISTS clients(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      note TEXT DEFAULT ''
    )
  `);

  await x.query(`
    CREATE TABLE IF NOT EXISTS appointments(
      id SERIAL PRIMARY KEY,
      client_id INTEGER,
      client_name TEXT NOT NULL,
      appointment_date DATE NOT NULL,
      appointment_time TIME NOT NULL,
      duration INTEGER DEFAULT 60,
      type TEXT DEFAULT 'Консультация',
      price INTEGER DEFAULT 0,
      paid BOOLEAN DEFAULT false,
      note TEXT DEFAULT '',
      source TEXT DEFAULT 'app'
    )
  `);
}

function cleanName(v) {
  return String(v ?? '').trim();
}

async function findClient(name) {
  const clean = cleanName(name);
  if (!clean) return null;

  const r = await db().query(
    `SELECT id,name,phone,note
     FROM clients
     WHERE lower(name)=lower($1)
     LIMIT 1`,
    [clean]
  );

  return r.rows[0] || null;
}

async function getOrCreateClient(name) {
  const clean = cleanName(name);
  if (!clean) throw new Error('CLIENT_NAME_REQUIRED');

  const existing = await findClient(clean);
  if (existing) return existing;

  return (
    await db().query(
      `INSERT INTO clients(name)
       VALUES($1)
       RETURNING id,name,phone,note`,
      [clean]
    )
  ).rows[0];
}

async function appointments(req, res) {
  const x = db();
  const b = req.body || {};

  if (req.method === 'GET') {
    const r = await x.query(`
      SELECT id,client_id,client_name,
             TO_CHAR(appointment_date,'YYYY-MM-DD') AS date,
             TO_CHAR(appointment_time,'HH24:MI') AS time,
             duration,type,price,paid,note,source
      FROM appointments
      ORDER BY appointment_date,appointment_time
    `);
    return J(res, 200, { appointments: r.rows });
  }

  if (req.method === 'POST') {
    if (!b.client_name || !b.date || !b.time) {
      return J(res, 400, { error: 'client_name, date и time обязательны' });
    }

    const c = await getOrCreateClient(b.client_name);

    const r = await x.query(
      `INSERT INTO appointments
       (client_id,client_name,appointment_date,appointment_time,
        duration,type,price,paid,note,source)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        c.id, c.name, b.date, b.time,
        Number(b.duration) || 60,
        b.type || 'Очная консультация',
        Number(b.price) || 0,
        Boolean(b.paid),
        b.note || '',
        b.source || 'app'
      ]
    );

    return J(res, 200, { ok: true, id: r.rows[0].id });
  }

  if (req.method === 'PUT') {
    if (!b.id || !b.client_name || !b.date || !b.time) {
      return J(res, 400, { error: 'id, client_name, date и time обязательны' });
    }

    const c = await getOrCreateClient(b.client_name);

    const r = await x.query(
      `UPDATE appointments SET
       client_id=$1,client_name=$2,appointment_date=$3,
       appointment_time=$4,duration=$5,type=$6,note=$7
       WHERE id=$8 RETURNING id`,
      [
        c.id, c.name, b.date, b.time,
        Number(b.duration) || 60,
        b.type || 'Очная консультация',
        b.note || '',
        Number(b.id)
      ]
    );

    if (!r.rowCount) return J(res, 404, { error: 'Запись не найдена' });
    return J(res, 200, { ok: true });
  }

  if (req.method === 'DELETE') {
    const id = Number(req.query?.id ?? b.id);
    if (!Number.isFinite(id)) return J(res, 400, { error: 'Некорректный id' });

    const r = await x.query(
      `DELETE FROM appointments WHERE id=$1 RETURNING id`,
      [id]
    );

    return J(res, 200, { ok: true, id, deleted: !!r.rowCount });
  }

  return J(res, 405, { error: 'Method' });
}

async function clients(req, res) {
  const x = db();
  const b = req.body || {};

  if (req.method === 'GET' && req.query.name) {
    const c = await findClient(req.query.name);
    if (!c) return J(res, 404, { error: 'Клиент не найден' });

    const a = (
      await x.query(
        `SELECT id,client_id,client_name,
                TO_CHAR(appointment_date,'YYYY-MM-DD') AS date,
                TO_CHAR(appointment_time,'HH24:MI') AS time,
                duration,type,note,source
         FROM appointments
         WHERE client_id=$1
         ORDER BY appointment_date DESC,appointment_time DESC`,
        [c.id]
      )
    ).rows;

    return J(res, 200, { client: c, appointments: a, transactions: [] });
  }

  if (req.method === 'GET') {
    const r = await x.query(
      `SELECT id,name,phone,note FROM clients ORDER BY name`
    );
    return J(res, 200, { clients: r.rows });
  }

  if (req.method === 'POST') {
    if (!cleanName(b.name)) return J(res, 400, { error: 'Имя клиента обязательно' });

    const c = await getOrCreateClient(b.name);

    await x.query(
      `UPDATE clients SET phone=$1,note=$2 WHERE id=$3`,
      [b.phone || '', b.note || '', c.id]
    );

    return J(res, 200, { ok: true });
  }

  if (req.method === 'PUT') {
    if (!cleanName(b.old_name) || !cleanName(b.name)) {
      return J(res, 400, { error: 'Имя клиента обязательно' });
    }

    const c = await findClient(b.old_name);
    if (!c) return J(res, 404, { error: 'Клиент не найден' });

    const newName = cleanName(b.name);

    await x.query(
      `UPDATE clients SET name=$1,phone=$2,note=$3 WHERE id=$4`,
      [newName, b.phone || '', b.note || '', c.id]
    );

    await x.query(
      `UPDATE appointments SET client_name=$1 WHERE client_id=$2`,
      [newName, c.id]
    );

    return J(res, 200, { ok: true });
  }

  if (req.method === 'DELETE') {
    const name = cleanName(b.name);
    if (!name) return J(res, 400, { error: 'Имя клиента обязательно' });

    const c = await findClient(name);
    if (c) await x.query(`DELETE FROM clients WHERE id=$1`, [c.id]);

    return J(res, 200, { ok: true });
  }

  return J(res, 405, { error: 'Method' });
}

module.exports = async (req, res) => {
  try {
    await init();

    const q = req.query || {};
    const path = (req.url || '').split('?')[0].replace(/\/+$/, '');

    let route = q.route || '';

    if (!route) {
      if (path === '/api/appointments' || path.endsWith('/api/appointments')) {
        route = 'appointments';
      } else if (path === '/api/clients' || path.endsWith('/api/clients')) {
        route = 'clients';
      }
    }

    if (route === 'appointments') return appointments(req, res);
    if (route === 'clients') return clients(req, res);

    return J(res, 404, { error: 'Not found', path, route });
  } catch (e) {
    console.error(e);
    return J(res, 500, { error: e.message || 'Server error' });
  }
};
