# Registro de Riesgos — GECON SPA

Panel web para el registro inteligente de riesgos de proyecto. Muestra los riesgos activos ordenados por exposición y guarda un historial completo e inmutable de cada mención o actualización, con la fecha del documento de origen y el fragmento de texto exacto. Expone además una API protegida por clave para que un sistema externo (por ejemplo, un flujo de n8n que procese actas o correos) registre y consulte riesgos automáticamente.

Aplicación fuera de N8N, desplegada en Railway. Los datos viven en una base PostgreSQL propia, también en Railway — nunca en memoria del servidor ni en el navegador.

## Acceso

- **Panel:** https://registro-riesgos-production-772b.up.railway.app
- **Usuario del panel:** `gecon`
- **Clave del panel y del endpoint:** en Railway → proyecto `Registro-de-Riesgos` → servicio `registro-riesgos` → pestaña **Variables** (`DASHBOARD_PASSWORD` y `API_KEY`). No están escritas en este repositorio ni en ningún archivo del proyecto.

Una **variable de entorno** es un dato de configuración (una clave, una contraseña, una URL) que se guarda fuera del código, en la plataforma donde corre la aplicación. Así, aunque alguien vea el código, no ve las claves.

## Qué muestra el panel

Cada riesgo aparece con: categoría, origen (interno/externo) con su justificación, proyecto, descripción, probabilidad, un impacto y una exposición **por cada dimensión del proyecto** (cronograma, costo, calidad, alcance), estado (`abierto`, `en_respuesta`, `cerrado`) y estrategia de respuesta.

- **Tipo de hallazgo:** no todo lo detectado es un riesgo explícito. `tipo_hallazgo` distingue `riesgo` (el caso normal), `indefinicion` (lenguaje vago del documento que en ejecución se presta para interpretarse a conveniencia) e `inconsistencia` (el documento se contradice a sí mismo). Metodología del material de capacitación de Guillermo (PIS Módulo 2, 28/09/2026). Se marca con una etiqueta de color en el panel.
- **Justificación de origen:** `justificacion_origen` explica por qué un riesgo se clasificó interno o externo, en particular cuando el riesgo se redujo primero a su nivel accionable (ej.: "la arena se moja por falta de cobertura" es interno porque cubrirla está en manos del proyecto, aunque la lluvia en sí sea externa).

- **Por qué el impacto es por dimensión, no un solo número:** no todas las organizaciones ni todos los proyectos le dan el mismo peso a plazo, costo, calidad o alcance. Un mismo riesgo puede ser gravísimo para el cronograma y casi irrelevante para el costo. Fue una decisión explícita de Guillermo (28/09/2026), a partir de un ejemplo de su mentor.
- **Escala:** probabilidad (una sola por riesgo) e impacto (uno por dimensión) van de 1 a 5. La exposición de cada dimensión es probabilidad × ese impacto (1 a 25). "Alta exposición" se marca si **cualquiera** de las cuatro supera el umbral.
- **Umbral de alta exposición:** 15. Se cambia en la variable `UMBRAL_ALTA_EXPOSICION`, sin tocar código.
- **Prioridad del proyecto:** un orden configurable de las cuatro dimensiones (botones "1º, 2º, 3º, 4º" en el panel). El registro se ordena por la exposición de la dimensión en primer lugar; los empates los rompe la segunda, y así. Es una sola configuración para todo el registro — hoy la aplicación no distingue entre varios proyectos.
- **Aviso "sin estrategia":** se marca en amarillo todo riesgo `abierto` que no tiene estrategia de respuesta definida.
- **Pendiente de calificación humana:** si quien registra el riesgo (por ejemplo, un flujo de n8n con IA) no tiene evidencia suficiente para asignar probabilidad o algún impacto, puede omitir esos campos en vez de inventar un número. Un riesgo puede tener impacto calificado en algunas dimensiones y pendiente en otras (se muestra "—").
- **Filtros:** por categoría, por origen y por estado.
- **Historial:** el botón de menciones despliega cada documento donde el riesgo fue mencionado o actualizado, con su fecha y el fragmento de texto exacto. Este historial no se puede editar ni borrar — la propia base de datos lo rechaza, incluso si alguien entra directo a ella.

## API externa

Pensada para que un sistema externo (n8n, por ejemplo) registre y consulte riesgos sin pasar por el panel. Toda llamada requiere el header `x-api-key` con la clave de `API_KEY`.

Base: `https://registro-riesgos-production-772b.up.railway.app/api/externo`

