const PDFDocument = require('pdfkit');

const ETIQUETA_DIM = { cronograma: 'Cronograma', costo: 'Costo', calidad: 'Calidad', alcance: 'Alcance' };
const ETIQUETA_HALLAZGO = { indefinicion: 'INDEFINICIÓN', inconsistencia: 'INCONSISTENCIA' };

function formatearFecha(iso) {
  if (!iso) return '';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

function textoCambios(cambios) {
  if (!cambios) return '';
  return Object.entries(cambios)
    .map(([k, v]) => (v && typeof v === 'object' && 'despues' in v ? `${k}: ${v.antes ?? '—'} -> ${v.despues ?? '—'}` : `${k}: ${v}`))
    .join('; ');
}

// Genera el PDF directo sobre la respuesta HTTP (streaming), pensado para que un flujo
// externo (n8n) lo adjunte a un correo. El titulo, el encabezado (documento/asunto/fecha)
// y la linea separadora van siempre; el cuerpo detalla cada riesgo, marcando si actualiza
// uno existente y por que (a pedido de Guillermo, 28/09/2026, para que el dueno del
// proyecto pueda archivar el PDF en la carpeta de riesgos de su proyecto y actuar sobre el).
function generarReporteAnalisis(res, datos) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="evaluacion-riesgos.pdf"');
  doc.pipe(res);

  doc.fontSize(18).font('Helvetica-Bold').fillColor('#0b0b0b').text('EVALUACIÓN DE RIESGOS');
  doc.moveDown(0.8);

  doc.fontSize(11);
  doc.font('Helvetica-Bold').text('Documento: ', { continued: true }).font('Helvetica').text(datos.nombreArchivo || '—');
  if (datos.asuntoCorreo) {
    doc.font('Helvetica-Bold').text('Asunto: ', { continued: true }).font('Helvetica').text(datos.asuntoCorreo);
  }
  doc.font('Helvetica-Bold').text('Fecha: ', { continued: true }).font('Helvetica').text(formatearFecha(datos.fechaDocumento));

  doc.moveDown(0.6);
  const y = doc.y;
  doc.moveTo(50, y).lineTo(545, y).lineWidth(1).strokeColor('#888888').stroke();
  doc.moveDown(1);
  doc.strokeColor('#000000');

  const riesgos = Array.isArray(datos.riesgos) ? datos.riesgos : [];
  if (!riesgos.length) {
    doc.fontSize(11).font('Helvetica').fillColor('#000000').text('No se identificaron riesgos en este documento.');
  } else {
    riesgos.forEach((r, i) => {
      if (doc.y > 680) doc.addPage();
      const etiquetaHallazgo = ETIQUETA_HALLAZGO[r.tipo_hallazgo];
      const encabezado = `${i + 1}. ${etiquetaHallazgo ? '[' + etiquetaHallazgo + '] ' : ''}[${r.categoria} · ${r.origen}${r.proyecto ? ' · ' + r.proyecto : ''}] ${r.descripcion}`;
      doc.fontSize(12).font('Helvetica-Bold').fillColor(etiquetaHallazgo ? '#8a4b00' : '#0b0b0b').text(encabezado);

      doc.fontSize(10).font('Helvetica').fillColor('#333333');
      if (r.justificacion_origen) doc.text(`Justificación de origen: ${r.justificacion_origen}`);
      const prob = r.probabilidad == null ? 'pendiente de calificación' : r.probabilidad;
      const dims = Object.keys(ETIQUETA_DIM)
        .map((d) => (r['impacto_' + d] == null ? null : `${ETIQUETA_DIM[d]}: ${r['impacto_' + d]}`))
        .filter(Boolean).join(', ') || 'sin impacto calificado';
      doc.text(`Probabilidad: ${prob}   ·   Impacto: ${dims}`);
      if (r.exposicion_maxima != null) doc.text(`Exposición máxima: ${r.exposicion_maxima}`);

      doc.moveDown(0.2);
      if (r.actualizaRiesgoId) {
        doc.font('Helvetica-Bold').fillColor('#0b0b0b').text(`Actualiza el riesgo existente #${r.actualizaRiesgoId}`);
        doc.font('Helvetica').fillColor('#333333');
        if (r.razonCoincidencia) doc.text(`Motivo de la coincidencia: ${r.razonCoincidencia}`);
        const cambiosTexto = textoCambios(r.cambios);
        doc.text(cambiosTexto
          ? `Cambios registrados: ${cambiosTexto}`
          : 'Sin cambios en probabilidad o impacto respecto del registro previo (se agregó como nueva mención).');
      } else {
        doc.font('Helvetica-Bold').fillColor('#0b0b0b').text('Riesgo nuevo');
        doc.font('Helvetica').fillColor('#333333');
      }

      doc.moveDown(0.2);
      doc.font('Helvetica-Oblique').text(`Fragmento: "${r.fragmento}"`);
      doc.font('Helvetica').fillColor('#000000');
      doc.moveDown(0.9);
    });
  }

  doc.end();
}

module.exports = { generarReporteAnalisis };
