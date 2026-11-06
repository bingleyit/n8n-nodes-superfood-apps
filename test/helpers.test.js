'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('../dist/nodes/SuperfoodApps/shared/helpers.js');
const tablesIndex = require('./fixtures/tables-index.json');

const table = (key) => tablesIndex.data.find((t) => t.key === key);

test('resolveBaseUrl picks the environment and tidies a custom URL', () => {
	assert.equal(h.resolveBaseUrl({}), 'https://app.superfoodapps.com');
	assert.equal(h.resolveBaseUrl({ environment: 'production' }), 'https://app.superfoodapps.com');
	assert.equal(h.resolveBaseUrl({ environment: 'beta' }), 'https://beta.superfoodapps.com');
	assert.equal(h.resolveBaseUrl({ environment: 'custom', customUrl: ' https://dev.example.com/api/v1/ ' }), 'https://dev.example.com');
	assert.throws(() => h.resolveBaseUrl({ environment: 'custom', customUrl: '' }), /Base URL/);
});

test('error messages prefer the API sentence and add the fix', () => {
	assert.equal(h.apiErrorMessage(400, { error: 'Pick a register.' }), 'Pick a register.');
	assert.match(h.apiErrorMessage(401, {}), /API key was refused/);
	assert.match(h.apiErrorMessage(502, '<html>'), /HTTP 502/);
	const d = h.apiErrorDescription(400, { error: 'x', errors: [{ index: 2, error: 'external_id is required.' }], not_saved: ['custom'] });
	assert.match(d, /Record 3: external_id is required\./);
	assert.match(d, /Not saved: custom/);
	assert.match(h.apiErrorDescription(403, { error: 'This API key is read only.' }), /Read and write/);
	assert.equal(h.apiErrorDescription(404, { error: 'Record not found.' }), undefined);
});

test('humanize keeps labels readable', () => {
	assert.equal(h.humanize('date_of_complaint'), 'Date of complaint');
	assert.equal(h.humanize('asset_id'), 'Asset ID');
	assert.equal(h.humanize('supplier_ids'), 'Supplier IDs');
});

test('the fixture is the real catalogue: 23 tables, 12 writable', () => {
	assert.equal(tablesIndex.data.length, 23);
	assert.equal(tablesIndex.data.filter((t) => t.writes).length, 12);
	assert.equal(h.canCreate(table('pm_schedules')), false);
	assert.equal(h.canUpdate(table('pm_schedules')), true);
	assert.equal(h.canCreate(table('products')), false);
	const opts = h.tableOptions(tablesIndex.data, h.canCreate);
	assert.equal(opts.length, 11);
	assert.ok(opts.every((o, i) => i === 0 || opts[i - 1].name.localeCompare(o.name) <= 0), 'sorted by label');
	assert.match(opts.find((o) => o.value === 'complaints').description, /^Quality and food safety\./);
});

test('every writable field of every table maps to a mapper column with a sensible type', () => {
	for (const t of tablesIndex.data.filter((x) => x.writes)) {
		const create = h.writeMapperFields(t, 'create');
		assert.deepEqual(create.map((f) => f.id), t.writes.writable_fields, t.key);
		for (const req of t.writes.required_on_create) assert.equal(create.find((f) => f.id === req).required, true, `${t.key}.${req}`);
		assert.ok(h.writeMapperFields(t, 'update').every((f) => f.required === false), `${t.key} update never requires`);
	}
	const complaints = h.writeMapperFields(table('complaints'), 'create');
	assert.equal(complaints.find((f) => f.id === 'custom').type, 'object');
	assert.equal(complaints.find((f) => f.id === 'date_of_complaint').type, 'string', 'dates stay plain text');
	const runs = h.writeMapperFields(table('production_runs'), 'create');
	assert.equal(runs.find((f) => f.id === 'qty').type, 'number');
	assert.equal(runs.find((f) => f.id === 'asset_ids').type, 'array');
});

test('filter fields leave out JSON and list fields', () => {
	const opts = h.filterFieldOptions(table('products'));
	assert.ok(opts.find((o) => o.value === 'sku'));
	assert.ok(!opts.find((o) => o.value === 'custom'));
});

test('cleanWriteBody keeps allowed keys, parses JSON fields and skips empties', () => {
	const t = table('complaints');
	const types = h.fieldTypes(t);
	const allowed = t.writes.writable_fields;
	const r = h.cleanWriteBody(
		{ id: 'x', company_id: 'y', status: 'Open', details: '', root_cause: null, custom: '{"lot":"A1"}', customer_name: 'Coles' },
		allowed,
		types,
		false,
	);
	assert.equal(r.error, undefined);
	assert.deepEqual(r.body, { status: 'Open', custom: { lot: 'A1' }, customer_name: 'Coles' });
	const withEmpty = h.cleanWriteBody({ details: '', status: 'Open' }, allowed, types, true);
	assert.deepEqual(withEmpty.body, { details: null, status: 'Open' });
	const bad = h.cleanWriteBody({ custom: '{oops' }, allowed, types, false);
	assert.match(bad.error, /must be JSON/);
	assert.deepEqual(h.cleanWriteBody(null, allowed, types, false).body, {});
});

