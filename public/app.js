const $ = (id) => document.getElementById(id);
let UMBRAL = 15;
let ORDEN_PRIORIDAD = ['cronograma', 'costo', 'calidad', 'alcance'];

const ETIQUETA_ESTADO = { abierto: 'Abierto', en_respuesta: 'En respuesta', cerrado: 'Cerrado' };
const ETIQUETA_EVENTO = { creacion: 'Origen', mencion: 'Mención', confirmacion: 'Confirmación', actualizacion: 'Actualización' };
const ETIQUETA_DIMENSION = { cronograma: 'Cronograma', costo: 'Costo', calidad: 'Calidad', alcance: 'Alcance' };
const ETIQUETA_HALLAZGO = { indefinicion: 'Indefinición', inconsistencia: 'Inconsistencia' };

function esc(t) {
  const d = document.createElement('div');
  d.textContent = t == null ? '' : String(t);
  return d.innerHTML.replace(/"/g, '&quot;');
}

function fecha(iso) {
  if (!iso) return '';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

async function api(url, opciones) {
  const r = await fetch(url, { credentials: 'same-origin', ...opciones });
  if (!r.ok) throw new Error(`Error ${r.status} al consultar ${url}`);
  return r.json();
}

function sinEstrategia(r) {
  return r.estado === 'abierto' && !r.estrategia_respuesta;
}

function pintarResumen(riesgos) {
  const altas = riesgos.filter((r) => r.alta_exposicion && r.estado !== 'cerrado').length;
  const sinEst = riesgos.filter(sinEstrategia).length;
  const pendientes = riesgos.filter((r) => r.pendiente_calificacion).length;
  const externos = riesgos.filter((r) => r.origen === 'externo').length;
  const tiles = [
    [riesgos.length, 'Riesgos en vista'],
    [altas, `Alta exposición (≥ ${UMBRAL})`],
    [sinEst, 'Sin estrategia'],
    [pendientes, 'Pendientes de calificar'],
    [externos, 'Externos (solo contener)'],
  ];
  $('resumen').innerHTML = tiles
    .map(([v, l]) => `<div class="tile"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`)
    .join('');
}

function pintarPrioridad() {
  $('prioridad-botones').innerHTML = ORDEN_PRIORIDAD.map((dim, i) => `
    <button class="prioridad-btn" data-dim="${dim}" ${i === 0 ? 'disabled' : ''}>
      <span class="rango">${i + 1}º</span> ${ETIQUETA_DIMENSION[dim]} <span class="subir">▲</span>
    </button>`).join('');
}

async function subirPrioridad(dim) {
  const i = ORDEN_PRIORIDAD.indexOf(dim);
  if (i <= 0) return;
  [ORDEN_PRIORIDAD[i - 1], ORDEN_PRIORIDAD[i]] = [ORDEN_PRIORIDAD[i], ORDEN_PRIORIDAD[i - 1]];
  pintarPrioridad();
  try {
    await api('/api/interno/config/orden-prioridad', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orden: ORDEN_PRIORIDAD }),
    });
  } catch (e) {
    $('mensaje').textContent = `No se pudo guardar el orden de prioridad: ${e.message}`;
  }
  cargar();
}

function badgeDimension(r, dim) {
  const exp = r[`exposicion_${dim}`];
  const alta = exp != null && exp >= UMBRAL;
  return `<div class="dim ${alta ? 'dim-alta' : ''}"><div class="dim-nombre">${ETIQUETA_DIMENSION[dim]}</div><div class="dim-valor">${exp == null ? '—' : exp}</div></div>`;
}

function tarjeta(r) {
  const badges = [
    r.alta_exposicion ? '<span class="badge critico">▲ Alta exposición</span>' : '',
    sinEstrategia(r) ? '<span class="badge aviso">! Sin estrategia</span>' : '',
    r.pendiente_calificacion ? '<span class="badge pendiente">? Pendiente de calificación</span>' : '',
    ETIQUETA_HALLAZGO[r.tipo_hallazgo] ? `<span class="badge hallazgo">${ETIQUETA_HALLAZGO[r.tipo_hallazgo]}</span>` : '',
  ].join('');
  const expMax = r.exposicion_maxima == null ? '—' : r.exposicion_maxima;
  return `
    <article class="tarjeta ${r.alta_exposicion ? 'alta' : ''}" data-id="${r.id}">
      <div class="tarjeta-exp"><div class="exp-num">${expMax}</div><div class="exp-label">Exp. máx</div></div>
      <div class="tarjeta-cuerpo">
        <p class="tarjeta-titulo">${esc(r.descripcion)}</p>
        <p class="tarjeta-sub">${esc(r.categoria)} · ${esc(r.origen)}${r.proyecto ? ' · ' + esc(r.proyecto) : ''} · probabilidad ${r.probabilidad == null ? '—' : r.probabilidad} · <button class="hist" data-id="${r.id}" aria-expanded="false">${r.menciones} mención(es)</button></p>
        ${r.justificacion_origen ? `<p class="tarjeta-justificacion"><b>Justificación de origen:</b> ${esc(r.justificacion_origen)}</p>` : ''}
        <div class="dims">${ORDEN_PRIORIDAD.map((d) => badgeDimension(r, d)).join('')}</div>
        <div class="tarjeta-badges">
          <span class="badge est-${r.estado}">${ETIQUETA_ESTADO[r.estado]}</span>
          ${badges}
        </div>
        ${r.estrategia_respuesta ? `<p class="tarjeta-estrategia"><b>Estrategia:</b> ${esc(r.estrategia_respuesta)}</p>` : ''}
      </div>
    </article>`;
}

