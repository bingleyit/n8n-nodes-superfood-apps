import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { nodeProperties } from './descriptions';
import {
	canCreate,
	canUpdate,
	chunk,
	cleanWriteBody,
	CUSTOM_BATCH_MAX,
	fieldTypes,
	formFieldTypes,
	formMapperFields,
	normaliseCustomEndpoint,
	PAGE_MAX,
	splitCustomReply,
	writeOutput,
	type ApiTable,
	type FormDef,
} from './shared/helpers';
import {
	getAllTables,
	getCreatableTables,
	getCreateFields,
	getFilterFields,
	getFormFields,
	getForms,
	getUpdatableTables,
	getUpdateFields,
	getUpsertableTables,
} from './shared/methods';
import { apiRequest, CREDENTIAL, getForm, getTable } from './shared/transport';

const enc = encodeURIComponent;

export class SuperfoodApps implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Superfood Apps',
		name: 'superfoodApps',
		icon: { light: 'file:superfood.svg', dark: 'file:superfood.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Read and write records, forms and custom app data in Superfood Apps',
		defaults: { name: 'Superfood Apps' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: CREDENTIAL, required: true }],
		properties: nodeProperties,
	};

	methods = {
		loadOptions: {
			getAllTables,
			getCreatableTables,
			getUpdatableTables,
			getUpsertableTables,
			getFilterFields,
			getForms,
		},
		resourceMapping: {
			getCreateFields,
			getUpdateFields,
			getFormFields,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		if (resource === 'customApp' && operation === 'send') {
			return [await sendCustomRecords.call(this, items)];
		}

		const out: INodeExecutionData[] = [];
		const tables = new Map<string, ApiTable>();
		const forms = new Map<string, FormDef>();
		const tableOf = async (key: string, i: number) => {
			let t = tables.get(key);
			if (!t) {
				t = await getTable.call(this, key, i);
				tables.set(key, t);
			}
			return t;
		};
		const formOf = async (id: string, i: number) => {
			let f = forms.get(id);
			if (!f) {
				f = await getForm.call(this, id, i);
				forms.set(id, f);
			}
			return f;
		};

		for (let i = 0; i < items.length; i++) {
			try {
				const push = (json: IDataObject) => out.push({ json, pairedItem: { item: i } });

				if (resource === 'record') {
					const tableKey = this.getNodeParameter('table', i) as string;

					if (operation === 'get') {
						const id = (this.getNodeParameter('recordId', i) as string).trim();
						const res = await apiRequest.call(this, 'GET', `/tables/${enc(tableKey)}/${enc(id)}`, { itemIndex: i });
						push((res.data ?? {}) as IDataObject);
						continue;
					}

					if (operation === 'getAll') {
						for (const row of await listRecords.call(this, tableKey, i)) push(row);
						continue;
					}

					const t = await tableOf(tableKey, i);
					const body = mappedBody.call(this, i, items[i].json, 'fields', t.writes?.writable_fields ?? [], fieldTypes(t));

					if (operation === 'create') {
						if (!canCreate(t)) throw new NodeOperationError(this.getNode(), `${t.label} can't be created through the API.`, { itemIndex: i });
						const res = await apiRequest.call(this, 'POST', `/tables/${enc(tableKey)}`, { body, itemIndex: i });
						push(writeOutput(res) as IDataObject);
						continue;
					}

					if (operation === 'update') {
						if (!canUpdate(t)) throw new NodeOperationError(this.getNode(), `${t.label} can't be updated through the API.`, { itemIndex: i });
						const id = (this.getNodeParameter('recordId', i) as string).trim();
						requireSomething.call(this, body, i);
						const res = await apiRequest.call(this, 'PATCH', `/tables/${enc(tableKey)}/${enc(id)}`, { body, itemIndex: i });
						push(writeOutput(res) as IDataObject);
						continue;
					}

					if (operation === 'upsert') {
						const matchField = this.getNodeParameter('matchField', i) as string;
						const matchValue = String(this.getNodeParameter('matchValue', i) ?? '').trim();
						if (!matchField || !matchValue) {
							throw new NodeOperationError(this.getNode(), 'Pick a field to match on and give it a value.', { itemIndex: i });
						}
						const found = await apiRequest.call(this, 'GET', `/tables/${enc(tableKey)}`, {
							qs: { [matchField]: matchValue, limit: 2 },
							itemIndex: i,
						});
						const matches = (Array.isArray(found.data) ? found.data : []) as IDataObject[];
						if (matches.length > 1) {
							throw new NodeOperationError(
								this.getNode(),
								`More than one ${t.label.toLowerCase()} record has ${matchField} = ${matchValue}, so nothing was saved.`,
								{ itemIndex: i, description: 'Match on a field that is unique to one record.' },
							);
						}
						if (matches.length === 1) {
							requireSomething.call(this, body, i);
							const res = await apiRequest.call(this, 'PATCH', `/tables/${enc(tableKey)}/${enc(String(matches[0].id))}`, { body, itemIndex: i });
							push({ ...(writeOutput(res) as IDataObject), _action: 'updated' });
						} else {
							const res = await apiRequest.call(this, 'POST', `/tables/${enc(tableKey)}`, { body, itemIndex: i });
							push({ ...(writeOutput(res) as IDataObject), _action: 'created' });
						}
						continue;
					}
				}

				if (resource === 'form') {
					if (operation === 'getAll') {
						const res = await apiRequest.call(this, 'GET', '/forms', { itemIndex: i });
						for (const f of (Array.isArray(res.forms) ? res.forms : []) as IDataObject[]) push(f);
						continue;
					}
					const formId = this.getNodeParameter('formId', i) as string;
					if (operation === 'get') {
						push((await formOf(formId, i)) as unknown as IDataObject);
						continue;
					}
					if (operation === 'submit') {
						const form = await formOf(formId, i);
						const allowed = formMapperFields(form).map((f) => f.id);
						const fields = mappedBody.call(this, i, items[i].json, 'answers', allowed, formFieldTypes(form));
						requireSomething.call(this, fields, i);
						const submittedBy = (this.getNodeParameter('submittedBy', i, '') as string).trim();
						const res = await apiRequest.call(this, 'POST', `/forms/${enc(formId)}/submissions`, {
							body: { fields, ...(submittedBy ? { submitted_by: submittedBy } : {}) },
							itemIndex: i,
						});
						push({ form_id: formId, ...((res.submission ?? res) as IDataObject) });
						continue;
					}
				}

				throw new NodeOperationError(this.getNode(), `The operation "${operation}" isn't supported for ${resource}.`, { itemIndex: i });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Re-wrapping hands back the original error, keeping its HTTP code.
				if (error instanceof NodeApiError) throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex: i });
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [out];
	}
}

