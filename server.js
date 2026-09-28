const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { pool, inicializar } = require('./db');
const { generarReporteAnalisis } = require('./pdf');

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
const DIMENSIONES = ['cronograma', 'costo', 'calidad', 'alcance'];
const ORIGENES = ['interno', 'externo'];
const TIPOS_HALLAZGO = ['riesgo', 'indefinicion', 'inconsistencia'];

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

// null/ausente = "pendiente de calificacion humana": nunca se inventa un numero.
function nivelOpcional(valor, campo) {
  if (valor === undefined || valor === null) return null;
  return nivel(valor, campo);
}

function estado(valor) {
  const e = String(valor).trim().toLowerCase().replace(/\s+/g, '_');
  if (!ESTADOS.includes(e)) throw new ErrorValidacion(`estado debe ser uno de: ${ESTADOS.join(', ')}`);
  return e;
}

function origenRiesgo(valor) {
  const o = String(valor || '').trim().toLowerCase();
  if (!ORIGENES.includes(o)) throw new ErrorValidacion(`origen debe ser uno de: ${ORIGENES.join(', ')}`);
  return o;
}

function tipoHallazgo(valor) {
  const t = String(valor || 'riesgo').trim().toLowerCase();
  if (!TIPOS_HALLAZGO.includes(t)) throw new ErrorValidacion(`tipo_hallazgo debe ser uno de: ${TIPOS_HALLAZGO.join(', ')}`);
  return t;
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

// Datos del documento de origen que sustenta la creacion o la mencion de un riesgo
// (distinto del campo 'origen' del riesgo, que es interno/externo).
function origenDocumento(body) {
  return {
    documento: textoObligatorio(body.documento, 'documento'),
    fecha_documento: normalizarFecha(body.fecha_documento),
    fragmento: textoObligatorio(body.fragmento, 'fragmento'),
    nota: textoOpcional(body.nota),
  };
}

function conPendiente(riesgo) {
  const exposiciones = DIMENSIONES
    .map((d) => riesgo[`exposicion_${d}`])
    .filter((v) => v !== null && v !== undefined);
  const exposicion_maxima = exposiciones.length ? Math.max(...exposiciones) : null;
  const hayAlgunImpacto = DIMENSIONES.some((d) => riesgo[`impacto_${d}`] !== null && riesgo[`impacto_${d}`] !== undefined);
  return {
    ...riesgo,
    exposicion_maxima,
    alta_exposicion: exposicion_maxima !== null && exposicion_maxima >= UMBRAL,
    pendiente_calificacion: riesgo.probabilidad === null || riesgo.probabilidad === undefined || !hayAlgunImpacto,
  };
}

const manejar = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const CAMPOS_IMPACTO = Object.fromEntries(DIMENSIONES.map((d) => [`impacto_${d}`, d]));

function leerDatosRiesgo(b, { requerido }) {
  const datos = {};
  if (requerido || b.categoria !== undefined) datos.categoria = textoObligatorio(b.categoria, 'categoria');
  if (requerido || b.origen !== undefined) datos.origen = origenRiesgo(b.origen);
  if (b.justificacion_origen !== undefined) datos.justificacion_origen = textoOpcional(b.justificacion_origen);
  if (requerido || b.tipo_hallazgo !== undefined) datos.tipo_hallazgo = tipoHallazgo(b.tipo_hallazgo);
  if (b.proyecto !== undefined) datos.proyecto = textoOpcional(b.proyecto);
  if (requerido || b.descripcion !== undefined) datos.descripcion = textoObligatorio(b.descripcion, 'descripcion');
  if (requerido || b.probabilidad !== undefined) datos.probabilidad = nivelOpcional(b.probabilidad, 'probabilidad');
  for (const campo of Object.keys(CAMPOS_IMPACTO)) {
    if (requerido || b[campo] !== undefined) datos[campo] = nivelOpcional(b[campo], campo);
  }
  if (b.estado !== undefined) datos.estado = estado(b.estado);
  else if (requerido) datos.estado = 'abierto';
  if (b.estrategia_respuesta !== undefined) datos.estrategia_respuesta = textoOpcional(b.estrategia_respuesta);
  return datos;
}

// ---------- API externa (clave) ----------
const externo = express.Router();
externo.use(exigirClave);

externo.post('/riesgos', manejar(async (req, res) => {
  const b = req.body || {};
  const datos = leerDatosRiesgo(b, { requerido: true });
  const o = origenDocumento(b);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [riesgo] } = await client.query(
      `INSERT INTO riesgos (categoria, origen, justificacion_origen, tipo_hallazgo, proyecto, descripcion, probabilidad, impacto_cronograma, impacto_costo, impacto_calidad, impacto_alcance, estado, estrategia_respuesta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [datos.categoria, datos.origen, datos.justificacion_origen || null, datos.tipo_hallazgo, datos.proyecto || null, datos.descripcion, datos.probabilidad, datos.impacto_cronograma, datos.impacto_costo, datos.impacto_calidad, datos.impacto_alcance, datos.estado, datos.estrategia_respuesta]
    );
    const { rows: [entrada] } = await client.query(
      `INSERT INTO riesgos_historial (riesgo_id, fecha_documento, documento, fragmento, tipo_evento, cambios, nota)
       VALUES ($1,$2,$3,$4,'creacion',$5,$6) RETURNING *`,
      [riesgo.id, o.fecha_documento, o.documento, o.fragmento, JSON.stringify(datos), o.nota]
    );
    await client.query('COMMIT');
    res.status(201).json({ riesgo: conPendiente(riesgo), historial: [entrada] });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// Lista de riesgos activos (o todos), pensada para que un sistema externo (ej. n8n)
// se la muestre completa a un modelo de IA y le pida comparar por significado si
// el riesgo nuevo ya existe. No filtra por similitud de texto a proposito.
externo.get('/riesgos', manejar(async (req, res) => {
  const filtroEstado = textoOpcional(req.query.estado) || 'activos';
  const proyecto = textoOpcional(req.query.proyecto);
  const params = [];
  const where = [];
  if (filtroEstado === 'activos') where.push(`estado <> 'cerrado'`);
  else if (filtroEstado !== 'todos') { params.push(estado(filtroEstado)); where.push(`estado = $${params.length}`); }
  if (proyecto) { params.push(proyecto); where.push(`proyecto = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT * FROM riesgos ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY creado_en ASC`,
    params
  );
  res.json({ total: rows.length, riesgos: rows.map(conPendiente) });
}));

// Riesgos (nuevos o actualizados) que quedaron con al menos una mencion proveniente de
// este documento exacto. Pensado para que, despues de procesar un documento, un flujo
// externo pueda armar un reporte de "que paso con esto que te mande" sin tener que
// llevar el estado por su cuenta durante el procesamiento.
externo.get('/riesgos/por-documento', manejar(async (req, res) => {
  const documento = textoObligatorio(req.query.documento, 'documento');
  const { rows } = await pool.query(
    `SELECT r.*,
            (SELECT json_agg(json_build_object('fecha_documento', h.fecha_documento, 'fragmento', h.fragmento, 'tipo_evento', h.tipo_evento, 'cambios', h.cambios, 'nota', h.nota) ORDER BY h.registrado_en)
               FROM riesgos_historial h WHERE h.riesgo_id = r.id AND h.documento = $1) AS entradas
       FROM riesgos r
      WHERE EXISTS (SELECT 1 FROM riesgos_historial h WHERE h.riesgo_id = r.id AND h.documento = $1)
      ORDER BY r.id ASC`,
    [documento]
  );
  res.json({ documento, total: rows.length, riesgos: rows.map(conPendiente) });
}));

externo.get('/riesgos/similares', manejar(async (req, res) => {
  const descripcion = textoObligatorio(req.query.descripcion, 'descripcion');
  const umbral = req.query.umbral !== undefined ? Number(req.query.umbral) : 0.3;
  if (isNaN(umbral) || umbral < 0 || umbral > 1) throw new ErrorValidacion('umbral debe estar entre 0 y 1');
  const incluirCerrados = req.query.incluir_cerrados === 'true';
  const categoria = textoOpcional(req.query.categoria);

  const { rows } = await pool.query(
    `SELECT *, round(similarity(descripcion, $1)::numeric, 3)::float AS similitud
       FROM riesgos
      WHERE similarity(descripcion, $1) >= $2
        AND ($3 OR estado <> 'cerrado')
        AND ($4::text IS NULL OR lower(categoria) = lower($4))
      ORDER BY similitud DESC
      LIMIT 10`,
    [descripcion, umbral, incluirCerrados, categoria]
  );
  res.json({ existe_parecido: rows.length > 0, umbral_similitud: umbral, coincidencias: rows.map(conPendiente) });
}));

externo.post('/riesgos/:id/historial', manejar(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ErrorValidacion('id invalido');
  const b = req.body || {};
  const o = origenDocumento(b);
  const tipo = b.tipo_evento ? String(b.tipo_evento).trim().toLowerCase() : 'actualizacion';
  if (!TIPOS_EVENTO.includes(tipo) || tipo === 'creacion') {
    throw new ErrorValidacion('tipo_evento debe ser: mencion, confirmacion o actualizacion');
  }

  const nuevos = leerDatosRiesgo(b, { requerido: false });

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
      `INSERT INTO riesgos_historial (riesgo_id, fecha_documento, documento, fragmento, tipo_evento, cambios, nota)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, o.fecha_documento, o.documento, o.fragmento, tipo, Object.keys(cambios).length ? JSON.stringify(cambios) : null, o.nota]
    );
    await client.query('COMMIT');
    res.status(201).json({ riesgo: conPendiente(riesgo), entrada_historial: entrada });
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
    `SELECT *, GREATEST(exposicion_cronograma, exposicion_costo, exposicion_calidad, exposicion_alcance) AS exposicion_maxima,
            floor(extract(epoch FROM now() - creado_en) / 86400)::int AS dias_sin_estrategia
       FROM riesgos
      WHERE GREATEST(exposicion_cronograma, exposicion_costo, exposicion_calidad, exposicion_alcance) >= $1
        AND estado <> 'cerrado'
        AND estrategia_respuesta IS NULL
        AND creado_en <= now() - make_interval(days => $2)
      ORDER BY exposicion_maxima DESC, creado_en ASC`,
    [UMBRAL, dias]
  );
  res.json({ umbral_alta_exposicion: UMBRAL, dias_minimos: dias, total: rows.length, riesgos: rows });
}));

