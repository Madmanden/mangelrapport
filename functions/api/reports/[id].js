import {
  error,
  json,
  limitReportFields,
  methodNotAllowed,
  readJson,
  requestError,
  tursoExecute,
  tursoTransaction,
  validateIdentifier,
} from '../_lib.js';

export async function onRequest(context) {
  const { request, env, params } = context;
  let reportId;
  try {
    reportId = validateIdentifier(params.id, 'Report-ID');
  } catch (err) {
    return requestError(err, 'Kunne ikke håndtere rapport-id');
  }

  if (request.method === 'PATCH') {
    // PATCH /reports/:id
    try {
      const body = await readJson(request);
      const fields = limitReportFields(body);
      const entries = Object.entries(fields);
      if (!entries.length) {
        return error(400, 'Ingen gyldige felter');
      }

      const sets = entries.map(([key]) => `${key} = ?`);
      const args = entries.map(([, value]) => value);
      const now = new Date().toISOString();
      await tursoExecute(env, [
        {
          sql: `UPDATE reports SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
          args: [...args, now, reportId],
        },
      ]);

      return json({ ok: true });
    } catch (err) {
      return requestError(err, 'Kunne ikke opdatere rapport');
    }
  }

  if (request.method === 'DELETE') {
    // DELETE /reports/:id
    try {
      await tursoTransaction(env, [
        {
          sql: 'DELETE FROM instruments WHERE report_id = ?',
          args: [reportId],
        },
        {
          sql: 'DELETE FROM reports WHERE id = ?',
          args: [reportId],
        },
      ]);

      return json({ ok: true });
    } catch (err) {
      return requestError(err, 'Kunne ikke slette rapport');
    }
  }

  return methodNotAllowed(['PATCH', 'DELETE']);
}
