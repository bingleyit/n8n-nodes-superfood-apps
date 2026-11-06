'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { SuperfoodApps } = require('../dist/nodes/SuperfoodApps/SuperfoodApps.node.js');
const { createFakeApi } = require('./fake-api');
const { executeContext, loadOptionsContext } = require('./fake-n8n');

const FULL = { apiKey: 'sf_live_full', environment: 'production' };
const READ = { apiKey: 'sf_live_read', environment: 'production' };

const FORM = {
	id: 'cf-11111111-1111-4111-8111-111111111111',
	name: 'Milk receival',
	category: 'Quality',
	sections: [{ title: 'Milk', fields: [{ id: 'h', label: 'Milk', type: 'heading' }, { id: 'temp', label: 'Temperature', type: 'number', required: true }, { id: 'supplier', label: 'Supplier', type: 'text' }] }],
};

const node = new SuperfoodApps();
const run = (ctx) => node.execute.call(ctx);
const mapper = (value) => ({ mappingMode: 'defineBelow', value });

test('the node description is wired to the credential and methods', () => {
	const d = node.description;
	assert.equal(d.name, 'superfoodApps');
	assert.deepEqual(d.credentials, [{ name: 'superfoodAppsApi', required: true }]);
	assert.equal(d.usableAsTool, true);
	const methodNames = new Set([...Object.keys(node.methods.loadOptions), ...Object.keys(node.methods.resourceMapping)]);
	const walk = (props) =>
		props.flatMap((p) => [p, ...walk(p.options && p.type !== 'options' ? p.options.flatMap((o) => (o.values ? o.values : [o])) : [])]);
	for (const p of walk(d.properties)) {
		const m = p.typeOptions && (p.typeOptions.loadOptionsMethod || (p.typeOptions.resourceMapper && p.typeOptions.resourceMapper.resourceMapperMethod));
		if (m) assert.ok(methodNames.has(m), `${p.name} uses ${m}`);
	}
});

test('every request carries the Bearer key from the credential', async () => {
	const api = createFakeApi();
	api.seed('products', [{ product_name: 'Greek yoghurt 1kg', sku: 'GY1' }]);
	const ctx = executeContext(api, { creds: FULL, items: [{ json: {} }], params: { resource: 'record', operation: 'getAll', table: 'products', returnAll: false, limit: 5 } });
	const [out] = await run(ctx);
	assert.equal(out.length, 1);
	assert.equal(out[0].json.sku, 'GY1');
	assert.equal(ctx.calls[0].headers.Authorization, 'Bearer sf_live_full');
	assert.ok(ctx.calls[0].url.startsWith('https://app.superfoodapps.com/api/v1/tables/products?'));
	assert.equal(ctx.calls[0].headers['User-Agent'], 'n8n-nodes-superfood-apps');
});

test('Get Many: Return All pages past 200 rows and past the 1000-row PostgREST cap, stopping at Max Records', async () => {
	const api = createFakeApi();
	api.seed('sales_lines', Array.from({ length: 1234 }, (_, i) => ({ doc_ref: `INV-${i}`, qty: i })));
	const all = executeContext(api, { creds: READ, items: [{ json: {} }], params: { resource: 'record', operation: 'getAll', table: 'sales_lines', returnAll: true } });
	const [rows] = await run(all);
	assert.equal(rows.length, 1234);
	assert.equal(new Set(rows.map((r) => r.json.id)).size, 1234, 'no row twice');
	assert.equal(all.calls.length, 7, '200 per page');
	const capped = executeContext(api, { creds: READ, items: [{ json: {} }], params: { resource: 'record', operation: 'getAll', table: 'sales_lines', returnAll: true, listOptions: { maxRecords: 450 } } });
	const [some] = await run(capped);
	assert.equal(some.length, 450);
	assert.equal(capped.calls.at(-1).url.includes('limit=50'), true, 'last page asks only for what is left');
});