// Genera el PDF de evaluacion de riesgos de un documento (titulo, documento/asunto/fecha,
// linea separadora, y el detalle de cada riesgo, marcando si actualiza uno existente).
// No toca la base de datos: solo renderiza lo que el flujo externo ya resolvio.
externo.post('/reportes/analisis-documento', manejar(async (req, res) => {
  const b = req.body || {};
  const nombreArchivo = textoObligatorio(b.nombreArchivo, 'nombreArchivo');
  const fechaDocumento = normalizarFecha(b.fechaDocumento);
  const asuntoCorreo = textoOpcional(b.asuntoCorreo);
  const riesgos = Array.isArray(b.riesgos) ? b.riesgos : [];
  generarReporteAnalisis(res, { nombreArchivo, fechaDocumento, asuntoCorreo, riesgos });
}));

// ---------- Salud (sin login, para Railway) ----------
app.get('/salud', manejar(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

app.use('/api/externo', externo);

// ---------- Panel y API interna (login) ----------
app.use(exigirLogin);

app.get('/api/interno/config', manejar(async (req, res) => {
  const { rows: [config] } = await pool.query('SELECT orden_prioridad FROM configuracion_registro WHERE id = 1');
  res.json({
    umbral_alta_exposicion: UMBRAL,
    estados: ESTADOS,
    dimensiones: DIMENSIONES,
    origenes: ORIGENES,
    orden_prioridad: config.orden_prioridad,
  });
}));

app.post('/api/interno/config/orden-prioridad', manejar(async (req, res) => {
  const orden = (req.body || {}).orden;
  const valido = Array.isArray(orden) && orden.length === DIMENSIONES.length
    && new Set(orden).size === DIMENSIONES.length
    && orden.every((d) => DIMENSIONES.includes(d));
  if (!valido) throw new ErrorValidacion(`orden debe ser un arreglo con exactamente estas 4 dimensiones, sin repetir: ${DIMENSIONES.join(', ')}`);
  await pool.query('UPDATE configuracion_registro SET orden_prioridad = $1 WHERE id = 1', [orden]);
  res.json({ orden_prioridad: orden });
}));

app.get('/api/interno/categorias', manejar(async (req, res) => {
  const { rows } = await pool.query('SELECT DISTINCT categoria FROM riesgos ORDER BY categoria');
  res.json(rows.map((r) => r.categoria));
}));

app.get('/api/interno/proyectos', manejar(async (req, res) => {
  const { rows } = await pool.query('SELECT DISTINCT proyecto FROM riesgos WHERE proyecto IS NOT NULL ORDER BY proyecto');
  res.json(rows.map((r) => r.proyecto));
}));

app.get('/api/interno/riesgos', manejar(async (req, res) => {
  const categoria = textoOpcional(req.query.categoria);
  const origenFiltro = textoOpcional(req.query.origen);
  const proyectoFiltro = textoOpcional(req.query.proyecto);
  const filtroEstado = textoOpcional(req.query.estado) || 'activos';
  const params = [];
  const where = [];
  if (filtroEstado === 'activos') where.push(`estado <> 'cerrado'`);
  else if (filtroEstado !== 'todos') { params.push(estado(filtroEstado)); where.push(`estado = $${params.length}`); }
  if (categoria) { params.push(categoria); where.push(`categoria = $${params.length}`); }
  if (origenFiltro && origenFiltro !== 'todos') { params.push(origenRiesgo(origenFiltro)); where.push(`origen = $${params.length}`); }
  if (proyectoFiltro && proyectoFiltro !== 'todos') { params.push(proyectoFiltro); where.push(`proyecto = $${params.length}`); }

  const { rows: [config] } = await pool.query('SELECT orden_prioridad FROM configuracion_registro WHERE id = 1');
  const ordenValido = (config.orden_prioridad || []).filter((d) => DIMENSIONES.includes(d));
  const ordenCompleto = [...ordenValido, ...DIMENSIONES.filter((d) => !ordenValido.includes(d))];
  const ordenSql = ordenCompleto.map((d) => `exposicion_${d} DESC NULLS LAST`).join(', ');

  const { rows } = await pool.query(
    `SELECT r.*, (SELECT count(*)::int FROM riesgos_historial h WHERE h.riesgo_id = r.id) AS menciones
       FROM riesgos r
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${ordenSql}, creado_en ASC`,
    params
  );
  res.json({ orden_prioridad: ordenCompleto, riesgos: rows.map(conPendiente) });
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
