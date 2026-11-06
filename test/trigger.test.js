'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { SuperfoodAppsTrigger } = require('../dist/nodes/SuperfoodAppsTrigger/SuperfoodAppsTrigger.node.js');
const { createFakeApi } = require('./fake-api');
const { pollContext } = require('./fake-n8n');

const CREDS = { apiKey: 'sf_live_read', environment: 'beta' };
const trigger = new SuperfoodAppsTrigger();

/** A trigger whose static data survives between checks, like n8n's. */
function poller(api, params) {
	const staticData = {};
	return {
		staticData,
		poll: async (mode = 'trigger') => {
			const ctx = pollContext(api, { creds: CREDS, params, staticData, mode });
			const out = await trigger.poll.call(ctx);
			return { rows: out ? out[0].map((x) => x.json) : [], calls: ctx.calls };
		},
	};
}

test('the trigger is a polling trigger on the credential', () => {
	assert.equal(trigger.description.polling, true);
	assert.deepEqual(trigger.description.inputs, []);
	assert.deepEqual(trigger.description.credentials, [{ name: 'superfoodAppsApi', required: true }]);
});

test('first check only marks the starting point; history is never replayed', async () => {
	const api = createFakeApi();
	api.seed('complaints', [{ status: 'Old 1' }, { status: 'Old 2' }]);
	const p = poller(api, { event: 'newRecord', table: 'complaints' });
	assert.deepEqual((await p.poll()).rows, []);
	assert.deepEqual((await p.poll()).rows, [], 'nothing new yet');
	api.seed('complaints', [{ status: 'New 1' }]);
	const third = await p.poll();
	assert.deepEqual(third.rows.map((r) => r.status), ['New 1']);
	assert.ok(third.calls.every((c) => c.url.startsWith('https://beta.superfoodapps.com/api/v1/')));
	assert.equal(third.calls.length, 1, 'a check is one API request');
	assert.deepEqual((await p.poll()).rows, [], 'emitted once');
});

test('first check on an empty table starts from the beginning', async () => {
	const api = createFakeApi();
	const p = poller(api, { event: 'newRecord', table: 'incidents' });
	await p.poll();
	api.seed('incidents', [{ status: 'Open' }]);
	assert.equal((await p.poll()).rows.length, 1);
});

test('New record ignores edits to old records; New or updated record sees them', async () => {
	const api = createFakeApi();
	const [old] = api.seed('assets', [{ name: 'Vat 1' }]);
	const onlyNew = poller(api, { event: 'newRecord', table: 'assets' });
	const any = poller(api, { event: 'newOrUpdatedRecord', table: 'assets' });
	await onlyNew.poll();
	await any.poll();
	// An edit: the change column moves, created_at doesn't.
	old.updated_at = api.tick();
	old.name = 'Vat 1 (relined)';
	assert.deepEqual((await onlyNew.poll()).rows, []);
	assert.deepEqual((await any.poll()).rows.map((r) => r.name), ['Vat 1 (relined)']);
	assert.deepEqual((await any.poll()).rows, [], 'once per change');
	old.updated_at = api.tick();
	assert.equal((await any.poll()).rows.length, 1, 'a second change fires again');
});

test('rows sharing one millisecond are emitted exactly once, even past a page of 200', async () => {
	const api = createFakeApi();
	const p = poller(api, { event: 'newRecord', table: 'sales_lines' });
	await p.poll();
	// 450 lines from one import, all stamped in the same millisecond with
	// different microseconds, then two more a second later.
	const ms = '2026-11-06T05:00:00.123';
	api.seed('sales_lines', Array.from({ length: 450 }, (_, i) => ({ doc_ref: `INV-${i}`, created_at: `${ms}${String(i % 1000).padStart(3, '0')}+00:00` })));
	api.seed('sales_lines', [{ doc_ref: 'LATE-1', created_at: '2026-11-06T05:00:01.000000+00:00' }, { doc_ref: 'LATE-2', created_at: '2026-11-06T05:00:01.000000+00:00' }]);
	const { rows } = await p.poll();
	assert.equal(rows.length, 452);
	assert.equal(new Set(rows.map((r) => r.id)).size, 452);
	assert.deepEqual((await p.poll()).rows, []);
});

test('Max Records per Check leaves the rest for the next check, in order, with none lost', async () => {
	const api = createFakeApi();
	const p = poller(api, { event: 'newRecord', table: 'register_entries', options: { maxPerPoll: 120 } });
	await p.poll();
	api.seed('register_entries', Array.from({ length: 300 }, (_, i) => ({ register_id: '00000000-0000-4000-8000-0000000000aa', data: { n: i } })));
	const seen = [];
	for (let i = 0; i < 4; i++) seen.push(...(await p.poll()).rows);
	assert.equal(seen.length, 300);
	assert.equal(new Set(seen.map((r) => r.id)).size, 300);
	assert.deepEqual(seen.map((r) => r.data.n), Array.from({ length: 300 }, (_, i) => i));
});

test('filters are sent and a changed filter starts over instead of replaying', async () => {
	const api = createFakeApi();
	const params = { event: 'newRecord', table: 'complaints', filters: { conditions: [{ field: 'status', value: 'Open' }] } };
	const p = poller(api, params);
	await p.poll();
	api.seed('complaints', [{ status: 'Open' }, { status: 'Closed' }]);
	const { rows, calls } = await p.poll();
	assert.deepEqual(rows.map((r) => r.status), ['Open']);
	assert.equal(new URL(calls.at(-1).url).searchParams.get('status'), 'Open');
	params.filters.conditions[0].value = 'Closed';
	assert.deepEqual((await p.poll()).rows, [], 'new settings re-prime');
	api.seed('complaints', [{ status: 'Closed' }]);
	assert.equal((await p.poll()).rows.length, 1);
});

test('New form submission watches form_submissions, optionally one form', async () => {
	const api = createFakeApi();
	const p = poller(api, { event: 'newFormSubmission', formId: 'cf-abc' });
	await p.poll();
	api.seed('form_submissions', [{ form_id: 'cf-abc', submitted_by: 'A' }, { form_id: 'cf-other', submitted_by: 'B' }]);
	const { rows, calls } = await p.poll();
	assert.deepEqual(rows.map((r) => r.submitted_by), ['A']);
	assert.ok(calls.at(-1).url.includes('/tables/form_submissions?'));
});

test('a manual test run returns the latest record for mapping and leaves the state alone', async () => {
	const api = createFakeApi();
	api.seed('suppliers', [{ business_name: 'First' }, { business_name: 'Latest' }]);
	const p = poller(api, { event: 'newOrUpdatedRecord', table: 'suppliers' });
	const { rows } = await p.poll('manual');
	assert.deepEqual(rows.map((r) => r.business_name), ['Latest']);
	assert.deepEqual(p.staticData, {});
});