test('Get Many: filters, changed since and sort reach the API as query parameters', async () => {
	const api = createFakeApi();
	api.seed('complaints', [
		{ status: 'Open', customer_name: 'Coles', updated_at: '2026-11-01T00:00:00.000000+00:00' },
		{ status: 'Closed', customer_name: 'Coles', updated_at: '2026-11-03T00:00:00.000000+00:00' },
		{ status: 'Open', customer_name: 'Woolworths', updated_at: '2026-11-04T00:00:00.000000+00:00' },
		{ status: 'Open', customer_name: 'Coles', updated_at: '2026-11-05T00:00:00.000000+00:00' },
	]);
	const ctx = executeContext(api, {
		creds: READ,
		items: [{ json: {} }],
		params: {
			resource: 'record', operation: 'getAll', table: 'complaints', returnAll: false, limit: 10,
			filters: { conditions: [{ field: 'status', value: 'Open' }, { field: 'customer_name', value: 'Coles' }] },
			listOptions: { updatedSince: '2026-11-02T00:00:00Z', order: 'desc' },
		},
	});
	const [out] = await run(ctx);
	assert.equal(out.length, 1);
	assert.equal(out[0].json.updated_at, '2026-11-05T00:00:00.000000+00:00');
	const q = new URL(ctx.calls[0].url).searchParams;
	assert.equal(q.get('status'), 'Open');
	assert.equal(q.get('order'), 'desc');
	assert.equal(q.get('updated_since'), '2026-11-02T00:00:00.000Z');
});

test('Get: one record, and a wrong ID shows the API sentence', async () => {
	const api = createFakeApi();
	const [row] = api.seed('assets', [{ name: 'Vat 3' }]);
	const ok = await run(executeContext(api, { creds: READ, items: [{ json: {} }], params: { resource: 'record', operation: 'get', table: 'assets', recordId: ` ${row.id} ` } }));
	assert.equal(ok[0][0].json.name, 'Vat 3');
	await assert.rejects(
		run(executeContext(api, { creds: READ, items: [{ json: {} }], params: { resource: 'record', operation: 'get', table: 'assets', recordId: 'nope' } })),
		(e) => e.constructor.name === 'NodeApiError' && e.message === 'Record not found.' && e.httpCode === '404',
	);
});

test('Create: only mapped writable fields are sent, empties skipped, JSON parsed', async () => {
	const api = createFakeApi();
	const ctx = executeContext(api, {
		creds: FULL,
		items: [{ json: {} }],
		params: { resource: 'record', operation: 'create', table: 'complaints', fields: mapper({ status: 'Open', details: 'Lid split', root_cause: '', custom: '{"lot":"L7"}' }) },
	});
	const [out] = await run(ctx);
	const post = ctx.calls.find((c) => c.method === 'POST');
	assert.deepEqual(post.body, { status: 'Open', details: 'Lid split', custom: { lot: 'L7' } });
	assert.equal(out[0].json.details, 'Lid split');
	assert.ok(out[0].json.id);
	assert.equal(api.rows.get('complaints').length, 1);
});

test('Create: Map automatically sends the input item, dropping fields the API would refuse', async () => {
	const api = createFakeApi();
	const ctx = executeContext(api, {
		creds: FULL,
		items: [{ json: { id: 'old', company_id: 'other', name: 'Filler 2', location: 'Line 2', colour: 'red' } }],
		params: { resource: 'record', operation: 'create', table: 'assets', fields: { mappingMode: 'autoMapInputData', value: null } },
	});
	await run(ctx);
	assert.deepEqual(ctx.calls.find((c) => c.method === 'POST').body, { name: 'Filler 2', location: 'Line 2' });
});

test('Create: a read only key gets a clear 403 with the fix', async () => {
	const api = createFakeApi();
	await assert.rejects(
		run(executeContext(api, { creds: READ, items: [{ json: {} }], params: { resource: 'record', operation: 'create', table: 'suppliers', fields: mapper({ business_name: 'Acme' }) } })),
		(e) => e.httpCode === '403' && /read only/.test(e.message) && /Read and write/.test(e.description),
	);
});

