import type { ILoadOptionsFunctions, INodePropertyOptions, ResourceMapperFields } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	canCreate,
	canUpdate,
	filterFieldOptions,
	formMapperFields,
	tableOptions,
	writeMapperFields,
} from './helpers';
import { apiRequest, getForm, getTable, getTables } from './transport';

const NO_WRITES =
	"This Superfood account doesn't accept creates or updates through the API yet. Reading still works.";

function currentTable(ctx: ILoadOptionsFunctions): string {
	const v = ctx.getCurrentNodeParameter('table');
	return typeof v === 'string' ? v : '';
}

function currentForm(ctx: ILoadOptionsFunctions): string {
	const v = ctx.getCurrentNodeParameter('formId');
	return typeof v === 'string' ? v : '';
}

export async function getAllTables(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return tableOptions(await getTables.call(this));
}

export async function getCreatableTables(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const options = tableOptions(await getTables.call(this), canCreate);
	if (!options.length) throw new NodeOperationError(this.getNode(), NO_WRITES);
	return options;
}

export async function getUpdatableTables(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const options = tableOptions(await getTables.call(this), canUpdate);
	if (!options.length) throw new NodeOperationError(this.getNode(), NO_WRITES);
	return options;
}

export async function getUpsertableTables(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const options = tableOptions(await getTables.call(this), (t) => canCreate(t) && canUpdate(t));
	if (!options.length) throw new NodeOperationError(this.getNode(), NO_WRITES);
	return options;
}

export async function getFilterFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const key = currentTable(this);
	if (!key) return [];
	return filterFieldOptions(await getTable.call(this, key));
}

export async function getForms(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const res = await apiRequest.call(this, 'GET', '/forms');
	const forms = (Array.isArray(res.forms) ? res.forms : []) as { id: string; name: string; category?: string }[];
	return forms
		.map((f) => ({ name: f.name, value: f.id, description: f.category ?? '' }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCreateFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const key = currentTable(this);
	if (!key) return { fields: [] };
	const t = await getTable.call(this, key);
	return { fields: writeMapperFields(t, 'create'), emptyFieldsNotice: `${t.label} can't be created through the API.` };
}

export async function getUpdateFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const key = currentTable(this);
	if (!key) return { fields: [] };
	const t = await getTable.call(this, key);
	return { fields: writeMapperFields(t, 'update'), emptyFieldsNotice: `${t.label} can't be updated through the API.` };
}

export async function getFormFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const id = currentForm(this);
	if (!id) return { fields: [] };
	const form = await getForm.call(this, id);
	return { fields: formMapperFields(form), emptyFieldsNotice: 'This form has no fields to fill.' };
}
