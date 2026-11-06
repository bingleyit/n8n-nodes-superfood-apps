import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class SuperfoodAppsApi implements ICredentialType {
	name = 'superfoodAppsApi';

	displayName = 'Superfood Apps API';

	icon: Icon = { light: 'file:../nodes/SuperfoodApps/superfood.svg', dark: 'file:../nodes/SuperfoodApps/superfood.dark.svg' };

	documentationUrl = 'https://github.com/bingleyit/n8n-nodes-superfood-apps#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'sf_live_…',
			description:
				'A company API key from Company settings > API in Superfood Apps. Use a read only key unless the workflow creates or updates records.',
		},
		{
			displayName: 'Environment',
			name: 'environment',
			type: 'options',
			default: 'production',
			options: [
				{ name: 'Production (app.superfoodapps.com)', value: 'production' },
				{ name: 'Beta (beta.superfoodapps.com)', value: 'beta' },
				{ name: 'Custom URL', value: 'custom' },
			],
			description:
				'Beta and production share one database, so a workflow pointed at Beta still changes real records',
		},
		{
			displayName: 'Base URL',
			name: 'customUrl',
			type: 'string',
			default: '',
			placeholder: 'https://app.superfoodapps.com',
			displayOptions: { show: { environment: ['custom'] } },
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL:
				'={{ $credentials.environment === "beta" ? "https://beta.superfoodapps.com" : $credentials.environment === "custom" ? String($credentials.customUrl).replace(/\\/+$/, "") : "https://app.superfoodapps.com" }}',
			url: '/api/v1',
			method: 'GET',
		},
	};
}
