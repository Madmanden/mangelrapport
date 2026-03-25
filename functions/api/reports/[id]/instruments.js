import {
  instrumentDefaults,
  json,
  methodNotAllowed,
  readJson,
  requestError,
  tursoRows,
  tursoTransaction,
  validateIdentifier,
} from '../../_lib.js';

export async function onRequest(context) {
  const { request, env, params } = context;
  let reportId;
  try {
    reportId = validateIdentifier(params.id, 'Report-ID');
  } catch (err) {
    return requestError(err, 'Kunne ikke håndtere report-id');
  }

  if (request.method === 'GET') {
    // GET /reports/:id/instruments
    try {
      const results = await tursoRows(env, [
        {
          sql: 'SELECT * FROM instruments WHERE report_id = ? ORDER BY position ASC',
          args: [reportId],
        },
      ]);
      return json({ instruments: results });
    } catch (err) {
      return requestError(err, 'Kunne ikke hente instrumenter');
    }
  }

  if (request.method === 'POST') {
    // POST /reports/:id/instruments
    try {
      const body = await readJson(request);
      const instrumentId = validateIdentifier(body?.id, 'Instrument-ID');

      const position = Number.isFinite(Number(body?.position)) ? Number(body.position) : 0;
      const inst = instrumentDefaults(instrumentId, reportId, position);

      await tursoTransaction(env, [
        {
          sql: 'INSERT INTO instruments (id, report_id, antal, nummer, position, photo) VALUES (?, ?, ?, ?, ?, ?)',
          args: [
            inst.id,
            inst.report_id,
            inst.antal,
            inst.nummer,
            inst.position,
            inst.photo,
          ],
        },
        {
          sql: 'UPDATE reports SET updated_at = ? WHERE id = ?',
          args: [new Date().toISOString(), reportId],
        },
      ]);

      return json({ instrument: inst }, { status: 201 });
    } catch (err) {
      return requestError(err, 'Kunne ikke oprette instrument');
    }
  }

  return methodNotAllowed(['GET', 'POST']);
}
