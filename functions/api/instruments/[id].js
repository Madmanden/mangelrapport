import {
  error,
  json,
  limitInstrumentFields,
  methodNotAllowed,
  readJson,
  requestError,
  tursoExecute,
  tursoTransaction,
  validateIdentifier,
} from '../_lib.js';

export async function onRequest(context) {
  const { request, env, params } = context;
  let instrumentId;
  try {
    instrumentId = validateIdentifier(params.id, 'Instrument-ID');
  } catch (err) {
    return requestError(err, 'Kunne ikke håndtere instrument-id');
  }

  if (request.method === 'PATCH') {
    // PATCH /instruments/:id
    try {
      const body = await readJson(request);
      const fields = limitInstrumentFields(body);
      const entries = Object.entries(fields);
      if (!entries.length) {
        return error(400, 'Ingen gyldige felter');
      }

      const sets = entries.map(([key]) => `${key} = ?`);
      const args = entries.map(([, value]) => value);

      await tursoTransaction(env, [
        {
          sql: `UPDATE instruments SET ${sets.join(', ')} WHERE id = ?`,
          args: [...args, instrumentId],
        },
        {
          sql: 'UPDATE reports SET updated_at = ? WHERE id = (SELECT report_id FROM instruments WHERE id = ?)',
          args: [new Date().toISOString(), instrumentId],
        },
      ]);

      return json({ ok: true });
    } catch (err) {
      return requestError(err, 'Kunne ikke opdatere instrument');
    }
  }

  if (request.method === 'DELETE') {
    // DELETE /instruments/:id
    try {
      await tursoTransaction(env, [
        {
          sql: 'UPDATE reports SET updated_at = ? WHERE id = (SELECT report_id FROM instruments WHERE id = ?)',
          args: [new Date().toISOString(), instrumentId],
        },
        {
          sql: 'DELETE FROM instruments WHERE id = ?',
          args: [instrumentId],
        },
      ]);

      return json({ ok: true });
    } catch (err) {
      return requestError(err, 'Kunne ikke slette instrument');
    }
  }

  return methodNotAllowed(['PATCH', 'DELETE']);
}
