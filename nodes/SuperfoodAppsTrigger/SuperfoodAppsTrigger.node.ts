import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import {
	advancePoll,
	isNewSince,
	PAGE_MAX,
	rowKey,
	type PollState,
} from '../SuperfoodApps/shared/helpers';
import { getAllTables, getFilterFields, getForms } from '../SuperfoodApps/shared/methods';
import { apiRequest, CREDENTIAL, getTable } from '../SuperfoodApps/shared/transport';


/** Before any change exists, the first poll starts from the beginning. */
const EPOCH = '1970-01-01T00:00:00.000Z';

export class SuperfoodAppsTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Superfood Apps Trigger',
		name: 'superfoodAppsTrigger',
		icon: { light: 'file:../SuperfoodApps/superfood.svg', dark: 'file:../SuperfoodApps/superfood.dark.svg' },
		group: ['trigger'],
		version: [1],
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts the workflow when records are added or changed in Superfood Apps',
		defaults: { name: 'Superfood Apps Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		properties: [
			{
				displayName:
					'Superfood Apps is checked on the schedule below. Every check counts as one API request in Company settings > API, so every 5 minutes or longer is usually enough.',
				name: 'pollNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Trigger On',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'New Form Submission',
						value: 'newFormSubmission',
						description: 'A form was submitted (in the app, on a kiosk or through the API)',
					},
					{ name: 'New Record', value: 'newRecord', description: 'A record was added to a table' },
					{
						name: 'New or Updated Record',
						value: 'newOrUpdatedRecord',
						description: 'A record was added or changed',
					},
				],
				default: 'newRecord',
			},
			{
				displayName: 'Table Name or ID',
				name: 'table',
				type: 'options',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: { loadOptionsMethod: 'getAllTables' },
				required: true,
				default: '',
				displayOptions: { show: { event: ['newRecord', 'newOrUpdatedRecord'] } },
			},
			{
				displayName: 'Form Name or ID',
				name: 'formId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getForms' },
				default: '',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				hint: 'Leave empty to trigger on every form',
				displayOptions: { show: { event: ['newFormSubmission'] } },
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'fixedCollection',
				placeholder: 'Add filter',
				typeOptions: { multipleValues: true },
				default: {},
				description: 'Only records whose field equals the value',
				displayOptions: { show: { event: ['newRecord', 'newOrUpdatedRecord'] } },
				options: [
					{
						displayName: 'Condition',
						name: 'conditions',
						values: [
							{
								displayName: 'Field Name or ID',
								name: 'field',
								type: 'options',
								description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
								typeOptions: { loadOptionsMethod: 'getFilterFields', loadOptionsDependsOn: ['table'] },
								default: '',
							},
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Max Records per Check',
						name: 'maxPerPoll',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 1000,
						description: 'The rest wait for the next check, so a big import never floods the workflow',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: { getAllTables, getFilterFields, getForms },
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const event = this.getNodeParameter('event') as string;
		const isForm = event === 'newFormSubmission';
		const tableKey = isForm ? 'form_submissions' : (this.getNodeParameter('table') as string);
		const filters: IDataObject = {};
		if (isForm) {
			const formId = this.getNodeParameter('formId', '') as string;
			if (formId) filters.form_id = formId;
		} else {
			const conditions = (this.getNodeParameter('filters', {}) as { conditions?: { field?: string; value?: string }[] }).conditions ?? [];
			for (const c of conditions) if (c.field) filters[c.field] = String(c.value ?? '');
		}
		const maxPerPoll = Math.max(1, Number((this.getNodeParameter('options', {}) as IDataObject).maxPerPoll) || 1000);

		const path = `/tables/${encodeURIComponent(tableKey)}`;
		const onlyNew = event !== 'newOrUpdatedRecord';

		// A manual test run shows the latest record so the user can map fields.
		if (this.getMode() === 'manual') {
			const res = await apiRequest.call(this, 'GET', path, { qs: { ...filters, order: 'desc', limit: 1 } });
			const rows = (Array.isArray(res.data) ? res.data : []) as IDataObject[];
			return rows.length ? [this.helpers.returnJsonArray(rows)] : null;
		}

		const state = this.getWorkflowStaticData('node') as PollState;
		const signature = JSON.stringify([event, tableKey, filters]);
		if (state.signature !== signature || !state.cursor || !state.changedField) {
			// First check (or the settings changed): start after the newest
			// existing record, using the server's own clock, so history isn't replayed.
			const table = await getTable.call(this, tableKey);
			const changedField = table.changed_field;
			const res = await apiRequest.call(this, 'GET', path, { qs: { ...filters, order: 'desc', limit: 1 } });
			const latest = ((Array.isArray(res.data) ? res.data : []) as IDataObject[])[0];
			const start = advancePoll(latest ? [latest] : [], EPOCH, [], changedField);
			state.signature = signature;
			state.cursor = start.cursor;
			state.boundary = start.boundary;
			state.changedField = changedField;
			state.createdField = table.fields.some((f) => f.name === 'created_at') ? 'created_at' : changedField;
			return null;
		}
		const changed = state.changedField;
		const createdField = state.createdField ?? changed;

		const since = state.cursor;
		let cursor = state.cursor;
		let boundary = state.boundary ?? [];
		let offset = 0;
		const emitted: IDataObject[] = [];
		const emittedIds = new Set<string>();
		// Records already seen at the starting millisecond were created before
		// this check, whatever their creation time says.
		const startIds = new Set((state.boundary ?? []).map((k) => k.slice(0, k.indexOf('|'))));
		const started = Date.now();
		const budget = typeof this.getPollBudgetMs === 'function' ? this.getPollBudgetMs() : 60_000;

		while (emitted.length < maxPerPoll && Date.now() - started < budget * 0.8) {
			const res = await apiRequest.call(this, 'GET', path, {
				qs: { ...filters, updated_since: cursor, order: 'asc', limit: PAGE_MAX, offset },
			});
			const rows = (Array.isArray(res.data) ? res.data : []) as IDataObject[];
			if (!rows.length) break;
			// Take rows in order until the cap; the cursor only moves past rows
			// actually taken, so the rest come back on the next check.
			const seen = new Set(boundary);
			const consumed: IDataObject[] = [];
			for (const row of rows) {
				if (emitted.length >= maxPerPoll) break;
				consumed.push(row);
				if (seen.has(rowKey(row, changed))) continue;
				const id = String(row.id);
				if (onlyNew && (emittedIds.has(id) || startIds.has(id) || !isNewSince(row, createdField, since))) continue;
				emittedIds.add(id);
				emitted.push(row);
			}
			const step = advancePoll(consumed, cursor, boundary, changed);
			// More rows than a page share one millisecond: step through them by
			// offset; otherwise the cursor moved and paging restarts from it.
			offset = step.cursor === cursor ? offset + consumed.length : 0;
			cursor = step.cursor;
			boundary = step.boundary;
			if (consumed.length < rows.length || !res.has_more) break;
		}

		state.cursor = cursor;
		state.boundary = boundary;
		return emitted.length ? [this.helpers.returnJsonArray(emitted)] : null;
	}
}
