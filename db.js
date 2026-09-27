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
  probabilidad SMALLINT NOT NULL CHECK (probabilidad BETWEEN 1 AND 5),
  impacto SMALLINT NOT NULL CHECK (impacto BETWEEN 1 AND 5),
  exposicion SMALLINT GENERATED ALWAYS AS (probabilidad * impacto) STORED,
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','en_respuesta','cerrado')),
  estrategia_respuesta TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
