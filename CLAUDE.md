# CLAUDE.md — Registro de Riesgos

Reglas propias de esta carpeta. Se suman al CLAUDE.md global y al de `ProyectosS` — no los reemplazan. El perfil y la experiencia con la que debo actuar (gerencia de proyectos de izaje, ASME, etc.) ya están en el CLAUDE.md global y aplican aquí sin necesidad de repetirlos.

## Sobre esta carpeta

Aplicación de registro de riesgos: panel web + API, desplegada en Railway (proyecto `Registro-de-Riesgos`, servicio `registro-riesgos`, base de datos `Postgres`). Detalle técnico completo en `README.md`. Flujos de n8n asociados: "Registro de Riesgos - Deteccion Automatica" (detecta riesgos desde OneDrive) y "Registro de Riesgos - Aviso Semanal Sin Estrategia".

## Decisiones ya tomadas sobre el modelo de riesgo

- Escala de probabilidad e impacto: 1 a 5.
- El impacto **no es un solo número**: es uno por cada dimensión del proyecto (cronograma, costo, calidad, alcance), porque no todas las organizaciones ni todos los proyectos les dan el mismo peso (decisión de Guillermo, 28/09/2026, a partir de un ejemplo de su mentor). La exposición se calcula igual, por dimensión: probabilidad × impacto de esa dimensión.
- Umbral de alta exposición: 15 (variable `UMBRAL_ALTA_EXPOSICION` en Railway, se puede ajustar sin tocar código). Se marca "alta exposición" si **cualquier** dimensión lo supera.
- El registro se ordena por una "prioridad del proyecto": un orden configurable de las cuatro dimensiones (una sola configuración para todo el registro, no por proyecto individual — hoy la aplicación no maneja varios proyectos).
- Categoría (9 valores: técnico, cronograma, costo, alcance, recursos, proveedor, externo, regulatorio, calidad) y origen (interno/externo) son dos clasificaciones separadas del mismo riesgo.
- El historial de cada riesgo es de solo inserción. Nunca se edita ni se borra una entrada, aunque se pida — la base de datos lo rechaza a nivel de motor.
- Probabilidad y cada impacto pueden quedar en blanco: significa "pendiente de calificación humana". Ningún flujo debe inventar un número cuando el documento no da evidencia suficiente (decisión de Guillermo, 27/09/2026, al construir el flujo de detección automática de riesgos desde OneDrive).
- La decisión de si un riesgo nuevo ya existe (duplicado) la toma siempre un modelo de IA comparando significado, nunca una búsqueda por coincidencia de palabras — ni el flujo ni el modelo deciden esto por similitud de texto (decisión de Guillermo, 28/09/2026).
- **La probabilidad asignada por la IA no se puede calibrar comparándola contra la tasa real de ocurrencia**, porque el sistema existe precisamente para que se mitigue antes de que ocurra: si la mitigación funciona, el riesgo no ocurre aunque la probabilidad original fuera correcta. Comparar contra el resultado final mide el éxito de la mitigación, no la calidad de la estimación (corrección de Guillermo, 28/09/2026, a una recomendación equivocada de Claude). Si algún día se quiere validar la calibración: solo sirve mirar el subconjunto de riesgos que quedaron **sin mitigar** (sin estrategia) y aun así se cerraron sin que nadie actuara; para todo lo demás, la probabilidad es una herramienta de priorización relativa (que 5 se atienda antes que 3), no un pronóstico literal, y se audita por revisión de criterio humano, no por estadística de resultados.
- Un mismo riesgo puede repetirse en proyectos distintos de GECON: existe el campo `proyecto` (texto libre, opcional) y la comparación de duplicados por IA se acota al mismo proyecto cuando se conoce, para no fusionar riesgos de proyectos distintos en un solo registro (decisión de Guillermo, 28/09/2026).
- **Metodología de detección (PIS Módulo 2, material de capacitación de Guillermo, 28/09/2026):** no todo hallazgo es un riesgo explícito. Son campos propios del riesgo, no una etiqueta de texto pegada a la descripción:
  - `tipo_hallazgo`: `riesgo` (caso normal), `indefinicion` (lenguaje vago del documento — tipo "se coordinará oportunamente", "según corresponda" — que en ejecución se interpreta a conveniencia; se describe el riesgo de fondo, no se repite la frase ambigua) o `inconsistencia` (el documento se contradice a sí mismo).
  - `justificacion_origen`: explica por qué el riesgo se clasificó interno o externo. Regla: el riesgo se redacta primero a su nivel accionable, y sobre eso se decide el origen. Interno = hay influencia/palanca sobre la causa; externo = no hay acción posible sobre la causa, solo contención. Ejemplo del propio Guillermo: "la arena de construcción se moja por falta de cobertura en temporada de lluvias" es **interno**, porque cubrirla está en manos del proyecto — aunque la lluvia en sí sea externa.
  - Regla inviolable de evidencia (ya vigente, reforzada por este material): "evidencia suficiente" para probabilidad/impacto es solo dato duro (indicador, cifra, plazo concreto, cantidad, multa, fecha vencida, incidente ya materializado, advertencia explícita). La sola mención de un tema no es evidencia suficiente — en ese caso el campo queda en blanco.

## Reglas operativas

- Cada lunes 8:00, si hay riesgos de alta exposición sin estrategia de respuesta, llega un borrador de correo a Guillermo con la lista completa (flujo "Aviso Semanal Sin Estrategia"). Se repite mientras sigan sin estrategia. Por ahora deja un borrador, no lo envía solo — si en la práctica esto hace que se pierda de vista, cambiar a envío directo.

## Pendiente de definir con Guillermo

- ¿Hay riesgos que deban marcarse como críticos sin importar la exposición calculada (por ejemplo, caída de carga, falla estructural de puente grúa), independiente del número de probabilidad × impacto?
- ¿Algún criterio de ASME B30.2 / B30.5 u otra norma debe forzar la clasificación o la estrategia de respuesta de un riesgo específico?
- ¿Quién es la fuente autorizada para cerrar un riesgo (solo Guillermo, o también el equipo de terreno)?
- El panel es de solo lectura (no se puede asignar estrategia de respuesta ni cerrar un riesgo desde ahí). Pendiente de construir si Guillermo lo pide.
- La verificación de duplicados envía la lista completa de riesgos activos a la IA en cada llamada; no escala bien si el registro crece a cientos de riesgos. Revisar si hace falta un prefiltro cuando eso ocurra.
