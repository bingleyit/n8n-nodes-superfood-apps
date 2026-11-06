import type { INodeProperties } from 'n8n-workflow';


const show = (resource: string, operation: string[]) => ({ show: { resource: [resource], operation } });

export const resourceProperty: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [
		{ name: 'Custom App', value: 'customApp', description: 'Endpoints built for your company' },
		{ name: 'Form', value: 'form', description: 'Forms and form submissions' },
		{ name: 'Record', value: 'record', description: 'Rows in any Superfood table' },
	],
	default: 'record',
};

// ── Record ────────────────────────────────────────────────────────────────

const recordOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['record'] } },
	options: [
		{ name: 'Create', value: 'create', description: 'Create a record', action: 'Create a record' },
		{
			name: 'Create or Update',
			value: 'upsert',
			description: 'Create a new record, or update the current one if it already exists (upsert)',
			action: 'Create or update a record',
		},
		{ name: 'Get', value: 'get', description: 'Get a record by ID', action: 'Get a record' },
		{ name: 'Get Many', value: 'getAll', description: 'Get many records', action: 'Get many records' },
		{ name: 'Update', value: 'update', description: 'Update a record', action: 'Update a record' },
	],
	default: 'getAll',
};

const tableFor = (operation: string[], method: string): INodeProperties => ({
	displayName: 'Table Name or ID',
	name: 'table',
	type: 'options',
	typeOptions: { loadOptionsMethod: method },
	required: true,
	default: '',
	description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
	displayOptions: show('record', operation),
});

const mapperFor = (operation: string[], method: string, required: boolean): INodeProperties => ({
	displayName: 'Fields',
	name: 'fields',
	type: 'resourceMapper',
	noDataExpression: true,
	default: { mappingMode: 'defineBelow', value: null },
	required,
	typeOptions: {
		loadOptionsDependsOn: ['table'],
		resourceMapper: {
			resourceMapperMethod: method,
			mode: 'add',
			fieldWords: { singular: 'field', plural: 'fields' },
			addAllFields: false,
			multiKeyMatch: false,
			supportAutoMap: true,
		},
	},
	displayOptions: show('record', operation),
});

const recordFields: INodeProperties[] = [
	tableFor(['get', 'getAll'], 'getAllTables'),
	tableFor(['create'], 'getCreatableTables'),
	tableFor(['update'], 'getUpdatableTables'),
	tableFor(['upsert'], 'getUpsertableTables'),
	{
		displayName: 'Record ID',
		name: 'recordId',
		type: 'string',
		required: true,
		default: '',
		placeholder: '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90',
		description: 'The record\'s ID (a UUID), for example from an earlier Get Many',
		displayOptions: show('record', ['get', 'update']),
	},
	{
		displayName: 'Match on Field Name or ID',
		name: 'matchField',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getFilterFields', loadOptionsDependsOn: ['table'] },
		required: true,
		default: '',
		description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		hint: 'The field that identifies the record, for example a reference number',
		displayOptions: show('record', ['upsert']),
	},
	{
		displayName: 'Match Value',
		name: 'matchValue',
		type: 'string',
		required: true,
		default: '',
		description: 'The value the matched record has in that field. If no record has it, a new one is created.',
		displayOptions: show('record', ['upsert']),
	},
	mapperFor(['create', 'upsert'], 'getCreateFields', true),
	mapperFor(['update'], 'getUpdateFields', true),
	{
		displayName: 'Options',
		name: 'writeOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: show('record', ['create', 'update', 'upsert']),
		options: [
			{
				displayName: 'Send Empty Values',
				name: 'sendEmpty',
				type: 'boolean',
				default: false,
				description:
					'Whether fields left empty are sent as blank. Off: empty fields are skipped, so an update never clears a field by accident.',
			},
		],
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: show('record', ['getAll']),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: { show: { resource: ['record'], operation: ['getAll'], returnAll: [false] } },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'fixedCollection',
		placeholder: 'Add filter',
		typeOptions: { multipleValues: true },
		default: {},
		description: 'Only records whose field equals the value. Use the word null to find empty fields.',
		displayOptions: show('record', ['getAll']),
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
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
					},
				],
			},
		],
	},
	{
		displayName: 'Options',
		name: 'listOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: show('record', ['getAll']),
		options: [
			{
				displayName: 'Changed Since',
				name: 'updatedSince',
				type: 'dateTime',
				default: '',
				description: 'Only records created or changed at or after this time',
			},
			{
				displayName: 'Max Records (Return All)',
				name: 'maxRecords',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 5000,
				description:
					'Stops Return All after this many records, so a very large table (such as sales lines) can\'t run for hours',
			},
			{
				displayName: 'Sort',
				name: 'order',
				type: 'options',
				options: [
					{ name: 'Oldest Change First', value: 'asc' },
					{ name: 'Newest Change First', value: 'desc' },
				],
				default: 'asc',
			},
		],
	},
];

