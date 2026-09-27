const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { pool, inicializar } = require('./db');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'gecon';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const UMBRAL = Number(process.env.UMBRAL_ALTA_EXPOSICION || 15);

for (const [nombre, valor] of Object.entries({ DATABASE_URL: process.env.DATABASE_URL, API_KEY, DASHBOARD_PASSWORD })) {
  if (!valor) {
    console.error(`Falta la variable de entorno ${nombre}. La aplicacion no arranca sin ella.`);
    process.exit(1);
  }
}

const ESTADOS = ['abierto', 'en_respuesta', 'cerrado'];
const TIPOS_EVENTO = ['creacion', 'mencion', 'confirmacion', 'actualizacion'];

const app = express();
app.use(express.json({ limit: '1mb' }));

function igualSeguro(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function exigirClave(req, res, next) {
  const clave = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!clave || !igualSeguro(clave, API_KEY)) {
    return res.status(401).json({ error: 'Clave de API invalida o ausente (header x-api-key)' });
  }
  next();
}

function exigirLogin(req, res, next) {
  const [tipo, token] = (req.get('authorization') || '').split(' ');
  if (tipo === 'Basic' && token) {
    const texto = Buffer.from(token, 'base64').toString();
    const i = texto.indexOf(':');
    if (i > 0 && igualSeguro(texto.slice(0, i), DASHBOARD_USER) && igualSeguro(texto.slice(i + 1), DASHBOARD_PASSWORD)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Registro de Riesgos", charset="UTF-8"');
  res.status(401).send('Acceso restringido');
}

class ErrorValidacion extends Error {}

function normalizarFecha(valor) {
  if (typeof valor !== 'string') throw new ErrorValidacion('fecha_documento es obligatoria (dd/mm/aaaa o aaaa-mm-dd)');
  let m = valor.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  let iso = m ? `${m[3]}-${m[2]}-${m[1]}` : valor.trim();
  m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m && new Date(`${iso}T00:00:00Z`);
  if (!d || isNaN(d) || d.toISOString().slice(0, 10) !== iso) {
    throw new ErrorValidacion('fecha_documento invalida (dd/mm/aaaa o aaaa-mm-dd)');
  }
  return iso;
}

function nivel(valor, campo) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new ErrorValidacion(`${campo} debe ser un entero entre 1 y 5`);
  return n;
}

function estado(valor) {
  const e = String(valor).trim().toLowerCase().replace(/\s+/g, '_');
  if (!ESTADOS.includes(e)) throw new ErrorValidacion(`estado debe ser uno de: ${ESTADOS.join(', ')}`);
  return e;
}

function textoObligatorio(valor, campo) {
  if (typeof valor !== 'string' || !valor.trim()) throw new ErrorValidacion(`${campo} es obligatorio`);
  return valor.trim();
}

function textoOpcional(valor) {
  if (valor === undefined || valor === null) return null;
  const t = String(valor).trim();
  return t || null;
}

function origen(body) {
  return {
    documento: textoObligatorio(body.documento, 'documento'),
    fecha_documento: normalizarFecha(body.fecha_documento),
    fragmento: textoObligatorio(body.fragmento, 'fragmento'),
  };
}

const manejar = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- API externa (clave) ----------
const externo = express.Router();
externo.use(exigirClave);

externo.post('/riesgos', manejar(async (req, res) => {
  const b = req.body || {};
  const datos = {
    categoria: textoObligatorio(b.categoria, 'categoria'),
    descripcion: textoObligatorio(b.descripcion, 'descripcion'),
    probabilidad: nivel(b.probabilidad, 'probabilidad'),
    impacto: nivel(b.impacto, 'impacto'),
    estado: b.estado ? estado(b.estado) : 'abierto',
    estrategia_respuesta: textoOpcional(b.estrategia_respuesta),
  };
  const o = origen(b);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [riesgo] } = await client.query(
      `INSERT INTO riesgos (categoria, descripcion, probabilidad, impacto, estado, estrategia_respuesta)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [datos.categoria, datos.descripcion, datos.probabilidad, datos.impacto, datos.estado, datos.estrategia_respuesta]
    );
    const { rows: [entrada] } = await client.query(
      `INSERT INTO riesgos_historial (riesgo_id, fecha_documento, documento, fragmento, tipo_evento, cambios)
       VALUES ($1,$2,$3,$4,'creacion',$5) RETURNING *`,
      [riesgo.id, o.fecha_documento, o.documento, o.fragmento, JSON.stringify(datos)]
    );
    await client.query('COMMIT');
    res.status(201).json({ riesgo: { ...riesgo, alta_exposicion: riesgo.exposicion >= UMBRAL }, historial: [entrada] });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

externo.get('/riesgos/similares', manejar(async (req, res) => {
  const descripcion = textoObligatorio(req.query.descripcion, 'descripcion');
  const umbral = req.query.umbral !== undefined ? Number(req.query.umbral) : 0.3;
  if (isNaN(umbral) || umbral < 0 || umbral > 1) throw new ErrorValidacion('umbral debe estar entre 0 y 1');
  const incluirCerrados = req.query.incluir_cerrados === 'true';
  const categoria = textoOpcional(req.query.categoria);

  const { rows } = await pool.query(
    `SELECT id, categoria, descripcion, probabilidad, impacto, exposicion, estado, estrategia_respuesta,
            round(similarity(descripcion, $1)::numeric, 3)::float AS similitud
       FROM riesgos
      WHERE similarity(descripcion, $1) >= $2
        AND ($3 OR estado <> 'cerrado')
        AND ($4::text IS NULL OR lower(categoria) = lower($4))
      ORDER BY similitud DESC
      LIMIT 10`,
    [descripcion, umbral, incluirCerrados, categoria]
  );
  res.json({ existe_parecido: rows.length > 0, umbral_similitud: umbral, coincidencias: rows });
}));

externo.post('/riesgos/:id/historial', manejar(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ErrorValidacion('id invalido');
  const b = req.body || {};
  const o = origen(b);
  const tipo = b.tipo_evento ? String(b.tipo_evento).trim().toLowerCase() : 'actualizacion';
  if (!TIPOS_EVENTO.includes(tipo) || tipo === 'creacion') {
    throw new ErrorValidacion('tipo_evento debe ser: mencion, confirmacion o actualizacion');
  }

  const nuevos = {};
  if (b.probabilidad !== undefined) nuevos.probabilidad = nivel(b.probabilidad, 'probabilidad');
  if (b.impacto !== undefined) nuevos.impacto = nivel(b.impacto, 'impacto');
  if (b.estado !== undefined) nuevos.estado = estado(b.estado);
  if (b.estrategia_respuesta !== undefined) nuevos.estrategia_respuesta = textoOpcional(b.estrategia_respuesta);
  if (b.categoria !== undefined) nuevos.categoria = textoObligatorio(b.categoria, 'categoria');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [actual] } = await client.query('SELECT * FROM riesgos WHERE id = $1 FOR UPDATE', [id]);
    if (!actual) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `No existe el riesgo ${id}` });
    }

    const cambios = {};
    for (const [campo, valor] of Object.entries(nuevos)) {
      if (actual[campo] !== valor) cambios[campo] = { antes: actual[campo], despues: valor };
    }

    let riesgo = actual;
    if (Object.keys(cambios).length) {
      const campos = Object.keys(cambios);
      const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
      ({ rows: [riesgo] } = await client.query(
        `UPDATE riesgos SET ${sets}, actualizado_en = now() WHERE id = $1 RETURNING *`,
        [id, ...campos.map((c) => cambios[c].despues)]
      ));
    }

    const { rows: [entrada] } = await client.query(
      `INSERT INTO riesgos_historial (riesgo_id, fecha_documento, documento, fragmento, tipo_evento, cambios)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, o.fecha_documento, o.documento, o.fragmento, tipo, Object.keys(cambios).length ? JSON.stringify(cambios) : null]
    );
    await client.query('COMMIT');
    res.status(201).json({ riesgo: { ...riesgo, alta_exposicion: riesgo.exposicion >= UMBRAL }, entrada_historial: entrada });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

externo.get('/riesgos/alta-exposicion-sin-estrategia', manejar(async (req, res) => {
  const dias = req.query.dias !== undefined ? Number(req.query.dias) : 7;
  if (!Number.isInteger(dias) || dias < 0) throw new ErrorValidacion('dias debe ser un entero mayor o igual a 0');

  const { rows } = await pool.query(
    `SELECT id, categoria, descripcion, probabilidad, impacto, exposicion, estado, creado_en,
            floor(extract(epoch FROM now() - creado_en) / 86400)::int AS dias_sin_estrategia
       FROM riesgos
      WHERE exposicion >= $1
        AND estado <> 'cerrado'
        AND estrategia_respuesta IS NULL
        AND creado_en <= now() - make_interval(days => $2)
      ORDER BY exposicion DESC, creado_en ASC`,
    [UMBRAL, dias]
  );
  res.json({ umbral_alta_exposicion: UMBRAL, dias_minimos: dias, total: rows.length, riesgos: rows });
}));

// ---------- Salud (sin login, para Railway) ----------
app.get('/salud', manejar(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

app.use('/api/externo', externo);

// ---------- Panel y API interna (login) ----------
app.use(exigirLogin);

app.get('/api/interno/config', (req, res) => res.json({ umbral_alta_exposicion: UMBRAL, estados: ESTADOS }));

app.get('/api/interno/categorias', manejar(async (req, res) => {
  const { rows } = await pool.query('SELECT DISTINCT categoria FROM riesgos ORDER BY categoria');
  res.json(rows.map((r) => r.categoria));
}));

app.get('/api/interno/riesgos', manejar(async (req, res) => {
  const categoria = textoOpcional(req.query.categoria);
  const filtroEstado = textoOpcional(req.query.estado) || 'activos';
  const params = [];
  const where = [];
  if (filtroEstado === 'activos') where.push(`estado <> 'cerrado'`);
  else if (filtroEstado !== 'todos') { params.push(estado(filtroEstado)); where.push(`estado = $${params.length}`); }
  if (categoria) { params.push(categoria); where.push(`categoria = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT r.*, (SELECT count(*)::int FROM riesgos_historial h WHERE h.riesgo_id = r.id) AS menciones
       FROM riesgos r
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY exposicion DESC, creado_en ASC`,
    params
  );
  res.json(rows);
}));

app.get('/api/interno/riesgos/:id/historial', manejar(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ErrorValidacion('id invalido');
  const { rows } = await pool.query(
    `SELECT * FROM riesgos_historial WHERE riesgo_id = $1 ORDER BY fecha_documento ASC, registrado_en ASC`,
    [id]
  );
  res.json(rows);
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err instanceof ErrorValidacion) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalido' });
  console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

inicializar()
  .then(() => app.listen(PORT, () => console.log(`Registro de riesgos escuchando en puerto ${PORT} (umbral alta exposicion: ${UMBRAL})`)))
  .catch((e) => {
    console.error('No se pudo inicializar la base de datos:', e);
    process.exit(1);
  });