test('Update: sends only what changed and never blanks untouched fields', async () => {
	const api = createFakeApi();
	const [row] = api.seed('spare_parts', [{ name: 'Seal kit', part_no: 'SK-1', stock_on_hand: 4, notes: 'Shelf B' }]);
	const ctx = executeContext(api, {
		creds: FULL,
		items: [{ json: {} }],
		params: { resource: 'record', operation: 'update', table: 'spare_parts', recordId: row.id, fields: mapper({ stock_on_hand: 2, notes: '' }) },
	});
	const [out] = await run(ctx);
	assert.deepEqual(ctx.calls.find((c) => c.method === 'PATCH').body, { stock_on_hand: 2 });
	assert.equal(out[0].json.notes, 'Shelf B');
	assert.equal(out[0].json.stock_on_hand, 2);
});

test('Update with Send Empty Values clears a field on purpose', async () => {
	const api = createFakeApi();
	const [row] = api.seed('spare_parts', [{ name: 'Seal kit', notes: 'Shelf B' }]);
	const ctx = executeContext(api, {
		creds: FULL,
		items: [{ json: {} }],
		params: { resource: 'record', operation: 'update', table: 'spare_parts', recordId: row.id, fields: mapper({ notes: '' }), writeOptions: { sendEmpty: true } },
	});
	await run(ctx);
	assert.equal(api.rows.get('spare_parts')[0].notes, null);
});

test('Update with nothing mapped stops before calling the API', async () => {
	const api = createFakeApi();
	const [row] = api.seed('spare_parts', [{ name: 'Seal kit' }]);
	const ctx = executeContext(api, { creds: FULL, items: [{ json: {} }], params: { resource: 'record', operation: 'update', table: 'spare_parts', recordId: row.id, fields: mapper({ notes: '' }) } });
	await assert.rejects(run(ctx), /Nothing to send/);
	assert.ok(!ctx.calls.some((c) => c.method === 'PATCH'));
});

test('Create or Update: creates, then updates the same record, and refuses an ambiguous match', async () => {
	const api = createFakeApi();
	const params = (name) => ({ resource: 'record', operation: 'upsert', table: 'suppliers', matchField: 'business_name', matchValue: name, fields: mapper({ business_name: name, phone: '0400 000 000' }) });
	const first = await run(executeContext(api, { creds: FULL, items: [{ json: {} }], params: params('Acme Dairy') }));
	assert.equal(first[0][0].json._action, 'created');
	const second = await run(executeContext(api, { creds: FULL, items: [{ json: {} }], params: { ...params('Acme Dairy'), fields: mapper({ phone: '0411 111 111' }) } }));
	assert.equal(second[0][0].json._action, 'updated');
	assert.equal(api.rows.get('suppliers').length, 1);
	assert.equal(api.rows.get('suppliers')[0].phone, '0411 111 111');
	api.seed('suppliers', [{ business_name: 'Twin' }, { business_name: 'Twin' }]);
	await assert.rejects(run(executeContext(api, { creds: FULL, items: [{ json: {} }], params: params('Twin') })), /More than one/);
});

test('Continue on fail: one bad item does not stop the others', async () => {
	const api = createFakeApi();
	const [row] = api.seed('assets', [{ name: 'Vat 1' }]);
	const ctx = executeContext(api, {
		creds: READ,
		continueOnFail: true,
		items: [{ json: { id: row.id } }, { json: { id: 'missing' } }],
		params: (i) => ({ resource: 'record', operation: 'get', table: 'assets', recordId: i === 0 ? row.id : 'missing' }),
	});
	const [out] = await run(ctx);
	assert.equal(out.length, 2);
	assert.equal(out[0].json.name, 'Vat 1');
	assert.equal(out[1].json.error, 'Record not found.');
	assert.deepEqual(out.map((o) => o.pairedItem.item), [0, 1]);
});