| Acción | Método y ruta | Cuerpo / parámetros |
|---|---|---|
| Registrar un riesgo nuevo | `POST /riesgos` | `categoria`, `origen` (`interno` o `externo`), `justificacion_origen` (opcional), `tipo_hallazgo` (opcional, `riesgo`/`indefinicion`/`inconsistencia`, por defecto `riesgo`), `proyecto` (opcional), `descripcion`, `probabilidad` (1-5, **opcional**), `impacto_cronograma`, `impacto_costo`, `impacto_calidad`, `impacto_alcance` (cada uno 1-5, **opcional e independiente**), `estado` (opcional, por defecto `abierto`), `estrategia_respuesta` (opcional), y el origen del dato: `documento`, `fecha_documento` (`dd/mm/aaaa` o `aaaa-mm-dd`), `fragmento` |
| Listar riesgos activos (para que un modelo de IA compare significados, no palabras) | `GET /riesgos` | opcional: `estado` (`activos` por defecto, o `todos`), `proyecto` (acota la comparación de duplicados al mismo proyecto) |
| Consultar si ya existe uno parecido por texto | `GET /riesgos/similares?descripcion=...` | opcional: `categoria`, `umbral` (0 a 1, por defecto 0.3), `incluir_cerrados` (`true`/`false`) |
| Actualizar el historial de un riesgo existente | `POST /riesgos/{id}/historial` | `documento`, `fecha_documento`, `fragmento`, `tipo_evento` (`mencion`, `confirmacion` o `actualizacion`), y opcionalmente los campos que cambiaron: `categoria`, `origen`, `justificacion_origen`, `tipo_hallazgo`, `proyecto`, `probabilidad`, `impacto_cronograma`, `impacto_costo`, `impacto_calidad`, `impacto_alcance`, `estado`, `estrategia_respuesta` |
| Riesgos de alta exposición sin estrategia hace tiempo | `GET /riesgos/alta-exposicion-sin-estrategia?dias=N` | `dias`: mínimo de días sin estrategia (por defecto 7) |
| Riesgos (nuevos o actualizados) con al menos una mención de un documento exacto | `GET /riesgos/por-documento?documento=...` | Pensado para que, tras procesar un documento, un flujo externo arme un reporte de "qué pasó con esto que te mandé" sin llevar el estado por su cuenta |
| Generar el PDF de evaluación de riesgos de un documento | `POST /reportes/analisis-documento` | `nombreArchivo`, `fechaDocumento`, `asuntoCorreo` (opcional), `riesgos` (arreglo ya resuelto por el flujo externo). No toca la base de datos, solo renderiza. Responde con el PDF (`application/pdf`) |

Si `probabilidad` o cualquier `impacto_*` se omite (o se envía como `null`), esa parte queda "pendiente de calificación humana": nunca se inventa un número. La respuesta de estas rutas incluye por cada riesgo `exposicion_maxima`, `alta_exposicion` y `pendiente_calificacion`.

Ejemplo:

```bash
curl -X POST https://registro-riesgos-production-772b.up.railway.app/api/externo/riesgos \
  -H "x-api-key: LA_CLAVE" -H "Content-Type: application/json" \
  -d '{
    "categoria": "proveedor", "origen": "externo",
    "descripcion": "Retraso en la entrega del polipasto por parte del proveedor",
    "probabilidad": 5, "impacto_cronograma": 4, "impacto_costo": 3,
    "documento": "Acta reunion 01", "fecha_documento": "15/09/2026",
    "fragmento": "El proveedor indico que el polipasto llegaria con tres semanas de atraso."
  }'
```

**Nota sobre "días sin estrategia":** se cuentan desde la fecha en que el riesgo se registró en este sistema, no desde la fecha del documento que lo originó.

**Nota sobre "parecido" (`GET /riesgos/similares`):** compara el texto de la descripción por similitud de caracteres, no de significado. El flujo de detección automática de riesgos **no usa este endpoint** para decidir duplicados — trae la lista completa con `GET /riesgos` y le pide a un modelo de IA que compare por significado, como pidió Guillermo explícitamente. Este endpoint queda disponible para otros usos futuros.

## Variables de entorno del servicio `registro-riesgos`

| Variable | Para qué sirve |
|---|---|
| `DATABASE_URL` | Conexión a la base PostgreSQL (la arma Railway solo, referenciando el servicio `Postgres`) |
| `API_KEY` | Clave que debe enviar cualquier sistema externo en el header `x-api-key` |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | Usuario y clave para entrar al panel |
| `UMBRAL_ALTA_EXPOSICION` | Exposición mínima para marcar un riesgo en rojo (por defecto 15) |

## Estructura del proyecto

```
server.js        Rutas del panel, API interna y API externa
db.js             Conexión a PostgreSQL y esquema (se crea solo al arrancar)
pdf.js            Genera el PDF de evaluación de riesgos (librería pdfkit), sin tocar la base
public/           Panel (HTML, CSS y JS sin frameworks)
```

Tablas en la base de datos:

- `riesgos`: un registro por riesgo, con su estado actual.
- `riesgos_historial`: una fila por cada mención o actualización. Solo se puede insertar — la base bloquea cualquier `UPDATE` o `DELETE` sobre ella.

## Desplegar un cambio

Este proyecto no se despliega solo: cualquier cambio se sube manualmente y con aviso previo, según lo acordado.

```bash
railway up --service registro-riesgos
```

## Riesgo residual declarado

Los fragmentos de texto que alimentan el historial pueden provenir de actas o correos de clientes de GECON. Guardarlos en esta base propia en Railway no los envía a terceros. Pero si un flujo externo los extrae usando un servicio de IA en la nube, ese envío debe pasar primero por la anonimización acordada (nombres de personas del directorio de GECON, empresas cliente, correos, teléfonos y RUT reemplazados por marcas) — ese paso vive en el flujo que alimenta esta API, no en esta aplicación.
