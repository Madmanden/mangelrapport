import {
  json,
  methodNotAllowed,
  readJson,
  reportDefaults,
  requestError,
  validateIdentifier,
  tursoExecute,
} from './_lib.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return methodNotAllowed(['POST']);
  }

  // POST /reports
  try {
    const body = await readJson(request);
    const reportId = validateIdentifier(body?.id, 'Report-ID');

    const report = reportDefaults(reportId);
    await tursoExecute(env, [
      {
        sql: 'INSERT INTO reports (id, bakke_id, bakke_navn, dato, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [
          report.id,
          report.bakke_id,
          report.bakke_navn,
          report.dato,
          report.created_at,
          report.updated_at,
        ],
      },
    ]);

    return json({ report }, { status: 201 });
  } catch (err) {
    return requestError(err, 'Kunne ikke oprette rapport');
  }
}
