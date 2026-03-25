import {
  cutoffIso,
  json,
  methodNotAllowed,
  requestError,
  tursoRows,
  tursoTransaction,
} from './_lib.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') {
    return methodNotAllowed(['GET']);
  }

  try {
    const cutoff = cutoffIso(60);
    await tursoTransaction(env, [
      {
        sql: 'DELETE FROM instruments WHERE report_id IN (SELECT id FROM reports WHERE updated_at < ?)',
        args: [cutoff],
      },
      {
        sql: 'DELETE FROM reports WHERE updated_at < ?',
        args: [cutoff],
      },
    ]);

    const reports = await tursoRows(env, [
      {
        sql: 'SELECT * FROM reports WHERE updated_at > ? ORDER BY created_at DESC',
        args: [cutoff],
      },
    ]);
    const instrumentCounts = await tursoRows(env, [
      {
        sql: 'SELECT report_id, COUNT(*) AS instrument_count FROM instruments GROUP BY report_id',
      },
    ]);
    const countMap = new Map(
      instrumentCounts.map(row => [String(row.report_id), Number(row.instrument_count) || 0])
    );

    return json({
      reports: reports.map(report => ({
        ...report,
        instrument_count: countMap.get(String(report.id)) || 0,
      })),
    });
  } catch (err) {
    return requestError(err, 'Kunne ikke hente rapporter');
  }
}
