const { Pool, types } = require('pg');

// Las fechas de documento se devuelven tal cual (aaaa-mm-dd), sin conversion de zona horaria.
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

// El historial es de solo inserción: la base rechaza cualquier UPDATE o DELETE sobre él.
const ESQUEMA = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS riesgos (
  id SERIAL PRIMARY KEY,
  categoria TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  probabilidad SMALLINT CHECK (probabilidad BETWEEN 1 AND 5),
  impacto SMALLINT CHECK (impacto BETWEEN 1 AND 5),
  exposicion SMALLINT GENERATED ALWAYS AS (probabilidad * impacto) STORED,
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','en_respuesta','cerrado')),
  estrategia_respuesta TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- probabilidad/impacto pueden quedar en NULL: significa "pendiente de calificacion humana",
-- nunca un numero inventado por la IA que alimenta el registro. ALTER idempotente para
-- una tabla que ya existia con NOT NULL antes de este cambio (26/09/2026).
ALTER TABLE riesgos ALTER COLUMN probabilidad DROP NOT NULL;

-- Rediseno (28/09/2026, a pedido de Guillermo): el impacto ya no es un solo numero.
-- Cada riesgo puede tener un impacto distinto por cada dimension del proyecto
-- (cronograma, costo, calidad, alcance), porque no todas las organizaciones ni
-- todos los proyectos les dan el mismo peso. La exposicion se calcula por dimension.
-- Se elimina la columna generada 'exposicion' antes de poder eliminar 'impacto'.
ALTER TABLE riesgos DROP COLUMN IF EXISTS exposicion;
ALTER TABLE riesgos DROP COLUMN IF EXISTS impacto;

ALTER TABLE riesgos ADD COLUMN IF NOT EXISTS impacto_cronograma SMALLINT CHECK (impacto_cronograma BETWEEN 1 AND 5);
ALTER TABLE riesgos ADD COLUMN IF NOT EXISTS impacto_costo SMALLINT CHECK (impacto_costo BETWEEN 1 AND 5);
ALTER TABLE riesgos ADD COLUMN IF NOT EXISTS impacto_calidad SMALLINT CHECK (impacto_calidad BETWEEN 1 AND 5);
ALTER TABLE riesgos ADD COLUMN IF NOT EXISTS impacto_alcance SMALLINT CHECK (impacto_alcance BETWEEN 1 AND 5);

ALTER TABLE riesgos ADD COLUMN IF NOT EXISTS exposicion_cronograma SMALLINT GENERATED ALWAYS AS (probabilidad * impacto_cronograma) STORED;
ALTER TABLE riesgos ADD COLUMN IF NOT EXISTS exposicion_costo SMALLINT GENERATED ALWAYS AS (probabilidad * impacto_costo) STORED;
ALTER TABLE riesgos ADD COLUMN IF NOT EXISTS exposicion_calidad SMALLINT GENERATED ALWAYS AS (probabilidad * impacto_calidad) STORED;
ALTER TABLE riesgos ADD COLUMN IF NOT EXISTS exposicion_alcance SMALLINT GENERATED ALWAYS AS (probabilidad * impacto_alcance) STORED;

-- Origen: interno (GECON controla la causa) o externo (cliente, proveedor, regulador,
-- entorno). Se agrega con default para no romper filas ya existentes; luego se exige siempre.
ALTER TABLE riesgos ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'interno' CHECK (origen IN ('interno','externo'));

-- Proyecto (28/09/2026): sin esto, la comparacion por significado podria fusionar dos
-- riesgos iguales de PROYECTOS DISTINTOS en un solo registro, perdiendo la trazabilidad
-- de cada uno por separado. Texto libre y opcional (no todo documento identifica un
-- proyecto con certeza); cuando existe, acota la busqueda de duplicados a ese proyecto.
ALTER TABLE riesgos ADD COLUMN IF NOT EXISTS proyecto TEXT;
CREATE INDEX IF NOT EXISTS idx_riesgos_proyecto ON riesgos(proyecto);

-- Metodologia de deteccion (28/09/2026, material de capacitacion de Guillermo, PIS
-- Modulo 2): un hallazgo no siempre es un riesgo explicito. tipo_hallazgo distingue
-- 'riesgo' (el caso normal), 'indefinicion' (lenguaje vago que en ejecucion se
-- interpreta a conveniencia) e 'inconsistencia' (el documento se contradice a si
-- mismo). justificacion_origen explica por que se clasifico interno/externo,
-- especialmente cuando el riesgo se bajo a su nivel accionable antes de clasificarlo.
-- Son campos propios, no una etiqueta de texto pegada a la descripcion.
ALTER TABLE riesgos ADD COLUMN IF NOT EXISTS tipo_hallazgo TEXT NOT NULL DEFAULT 'riesgo' CHECK (tipo_hallazgo IN ('riesgo','indefinicion','inconsistencia'));
ALTER TABLE riesgos ADD COLUMN IF NOT EXISTS justificacion_origen TEXT;

-- Prioridad del proyecto: en que orden de dimensiones se ordena el registro (la primera
-- manda, los empates los rompe la siguiente). Una sola configuracion para todo el registro,
-- porque hoy la aplicacion no distingue entre varios proyectos.
CREATE TABLE IF NOT EXISTS configuracion_registro (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  orden_prioridad TEXT[] NOT NULL DEFAULT ARRAY['cronograma','costo','calidad','alcance']
);
INSERT INTO configuracion_registro (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS riesgos_historial (
  id SERIAL PRIMARY KEY,
  riesgo_id INTEGER NOT NULL REFERENCES riesgos(id) ON DELETE RESTRICT,
  fecha_documento DATE NOT NULL,
  documento TEXT NOT NULL,
  fragmento TEXT NOT NULL,
  tipo_evento TEXT NOT NULL DEFAULT 'actualizacion',
  cambios JSONB,
  registrado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nota (28/09/2026): motivo, en texto libre, de por que esta mencion se asocio a este
-- riesgo (por ejemplo, la explicacion del modelo de IA al detectar que es el mismo
-- riesgo aunque este contado distinto). Se usa para armar el PDF de evaluacion de
-- riesgos; nunca reemplaza al fragmento exacto, que sigue siendo la cita textual.
ALTER TABLE riesgos_historial ADD COLUMN IF NOT EXISTS nota TEXT;

CREATE INDEX IF NOT EXISTS idx_riesgos_descripcion_trgm ON riesgos USING gin (descripcion gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_historial_riesgo ON riesgos_historial(riesgo_id);

CREATE OR REPLACE FUNCTION historial_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'El historial de riesgos no se puede modificar ni borrar';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_historial_inmutable ON riesgos_historial;
CREATE TRIGGER trg_historial_inmutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON riesgos_historial
  FOR EACH STATEMENT EXECUTE FUNCTION historial_inmutable();
`;

async function inicializar() {
  await pool.query(ESQUEMA);
}

module.exports = { pool, inicializar };
