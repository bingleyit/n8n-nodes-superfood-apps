'use strict';
// An in-memory stand-in for the Superfood API v1, faithful to the real routes
// on the points the node depends on:
//  - the table catalogue (fixtures/tables-index.json is generated from the
//    app's lib/api-v1-tables.ts, including its writable fields),
//  - list paging: limit 1 to 200 (default 50), offset, order asc|desc on the
//    table's change column with an id tiebreaker, `updated_since` as
//    "greater or equal" compared at the database's microsecond precision,
//    exact-match filters (unknown field = 400), has_more and next_offset,
//  - writes: only catalogued writable fields (anything else = 400), read keys
//    refused with 403, the reply = the stored record read back,
//  - forms list, form definition and submissions, custom endpoints (1 to 200
//    records, `{ records: [...] }` body, results in order),
//  - errors as `{ error }` JSON, 401 without a valid Bearer key.

const tablesIndex = require('./fixtures/tables-index.json');

const TABLES = new Map(tablesIndex.data.map((t) => [t.key, t]));
const RESERVED = new Set(['limit', 'offset', 'updated_since', 'order']);
const FILTERABLE = new Set(['uuid', 'text', 'number', 'boolean', 'date', 'datetime']);

/** "2026-11-06T03:48:34.123456+00:00" → microseconds since the epoch. */
function micros(v) {
	if (v == null) return NaN;
	const s = String(v);
	const ms = Date.parse(s);
	if (!Number.isFinite(ms)) return NaN;
	const frac = /\.(\d+)/.exec(s);
	const extra = frac && frac[1].length > 3 ? Number(frac[1].slice(3, 6).padEnd(3, '0')) : 0;
	return ms * 1000 + extra;
}

let seq = 0;
const newId = () => {
	seq += 1;
	const hex = seq.toString(16).padStart(12, '0');
	return `00000000-0000-4000-8000-${hex}`;
};