/** The values a write sends: the mapper's own values, or the input item when
 *  the user picked "Map automatically". Only the fields the API accepts pass. */
function mappedBody(
	this: IExecuteFunctions,
	i: number,
	itemJson: IDataObject,
	param: string,
	allowed: readonly string[],
	types: Record<string, string>,
): IDataObject {
	const mode = this.getNodeParameter(`${param}.mappingMode`, i, 'defineBelow') as string;
	const values =
		mode === 'autoMapInputData'
			? (itemJson as Record<string, unknown>)
			: ((this.getNodeParameter(`${param}.value`, i, {}) as Record<string, unknown> | null) ?? {});
	const sendEmpty = param === 'fields' ? (this.getNodeParameter('writeOptions.sendEmpty', i, false) as boolean) : false;
	const cleaned = cleanWriteBody(values, allowed, types as never, sendEmpty);
	if (cleaned.error) throw new NodeOperationError(this.getNode(), cleaned.error, { itemIndex: i });
	return cleaned.body as IDataObject;
}

function requireSomething(this: IExecuteFunctions, body: IDataObject, i: number) {
	if (!Object.keys(body).length) {
		throw new NodeOperationError(this.getNode(), 'Nothing to send: map at least one field.', { itemIndex: i });
	}
}

/** Get Many: pages of up to 200 until the limit, the end, or the Return All cap. */
async function listRecords(this: IExecuteFunctions, tableKey: string, i: number): Promise<IDataObject[]> {
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const opts = this.getNodeParameter('listOptions', i, {}) as { updatedSince?: string; maxRecords?: number; order?: string };
	const want = returnAll ? Math.max(1, Number(opts.maxRecords) || 5000) : Math.max(1, Number(this.getNodeParameter('limit', i, 50)) || 50);
	const conditions = ((this.getNodeParameter('filters', i, {}) as { conditions?: { field?: string; value?: string }[] }).conditions ?? [])
		.filter((c) => c.field);

	const qs: IDataObject = { order: opts.order === 'desc' ? 'desc' : 'asc' };
	if (opts.updatedSince) qs.updated_since = new Date(opts.updatedSince).toISOString();
	for (const c of conditions) qs[c.field as string] = String(c.value ?? '');

	const rows: IDataObject[] = [];
	let offset = 0;
	while (rows.length < want) {
		const limit = Math.min(PAGE_MAX, want - rows.length);
		const res = await apiRequest.call(this, 'GET', `/tables/${enc(tableKey)}`, { qs: { ...qs, limit, offset }, itemIndex: i });
		const page = (Array.isArray(res.data) ? res.data : []) as IDataObject[];
		rows.push(...page);
		if (!res.has_more || !page.length) break;
		offset = typeof res.next_offset === 'number' ? res.next_offset : offset + page.length;
	}
	return rows;
}