test('writeOutput flags fields that did not save', () => {
	assert.deepEqual(h.writeOutput({ data: { id: '1' } }), { id: '1' });
	assert.deepEqual(h.writeOutput({ data: { id: '1' }, not_saved: ['custom'], warnings: ['w'] }), { id: '1', _not_saved: ['custom'], _warnings: ['w'] });
});

test('form fields: headings skipped, repeated labels get their section, selects become dropdowns', () => {
	const form = {
		id: 'cf-1',
		name: 'Milk test',
		sections: [
			{ title: 'Delivery', fields: [{ id: 'h1', label: 'Delivery', type: 'heading' }, { id: 'temp', label: 'Temperature', type: 'number', required: true }, { id: 'ok', label: 'Accepted', type: 'checkbox' }] },
			{ title: 'Silo', fields: [{ id: 'temp2', label: 'Temperature', type: 'number' }, { id: 'silo', label: 'Silo', type: 'select', options: ['S1', 'S2'] }, { id: 'readings', label: 'Readings', type: 'table' }] },
		],
	};
	const fields = h.formMapperFields(form);
	assert.deepEqual(fields.map((f) => f.id), ['temp', 'ok', 'temp2', 'silo', 'readings']);
	assert.equal(fields[0].displayName, 'Delivery: Temperature');
	assert.equal(fields[2].displayName, 'Silo: Temperature');
	assert.equal(fields[0].required, true);
	assert.equal(fields[1].type, 'boolean');
	assert.deepEqual(fields[3].options, [{ name: 'S1', value: 'S1' }, { name: 'S2', value: 'S2' }]);
	assert.equal(fields[4].type, 'array');
});

test('custom endpoints are normalised and checked', () => {
	assert.equal(h.normaliseCustomEndpoint('uda-milk/milk-tests'), 'uda-milk/milk-tests');
	assert.equal(h.normaliseCustomEndpoint('/api/v1/custom/uda-milk/weight-checks/'), 'uda-milk/weight-checks');
	assert.equal(h.normaliseCustomEndpoint('https://app.superfoodapps.com/api/v1/custom/a/b'), 'a/b');
	assert.throws(() => h.normaliseCustomEndpoint('../tables/products'));
	assert.throws(() => h.normaliseCustomEndpoint(''));
	assert.throws(() => h.normaliseCustomEndpoint('a b'));
});

test('chunk and splitCustomReply', () => {
	assert.deepEqual(h.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.deepEqual(h.splitCustomReply({ results: [{ a: 1 }, { a: 2 }] }, 2), [{ a: 1 }, { a: 2 }]);
	assert.deepEqual(h.splitCustomReply({ ok: true }, 2), [{ ok: true }, { ok: true }]);
});

test('advancePoll skips rows already seen at the cursor millisecond', () => {
	const rows = [
		{ id: 'a', updated_at: '2026-11-06T01:00:00.000100+00:00' },
		{ id: 'b', updated_at: '2026-11-06T01:00:00.000900+00:00' },
		{ id: 'c', updated_at: '2026-11-06T01:00:01.000000+00:00' },
	];
	const first = h.advancePoll(rows, '2026-11-06T00:00:00.000Z', [], 'updated_at');
	assert.equal(first.fresh.length, 3);
	assert.equal(first.cursor, '2026-11-06T01:00:01.000Z');
	assert.deepEqual(first.boundary, ['c|2026-11-06T01:00:01.000000+00:00']);
	// The API returns c again (greater or equal): it is not fresh.
	const again = h.advancePoll([rows[2]], first.cursor, first.boundary, 'updated_at');
	assert.equal(again.fresh.length, 0);
	assert.equal(again.cursor, first.cursor);
	// a and b share a millisecond: both land in the boundary.
	const ab = h.advancePoll(rows.slice(0, 2), '2026-11-06T00:00:00.000Z', [], 'updated_at');
	assert.equal(ab.boundary.length, 2);
	// No rows: nothing moves.
	assert.deepEqual(h.advancePoll([], 'x', ['k'], 'updated_at'), { fresh: [], cursor: 'x', boundary: ['k'] });
});

test('isNewSince', () => {
	assert.equal(h.isNewSince({ created_at: '2026-11-06T01:00:00Z' }, 'created_at', '2026-11-06T00:59:59Z'), true);
	assert.equal(h.isNewSince({ created_at: '2026-11-05T01:00:00Z' }, 'created_at', '2026-11-06T00:59:59Z'), false);
	assert.equal(h.isNewSince({}, 'created_at', '2026-11-06T00:59:59Z'), false);
});
