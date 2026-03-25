const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

// ─────────────────────────────────────────────
//  Error types and response helpers
// ─────────────────────────────────────────────
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  for (const [key, value] of Object.entries(JSON_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }

  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

export function error(status, message) {
  return json({ error: message }, { status });
}

export function methodNotAllowed(allowed) {
  return json(
    { error: 'Method not allowed' },
    {
      status: 405,
      headers: {
        Allow: allowed.join(', '),
      },
    }
  );
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch (_) {
    throw new ValidationError('Ugyldigt JSON-body');
  }
}

// ─────────────────────────────────────────────
//  Environment and value normalization
// ─────────────────────────────────────────────
function getEnv(env, key) {
  const value = env?.[key];
  if (!value) {
    throw new Error(`Missing ${key}`);
  }
  return value;
}

function asText(value) {
  return value == null ? '' : String(value);
}

function ensureMaxLength(value, maxLength, label) {
  const text = asText(value);
  if (text.length > maxLength) {
    throw new ValidationError(`${label} er for langt`);
  }
  return text;
}

function ensureOptionalDate(value, label) {
  const text = asText(value);
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ValidationError(`${label} er ugyldigt`);
  }
  return text;
}

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function isValidBase64Photo(value) {
  if (value == null || value === '') return true;
  const text = String(value);
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return false;
  try {
    const bytes = typeof Buffer !== 'undefined'
      ? Buffer.from(text, 'base64')
      : Uint8Array.from(atob(text), ch => ch.charCodeAt(0));
    return bytes.length >= 4
      && bytes[0] === 0xff
      && bytes[1] === 0xd8
      && bytes[bytes.length - 2] === 0xff
      && bytes[bytes.length - 1] === 0xd9;
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────
//  Validation limits
// ─────────────────────────────────────────────
const MAX_TEXT_FIELD_LENGTH = 255;
const MAX_ANTAL_LENGTH = 16;
const MAX_PHOTO_BASE64_LENGTH = 250000;
const MAX_ID_LENGTH = 64;

// ─────────────────────────────────────────────
//  Turso request helpers
// ─────────────────────────────────────────────
export async function tursoExecute(env, statements) {
  const url = getEnv(env, 'TURSO_URL');
  const token = getEnv(env, 'TURSO_TOKEN');

  const toArg = value => {
    if (value === null || value === undefined) return { type: 'null' };
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { type: 'integer', value: String(value) }
        : { type: 'float', value: String(value) };
    }
    if (typeof value === 'bigint') return { type: 'integer', value: String(value) };
    if (value instanceof Uint8Array) {
      return { type: 'blob', base64: toBase64(value) };
    }
    return { type: 'text', value: String(value) };
  };

  const res = await fetch(`${url}/v2/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        ...statements.map(stmt => ({
          type: 'execute',
          stmt: {
            sql: stmt.sql,
            ...(stmt.args ? { args: stmt.args.map(toArg) } : {}),
            ...(stmt.named_args ? {
              named_args: stmt.named_args.map(({ name, value }) => ({
                name,
                value: toArg(value),
              })),
            } : {}),
          },
        })),
        { type: 'close' },
      ],
    }),
  });

  const text = await res.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
  }

  if (!res.ok) {
    const message =
      typeof data === 'string'
        ? data
        : data?.error || `Turso request failed (${res.status})`;
    throw new Error(message);
  }

  return data;
}

export async function tursoTransaction(env, statements) {
  return tursoExecute(env, [
    { sql: 'BEGIN IMMEDIATE' },
    ...statements,
    { sql: 'COMMIT' },
  ]);
}

export async function tursoRows(env, statements) {
  const data = await tursoExecute(env, statements);
  const result = data?.results?.[0]?.response?.result;
  if (!result) return [];
  const cols = result.cols ?? [];
  const rows = result.rows ?? [];
  return rows.map(row =>
    Object.fromEntries(
      cols.map((col, i) => {
        const cell = row[i];
        if (cell == null || cell.type === 'null') return [col.name, null];

        const raw = cell.value;
        if (raw == null || raw === '') {
          return [col.name, null];
        }

        if (cell.type === 'integer') {
          const num = Number(raw);
          if (!Number.isFinite(num)) {
            return [col.name, null];
          }
          if (!Number.isSafeInteger(num)) {
            // Avoid precision loss for large integers; keep the original string.
            return [col.name, raw];
          }
          return [col.name, num];
        }

        if (cell.type === 'float') {
          const num = Number(raw);
          if (!Number.isFinite(num)) {
            return [col.name, null];
          }
          return [col.name, num];
        }

        return [col.name, raw ?? null];
      })
    )
  );
}

// ─────────────────────────────────────────────
//  Timestamp and defaults
// ─────────────────────────────────────────────
export function isoNow() {
  return new Date().toISOString();
}

function copenhagenDateIso(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function reportDefaults(id) {
  const now = isoNow();
  return {
    id,
    bakke_id: '',
    bakke_navn: '',
    dato: copenhagenDateIso(),
    created_at: now,
    updated_at: now,
  };
}

export function instrumentDefaults(id, reportId, position) {
  return {
    id,
    report_id: reportId,
    antal: '1',
    nummer: '',
    position,
    photo: null,
  };
}

// ─────────────────────────────────────────────
//  Input validation and field limits
// ─────────────────────────────────────────────
export function validateIdentifier(value, label) {
  const text = asText(value).trim();
  if (!text) {
    throw new ValidationError(`${label} mangler`);
  }
  if (text.length > MAX_ID_LENGTH) {
    throw new ValidationError(`${label} er for langt`);
  }
  return text;
}

export function limitReportFields(body) {
  const fields = {};

  if (Object.prototype.hasOwnProperty.call(body, 'bakke_id')) {
    fields.bakke_id = ensureMaxLength(body.bakke_id, MAX_TEXT_FIELD_LENGTH, 'Bakke-ID');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'bakke_navn')) {
    fields.bakke_navn = ensureMaxLength(body.bakke_navn, MAX_TEXT_FIELD_LENGTH, 'Bakkenavn');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'dato')) {
    fields.dato = ensureOptionalDate(body.dato, 'Dato');
  }

  return fields;
}

export function limitInstrumentFields(body) {
  const fields = {};

  if (Object.prototype.hasOwnProperty.call(body, 'antal')) {
    fields.antal = ensureMaxLength(body.antal, MAX_ANTAL_LENGTH, 'Antal');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'nummer')) {
    fields.nummer = ensureMaxLength(body.nummer, MAX_TEXT_FIELD_LENGTH, 'Instrument-nr.');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'photo')) {
    const photo = asText(body.photo);
    if (photo.length > MAX_PHOTO_BASE64_LENGTH) {
      throw new ValidationError('Billeddata er for stort');
    }
    if (!isValidBase64Photo(photo)) {
      throw new ValidationError('Ugyldigt billeddata');
    }
    fields.photo = photo;
  }

  return fields;
}

// ─────────────────────────────────────────────
//  Error translation and date helpers
// ─────────────────────────────────────────────
export function requestError(err, fallbackMessage) {
  if (err instanceof ValidationError) {
    return error(400, err.message);
  }

  return error(500, err?.message || fallbackMessage);
}

export function cutoffIso(days = 60) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff.toISOString();
}