/** Custom app endpoints take up to 200 records a request; each item gets its
 *  own result back when the endpoint lists results in order. */
async function sendCustomRecords(this: IExecuteFunctions, items: INodeExecutionData[]): Promise<INodeExecutionData[]> {
	const out: INodeExecutionData[] = [];
	const groups = new Map<string, { index: number; record: IDataObject }[]>();
	const failed = (i: number, message: string) => out.push({ json: { error: message }, pairedItem: { item: i } });

	for (let i = 0; i < items.length; i++) {
		try {
			const endpoint = normaliseCustomEndpoint(this.getNodeParameter('endpoint', i) as string);
			const mode = this.getNodeParameter('dataMode', i, 'items') as string;
			let record: IDataObject;
			if (mode === 'json') {
				const raw = this.getNodeParameter('recordJson', i, '{}');
				record = (typeof raw === 'string' ? JSON.parse(raw) : raw) as IDataObject;
			} else {
				record = { ...items[i].json };
			}
			if (typeof record !== 'object' || record === null || Array.isArray(record)) {
				throw new NodeOperationError(this.getNode(), 'Each record must be a JSON object.', { itemIndex: i });
			}
			const size = Math.min(CUSTOM_BATCH_MAX, Math.max(1, Number((this.getNodeParameter('customOptions', i, {}) as IDataObject).batchSize) || 50));
			const key = `${endpoint}#${size}`;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push({ index: i, record });
		} catch (error) {
			if (this.continueOnFail()) {
				failed(i, (error as Error).message);
				continue;
			}
			throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
		}
	}

	for (const [key, entries] of groups) {
		const [endpoint, sizeText] = key.split('#');
		for (const batch of chunk(entries, Number(sizeText))) {
			try {
				const res = await apiRequest.call(this, 'POST', `/custom/${endpoint}`, {
					body: { records: batch.map((b) => b.record) },
					itemIndex: batch[0].index,
				});
				const results = splitCustomReply(res, batch.length);
				batch.forEach((b, k) => out.push({ json: results[k] as IDataObject, pairedItem: { item: b.index } }));
			} catch (error) {
				if (!this.continueOnFail()) {
					if (error instanceof NodeApiError) throw new NodeApiError(this.getNode(), error as unknown as JsonObject);
					throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: batch[0].index });
				}
				for (const b of batch) failed(b.index, (error as Error).message);
			}
		}
	}

	return out.sort((a, b) => (a.pairedItem as { item: number }).item - (b.pairedItem as { item: number }).item);
}