test('every writable table accepts a create of every writable field through the node', async () => {
	const tables = require('./fixtures/tables-index.json').data.filter((t) => t.writes && t.writes.create);
	for (const t of tables) {
		const api = createFakeApi();
		const types = Object.fromEntries(t.fields.map((f) => [f.name, f.type]));
		const sample = (name) => {
			const ty = types[name];
			if (ty === 'number') return 3;
			if (ty === 'boolean') return true;
			if (ty === 'json') return { k: 'v' };
			if (ty === 'list') return ['a'];
			if (ty === 'uuid') return '00000000-0000-4000-8000-00000000abcd';
			if (ty === 'date') return '2026-11-06';
			if (ty === 'datetime') return '2026-11-06T01:02:03.000Z';
			if (name === 'data' || name === 'attachments' || name === 'checks') return { k: 'v' };
			return `value of ${name}`;
		};
		const value = Object.fromEntries(t.writes.writable_fields.map((n) => [n, sample(n)]));
		const ctx = executeContext(api, { creds: FULL, items: [{ json: {} }], params: { resource: 'record', operation: 'create', table: t.key, fields: mapper(value) } });
		const [out] = await run(ctx);
		assert.deepEqual(Object.keys(ctx.calls.find((c) => c.method === 'POST').body).sort(), [...t.writes.writable_fields].sort(), t.key);
		assert.ok(out[0].json.id, t.key);
	}
});

test('Forms: list, get and submit with mapped answers', async () => {
	const api = createFakeApi({ forms: [FORM] });
	const list = await run(executeContext(api, { creds: READ, items: [{ json: {} }], params: { resource: 'form', operation: 'getAll' } }));
	assert.equal(list[0][0].json.name, 'Milk receival');
	const get = await run(executeContext(api, { creds: READ, items: [{ json: {} }], params: { resource: 'form', operation: 'get', formId: FORM.id } }));
	assert.equal(get[0][0].json.sections.length, 1);
	const ctx = executeContext(api, {
		creds: FULL,
		items: [{ json: {} }],
		params: { resource: 'form', operation: 'submit', formId: FORM.id, submittedBy: 'Process Street', answers: mapper({ temp: 3.5, supplier: 'Smith Farm', h: 'x', other: 'y' }) },
	});
	const [out] = await run(ctx);
	assert.deepEqual(ctx.calls.find((c) => c.method === 'POST').body, { fields: { temp: 3.5, supplier: 'Smith Farm' }, submitted_by: 'Process Street' });
	assert.equal(out[0].json.form_id, FORM.id);
	assert.ok(out[0].json.id);
	assert.equal(api.submissions.length, 1);
});

test('Custom app: items are batched, results come back per item, and a bad endpoint never leaves', async () => {
	const api = createFakeApi({ customEndpoints: ['uda-milk/milk-tests'] });
	const items = Array.from({ length: 5 }, (_, i) => ({ json: { external_id: `run-${i}`, litres: 1000 + i } }));
	const ctx = executeContext(api, { creds: FULL, items, params: { resource: 'customApp', operation: 'send', endpoint: '/api/v1/custom/uda-milk/milk-tests', dataMode: 'items', customOptions: { batchSize: 2 } } });
	const [out] = await run(ctx);
	assert.equal(api.customCalls.length, 3);
	assert.deepEqual(api.customCalls.map((c) => c.records.length), [2, 2, 1]);
	assert.deepEqual(out.map((o) => o.json.external_id), ['run-0', 'run-1', 'run-2', 'run-3', 'run-4']);
	assert.deepEqual(out.map((o) => o.pairedItem.item), [0, 1, 2, 3, 4]);

	const bad = executeContext(api, { creds: FULL, items: [{ json: {} }], params: { resource: 'customApp', operation: 'send', endpoint: '../tables/products', dataMode: 'items' } });
	await assert.rejects(run(bad), /Company settings > API/);
	assert.equal(bad.calls.length, 0);
});