function textoCambios(c) {
  if (!c) return '';
  return Object.entries(c)
    .map(([k, v]) => (v && typeof v === 'object' && 'despues' in v
      ? `${k}: ${v.antes ?? '—'} → ${v.despues ?? '—'}`
      : `${k}: ${v ?? '—'}`))
    .join(' · ');
}

async function alternarHistorial(btn) {
  const tarjetaEl = btn.closest('.tarjeta');
  const existente = tarjetaEl.querySelector('.historial-panel');
  if (existente) { existente.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
  btn.setAttribute('aria-expanded', 'true');
  const panel = document.createElement('div');
  panel.className = 'historial-panel';
  panel.textContent = 'Cargando historial…';
  tarjetaEl.querySelector('.tarjeta-cuerpo').appendChild(panel);
  try {
    const items = await api(`/api/interno/riesgos/${btn.dataset.id}/historial`);
    panel.innerHTML = `<ul class="historial">${items.map((h) => `
      <li>
        <div class="meta"><b>${ETIQUETA_EVENTO[h.tipo_evento] || esc(h.tipo_evento)}</b> · ${fecha(h.fecha_documento)} · ${esc(h.documento)}</div>
        <blockquote>${esc(h.fragmento)}</blockquote>
        ${h.cambios && h.tipo_evento !== 'creacion' ? `<div class="cambios">Cambios: ${esc(textoCambios(h.cambios))}</div>` : ''}
      </li>`).join('')}</ul>`;
  } catch (e) {
    panel.textContent = e.message;
  }
}

async function cargar() {
  const params = new URLSearchParams();
  if ($('f-categoria').value) params.set('categoria', $('f-categoria').value);
  if ($('f-origen').value) params.set('origen', $('f-origen').value);
  if ($('f-proyecto').value) params.set('proyecto', $('f-proyecto').value);
  params.set('estado', $('f-estado').value);
  $('mensaje').textContent = '';
  try {
    const { orden_prioridad, riesgos } = await api(`/api/interno/riesgos?${params}`);
    if (orden_prioridad) { ORDEN_PRIORIDAD = orden_prioridad; pintarPrioridad(); }
    pintarResumen(riesgos);
    $('lista').innerHTML = riesgos.map(tarjeta).join('');
    if (!riesgos.length) $('mensaje').textContent = 'No hay riesgos para los filtros seleccionados.';
  } catch (e) {
    $('mensaje').textContent = `No se pudo cargar el registro: ${e.message}`;
  }
}

async function iniciar() {
  try {
    const [config, categorias, proyectos] = await Promise.all([api('/api/interno/config'), api('/api/interno/categorias'), api('/api/interno/proyectos')]);
    UMBRAL = config.umbral_alta_exposicion;
    ORDEN_PRIORIDAD = config.orden_prioridad;
    $('umbral').textContent = UMBRAL;
    $('f-categoria').innerHTML += categorias.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    $('f-proyecto').innerHTML += proyectos.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    pintarPrioridad();
  } catch (e) {
    $('mensaje').textContent = `No se pudo cargar la configuración: ${e.message}`;
  }
  $('f-categoria').addEventListener('change', cargar);
  $('f-origen').addEventListener('change', cargar);
  $('f-proyecto').addEventListener('change', cargar);
  $('f-estado').addEventListener('change', cargar);
  $('prioridad-botones').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button.prioridad-btn');
    if (btn && !btn.disabled) subirPrioridad(btn.dataset.dim);
  });
  $('lista').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button.hist');
    if (btn) alternarHistorial(btn);
  });
  cargar();
}

iniciar();