function createFakeApi(opts = {}) {
	const keys = opts.keys || { 'sf_live_full': 'full', 'sf_live_read': 'read' };
	const rows = new Map(); // table key → array of rows
	const forms = opts.forms || [];
	const submissions = [];
	const customCalls = [];
	const requests = [];
	let clock = Date.parse(opts.now || '2026-11-06T00:00:00.000Z');

	const tick = () => {
		clock += 1000;
		return new Date(clock).toISOString().replace('Z', '000+00:00');
	};

	function seed(tableKey, list) {
		const t = TABLES.get(tableKey);
		if (!t) throw new Error(`no table ${tableKey}`);
		const arr = rows.get(tableKey) || [];
		for (const r of list) {
			const stamp = r[t.changed_field] || tick();
			arr.push({ id: newId(), created_at: stamp, ...r, [t.changed_field]: r[t.changed_field] || stamp });
		}
		rows.set(tableKey, arr);
		return arr;
	}

	const json = (status, body) => ({ status, body });
	const project = (t, r) => {
		const out = {};
		for (const f of t.fields) if (f.name in r) out[f.name] = r[f.name];
		return out;
	};

	function list(t, params) {
		let limit = 50;
		if (params.has('limit')) {
			const n = Number(params.get('limit'));
			if (!Number.isInteger(n) || n < 1) return json(400, { error: '`limit` must be a whole number from 1 to 200.' });
			limit = Math.min(n, 200);
		}
		let offset = 0;
		if (params.has('offset')) {
			const n = Number(params.get('offset'));
			if (!Number.isInteger(n) || n < 0) return json(400, { error: '`offset` must be a whole number, 0 or more.' });
			offset = n;
		}
		let since = null;
		if (params.get('updated_since')) {
			const ms = Date.parse(params.get('updated_since'));
			if (!Number.isFinite(ms)) return json(400, { error: '`updated_since` must be a date or date-time.' });
			since = ms * 1000;
		}
		const order = (params.get('order') || 'asc').toLowerCase();
		if (order !== 'asc' && order !== 'desc') return json(400, { error: '`order` must be asc or desc.' });
		const filters = [];
		for (const [name, value] of params.entries()) {
			if (RESERVED.has(name)) continue;
			const fd = t.fields.find((f) => f.name === name);
			if (!fd) return json(400, { error: `\`${name}\` is not a field of ${t.key}.` });
			if (!FILTERABLE.has(fd.type)) return json(400, { error: `\`${name}\` is a ${fd.type} field and cannot be filtered on.` });
			filters.push([name, value === 'null' ? null : value]);
		}
		const col = t.changed_field;
		let data = (rows.get(t.key) || []).filter((r) =>
			filters.every(([f, v]) => (v === null ? r[f] == null : String(r[f]) === v)),
		);
		if (since !== null) data = data.filter((r) => micros(r[col]) >= since);
		data.sort((a, b) => micros(a[col]) - micros(b[col]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		if (order === 'desc') data.reverse();
		const window = data.slice(offset, offset + limit + 1);
		const hasMore = window.length > limit;
		const page = window.slice(0, limit).map((r) => project(t, r));
		return json(200, {
			object: 'list',
			table: t.key,
			data: page,
			limit,
			offset,
			has_more: hasMore,
			next_offset: hasMore ? offset + page.length : null,
		});
	}

	function write(t, mode, body, id, access) {
		if (access !== 'full') return json(403, { error: 'This API key is read only. Make a read and write key in Company settings > API.' });
		const w = t.writes;
		if (!w || (mode === 'create' && !w.create) || (mode === 'update' && !w.update)) {
			return json(405, { error: `${t.label} can't be ${mode === 'create' ? 'created' : 'updated'} through the API yet.` });
		}
		if (typeof body !== 'object' || body === null || Array.isArray(body)) return json(400, { error: 'The body must be a JSON object.' });
		const bad = Object.keys(body).filter((k) => !w.writable_fields.includes(k));
		if (bad.length) return json(400, { error: `${bad.join(', ')} can't be set. ${t.label} accepts: ${w.writable_fields.join(', ')}.` });
		if (mode === 'create') {
			const missing = (w.required_on_create || []).filter((k) => body[k] == null || body[k] === '');
			if (missing.length) return json(400, { error: `${missing.join(', ')} is required.` });
			const stamp = tick();
			const row = { id: newId(), created_at: stamp, ...body, [t.changed_field]: stamp };
			if (t.changed_field !== 'updated_at') row.updated_at = stamp;
			rows.set(t.key, [...(rows.get(t.key) || []), row]);
			return json(201, { object: 'record', table: t.key, data: project(t, row) });
		}
		const row = (rows.get(t.key) || []).find((r) => r.id === id);
		if (!row) return json(404, { error: 'Record not found.' });
		for (const [k, v] of Object.entries(body)) {
			if (k === 'custom' && row.custom && typeof v === 'object' && v) row.custom = { ...row.custom, ...v };
			else row[k] = v;
		}
		row[t.changed_field] = tick();
		return json(200, { object: 'record', table: t.key, data: project(t, row) });
	}

	/** One request: method, path after the origin (with query), headers, JSON body. */
	function handle(method, url, headers = {}, body) {
		const u = new URL(url, 'https://fake.superfood.test');
		requests.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
		const auth = headers.Authorization || headers.authorization || '';
		const key = auth.startsWith('Bearer ') ? auth.slice(7) : headers['X-API-Key'] || headers['x-api-key'];
		const access = keys[key];
		if (!access) return json(401, { error: 'Unauthorized: valid API key required' });
		const parts = u.pathname.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean);

		if (!parts.length && method === 'GET') {
			return json(200, { api: 'Superfood API', version: 'v1', key: { name: 'n8n', access }, company_id: 'rec123', tables: [...TABLES.keys()] });
		}
		if (parts[0] === 'tables') {
			if (parts.length === 1) return json(200, tablesIndex);
			const t = TABLES.get(parts[1]);
			if (!t) return json(404, { error: `There is no table called ${parts[1]}. GET /api/v1/tables lists them.` });
			if (parts[2] === 'fields') return json(200, { object: 'table', ...t });
			if (parts.length === 2 && method === 'GET') return list(t, u.searchParams);
			if (parts.length === 2 && method === 'POST') return write(t, 'create', body, null, access);
			if (parts.length === 3 && method === 'GET') {
				const row = (rows.get(t.key) || []).find((r) => r.id === parts[2]);
				return row ? json(200, { object: 'record', table: t.key, data: project(t, row) }) : json(404, { error: 'Record not found.' });
			}
			if (parts.length === 3 && method === 'PATCH') return write(t, 'update', body, parts[2], access);
		}
		if (parts[0] === 'forms') {
			if (parts.length === 1) {
				return json(200, { forms: forms.map((f) => ({ id: f.id, name: f.name, category: f.category || 'Custom', source: 'custom' })), total: forms.length });
			}
			const f = forms.find((x) => x.id === parts[1]);
			if (!f) return json(404, { error: 'Form not found' });
			if (parts.length === 2) return json(200, { form: f });
			if (parts[2] === 'submissions' && method === 'POST') {
				if (access !== 'full') return json(403, { error: 'This API key is read only.' });
				if (!body || typeof body.fields !== 'object' || body.fields === null || Array.isArray(body.fields)) {
					return json(400, { error: '`fields` must be a non-null object' });
				}
				const stamp = tick();
				const sub = { id: newId(), form_id: f.id, form_data: body.fields, submitted_by: body.submitted_by || null, submitted_at: stamp, status: 'pending_qa' };
				submissions.push(sub);
				seed('form_submissions', [sub]);
				return json(201, { submission: { id: sub.id, submitted_at: stamp } });
			}
		}
		if (parts[0] === 'custom' && method === 'POST') {
			const endpoint = parts.slice(1).join('/');
			if (!(opts.customEndpoints || []).includes(endpoint)) return json(404, { error: 'Not found' });
			const list = Array.isArray(body) ? body : body && Array.isArray(body.records) ? body.records : [body];
			if (!list.length) return json(400, { error: 'Send at least one record.' });
			if (list.length > 200) return json(400, { error: 'Send at most 200 records per request.' });
			const errors = list.map((r, i) => (r && r.external_id ? null : { index: i, error: 'external_id is required.' })).filter(Boolean);
			if (errors.length) return json(400, { error: 'Some records could not be read, so nothing was saved.', errors });
			customCalls.push({ endpoint, records: list });
			const results = list.map((r) => ({ external_id: r.external_id, id: newId(), created: true }));
			return json(201, { ok: true, created: results.length, updated: 0, results });
		}
		return json(404, { error: 'Not found' });
	}

	return { handle, seed, rows, submissions, customCalls, requests, tick, TABLES };
}

module.exports = { createFakeApi, micros };