// ── Form ──────────────────────────────────────────────────────────────────

const formOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['form'] } },
	options: [
		{ name: 'Get', value: 'get', description: 'Get a form and its fields', action: 'Get a form' },
		{ name: 'Get Many', value: 'getAll', description: 'Get many forms', action: 'Get many forms' },
		{
			name: 'Submit',
			value: 'submit',
			description: 'Submit a completed form. It lands in the QA queue.',
			action: 'Submit a form',
		},
	],
	default: 'submit',
};

const formFields: INodeProperties[] = [
	{
		displayName: 'Form Name or ID',
		name: 'formId',
		type: 'options',
		description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		typeOptions: { loadOptionsMethod: 'getForms' },
		required: true,
		default: '',
		displayOptions: show('form', ['get', 'submit']),
	},
	{
		displayName: 'Submitted By',
		name: 'submittedBy',
		type: 'string',
		default: '',
		placeholder: 'Sam Smith',
		description: 'The name shown as the person who filled the form',
		displayOptions: show('form', ['submit']),
	},
	{
		displayName: 'Answers',
		name: 'answers',
		type: 'resourceMapper',
		noDataExpression: true,
		default: { mappingMode: 'defineBelow', value: null },
		required: true,
		typeOptions: {
			loadOptionsDependsOn: ['formId'],
			resourceMapper: {
				resourceMapperMethod: 'getFormFields',
				mode: 'add',
				fieldWords: { singular: 'answer', plural: 'answers' },
				addAllFields: true,
				multiKeyMatch: false,
				supportAutoMap: true,
			},
		},
		displayOptions: show('form', ['submit']),
	},
];

// ── Custom app ────────────────────────────────────────────────────────────

const customAppOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['customApp'] } },
	options: [
		{
			name: 'Send Records',
			value: 'send',
			description: 'Send records to one of your company\'s custom endpoints',
			action: 'Send records to a custom endpoint',
		},
	],
	default: 'send',
};

const customAppFields: INodeProperties[] = [
	{
		displayName: 'Endpoint',
		name: 'endpoint',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'my-app/records',
		description:
			'The part after /api/v1/custom/, as listed under Custom app endpoints in Company settings > API',
		displayOptions: show('customApp', ['send']),
	},
	{
		displayName: 'Send',
		name: 'dataMode',
		type: 'options',
		options: [
			{ name: 'Each Input Item as a Record', value: 'items' },
			{ name: 'JSON Defined Below', value: 'json' },
		],
		default: 'items',
		displayOptions: show('customApp', ['send']),
	},
	{
		displayName: 'Record (JSON)',
		name: 'recordJson',
		type: 'json',
		default: '{\n  "external_id": ""\n}',
		description: 'One record per input item. Use expressions to fill it from the item.',
		displayOptions: { show: { resource: ['customApp'], operation: ['send'], dataMode: ['json'] } },
	},
	{
		displayName: 'Options',
		name: 'customOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: show('customApp', ['send']),
		options: [
			{
				displayName: 'Batch Size',
				name: 'batchSize',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 200 },
				default: 50,
				description: 'How many records go in one request (at most 200)',
			},
		],
	},
];

export const nodeProperties: INodeProperties[] = [
	resourceProperty,
	recordOperations,
	...recordFields,
	formOperations,
	...formFields,
	customAppOperations,
	...customAppFields,
];
