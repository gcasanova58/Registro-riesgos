const $ = (id) => document.getElementById(id);
let UMBRAL = 15;

const ETIQUETA_ESTADO = { abierto: 'Abierto', en_respuesta: 'En respuesta', cerrado: 'Cerrado' };
const ETIQUETA_EVENTO = { creacion: 'Origen', mencion: 'Mención', confirmacion: 'Confirmación', actualizacion: 'Actualización' };

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

async function api(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`Error ${r.status} al consultar ${url}`);
  return r.json();
}

function sinEstrategia(r) {
  return r.estado === 'abierto' && !r.estrategia_respuesta;
}

function pintarResumen(riesgos) {
  const altas = riesgos.filter((r) => r.exposicion >= UMBRAL && r.estado !== 'cerrado').length;
  const sinEst = riesgos.filter(sinEstrategia).length;
  const tiles = [
    [riesgos.length, 'Riesgos en la vista'],
    [altas, `Alta exposición (≥ ${UMBRAL})`],
    [sinEst, 'Abiertos sin estrategia'],
  ];
  $('resumen').innerHTML = tiles
    .map(([v, l]) => `<div class="tile"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`)
    .join('');
}

function fila(r) {
  const alta = r.exposicion >= UMBRAL;
  const badges = [
    alta ? '<span class="badge critico">▲ Alta exposición</span>' : '',
    sinEstrategia(r) ? '<span class="badge aviso">! Sin estrategia</span>' : '',
  ].join('');
  return `
    <tr class="${alta ? 'alta' : ''}" data-id="${r.id}">
      <td class="num">${r.id}</td>
      <td>${esc(r.categoria)}</td>
      <td class="desc">${badges ? badges + '<br>' : ''}${esc(r.descripcion)}</td>
      <td class="num">${r.probabilidad}</td>
      <td class="num">${r.impacto}</td>
      <td class="num expo">${r.exposicion}</td>
      <td><span class="badge est-${r.estado}">${ETIQUETA_ESTADO[r.estado]}</span></td>
      <td class="estr">${r.estrategia_respuesta ? esc(r.estrategia_respuesta) : '<span class="vacio">Sin definir</span>'}</td>
      <td class="num"><button class="hist" data-id="${r.id}" aria-expanded="false">Ver (${r.menciones})</button></td>
    </tr>`;
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
  const tr = btn.closest('tr');
  const sig = tr.nextElementSibling;
  if (sig && sig.classList.contains('detalle')) {
    sig.remove();
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  btn.setAttribute('aria-expanded', 'true');
  const det = document.createElement('tr');
  det.className = 'detalle';
  det.innerHTML = '<td colspan="9">Cargando historial…</td>';
  tr.after(det);
  try {
    const items = await api(`/api/interno/riesgos/${btn.dataset.id}/historial`);
    det.innerHTML = `<td colspan="9"><ul class="historial">${items.map((h) => `
      <li>
        <div class="meta"><b>${ETIQUETA_EVENTO[h.tipo_evento] || esc(h.tipo_evento)}</b> · ${fecha(h.fecha_documento)} · ${esc(h.documento)}</div>
        <blockquote>${esc(h.fragmento)}</blockquote>
        ${h.cambios && h.tipo_evento !== 'creacion' ? `<div class="cambios">Cambios: ${esc(textoCambios(h.cambios))}</div>` : ''}
      </li>`).join('')}</ul></td>`;
  } catch (e) {
    det.innerHTML = `<td colspan="9">${esc(e.message)}</td>`;
  }
}

async function cargar() {
  const params = new URLSearchParams();
  if ($('f-categoria').value) params.set('categoria', $('f-categoria').value);
  params.set('estado', $('f-estado').value);
  $('mensaje').textContent = '';
  try {
    const riesgos = await api(`/api/interno/riesgos?${params}`);
    pintarResumen(riesgos);
    $('cuerpo').innerHTML = riesgos.map(fila).join('');
    if (!riesgos.length) $('mensaje').textContent = 'No hay riesgos para los filtros seleccionados.';
  } catch (e) {
    $('mensaje').textContent = `No se pudo cargar el registro: ${e.message}`;
  }
}

async function iniciar() {
  try {
    const [config, categorias] = await Promise.all([api('/api/interno/config'), api('/api/interno/categorias')]);
    UMBRAL = config.umbral_alta_exposicion;
    $('umbral').textContent = UMBRAL;
    $('f-categoria').innerHTML += categorias.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  } catch (e) {
    $('mensaje').textContent = `No se pudo cargar la configuración: ${e.message}`;
  }
  $('f-categoria').addEventListener('change', cargar);
  $('f-estado').addEventListener('change', cargar);
  $('cuerpo').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button.hist');
    if (btn) alternarHistorial(btn);
  });
  cargar();
}

iniciar();