test('Custom app: the API per-record errors show in the error description', async () => {
	const api = createFakeApi({ customEndpoints: ['uda-milk/milk-tests'] });
	const ctx = executeContext(api, { creds: FULL, items: [{ json: { external_id: 'a' } }, { json: { litres: 5 } }], params: { resource: 'customApp', operation: 'send', endpoint: 'uda-milk/milk-tests', dataMode: 'items' } });
	await assert.rejects(run(ctx), (e) => /nothing was saved/.test(e.message) && /Record 2: external_id is required/.test(e.description));
});

test('Custom app: JSON mode builds one record per item', async () => {
	const api = createFakeApi({ customEndpoints: ['a/b'] });
	const ctx = executeContext(api, { creds: FULL, items: [{ json: {} }, { json: {} }], params: (i) => ({ resource: 'customApp', operation: 'send', endpoint: 'a/b', dataMode: 'json', recordJson: `{"external_id":"x${i}"}` }) });
	await run(ctx);
	assert.deepEqual(api.customCalls[0].records, [{ external_id: 'x0' }, { external_id: 'x1' }]);
});

test('Load options: tables, writable tables, filter fields, forms and mapper fields', async () => {
	const api = createFakeApi({ forms: [FORM] });
	const lo = (current = {}) => loadOptionsContext(api, { creds: READ, current });
	assert.equal((await node.methods.loadOptions.getAllTables.call(lo())).length, 23);
	assert.equal((await node.methods.loadOptions.getCreatableTables.call(lo())).length, 11);
	assert.equal((await node.methods.loadOptions.getUpdatableTables.call(lo())).length, 12);
	assert.equal((await node.methods.loadOptions.getUpsertableTables.call(lo())).length, 11);
	const filters = await node.methods.loadOptions.getFilterFields.call(lo({ table: 'complaints' }));
	assert.ok(filters.find((f) => f.value === 'status'));
	assert.deepEqual(await node.methods.loadOptions.getFilterFields.call(lo({})), []);
	assert.equal((await node.methods.loadOptions.getForms.call(lo()))[0].value, FORM.id);
	const create = await node.methods.resourceMapping.getCreateFields.call(lo({ table: 'training_records' }));
	assert.equal(create.fields.find((f) => f.id === 'training_name').required, true);
	const form = await node.methods.resourceMapping.getFormFields.call(lo({ formId: FORM.id }));
	assert.deepEqual(form.fields.map((f) => f.id), ['temp', 'supplier']);
});

test('Load options on an API without writes says so plainly', async () => {
	const api = createFakeApi();
	const original = api.handle;
	api.handle = (m, url, h, b) => {
		const res = original(m, url, h, b);
		if (res.body && Array.isArray(res.body.data)) res.body = { ...res.body, data: res.body.data.map((t) => ({ ...t, writes: undefined })) };
		return res;
	};
	await assert.rejects(node.methods.loadOptions.getCreatableTables.call(loadOptionsContext(api, { creds: READ, current: {} })), /doesn't accept creates or updates/);
});

test('A non-JSON reply (wrong Base URL, proxy page) is reported as such', async () => {
	const api = createFakeApi();
	api.handle = () => ({ status: 200, body: '<html>hello</html>' });
	await assert.rejects(
		run(executeContext(api, { creds: { ...READ, environment: 'custom', customUrl: 'https://example.com' }, items: [{ json: {} }], params: { resource: 'form', operation: 'getAll' } })),
		/didn't answer with JSON/,
	);
});

test('A wrong key is a 401 with the fix', async () => {
	const api = createFakeApi();
	await assert.rejects(
		run(executeContext(api, { creds: { apiKey: 'sf_live_wrong' }, items: [{ json: {} }], params: { resource: 'form', operation: 'getAll' } })),
		(e) => e.httpCode === '401' && /sf_live_/.test(e.description),
	);
});
