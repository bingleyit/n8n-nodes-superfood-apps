import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

import {
	apiErrorDescription,
	apiErrorMessage,
	resolveBaseUrl,
	USER_AGENT,
	type ApiTable,
	type FormDef,
} from './helpers';

export const CREDENTIAL = 'superfoodAppsApi';

type Ctx = IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions;

/**
 * One call to the Superfood API (`/api/v1` + path). Every failure becomes a
 * NodeApiError carrying the API's own sentence, and a reply that isn't JSON
 * (a proxy error page, a wrong Base URL) says so instead of failing later.
 */
export async function apiRequest(
	this: Ctx,
	method: IHttpRequestMethods,
	path: string,
	opts: { qs?: IDataObject; body?: unknown; itemIndex?: number } = {},
): Promise<IDataObject> {
	const creds = await this.getCredentials(CREDENTIAL);
	const base = resolveBaseUrl(creds);
	const request: IHttpRequestOptions = {
		method,
		url: `${base}/api/v1${path}`,
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (opts.qs && Object.keys(opts.qs).length) request.qs = opts.qs;
	if (opts.body !== undefined) request.body = opts.body as IDataObject;

	const res = (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, request)) as {
		statusCode: number;
		body: unknown;
	};
	const status = Number(res.statusCode) || 0;
	const body = res.body;
	const isJsonObject = typeof body === 'object' && body !== null && !Array.isArray(body);

	if (status >= 400 || status === 0) {
		throw new NodeApiError(this.getNode(), (isJsonObject ? body : { body: String(body ?? '') }) as JsonObject, {
			message: apiErrorMessage(status, body),
			description: apiErrorDescription(status, body),
			httpCode: String(status),
			itemIndex: opts.itemIndex,
		});
	}
	if (!isJsonObject) {
		throw new NodeApiError(this.getNode(), { body: String(body ?? '').slice(0, 500) } as JsonObject, {
			message: "The Superfood API didn't answer with JSON.",
			description: `HTTP ${status}. Check the Environment and Base URL in the credential.`,
			httpCode: String(status),
			itemIndex: opts.itemIndex,
		});
	}
	return body as IDataObject;
}

export async function getTables(this: Ctx): Promise<ApiTable[]> {
	const res = await apiRequest.call(this, 'GET', '/tables');
	return (Array.isArray(res.data) ? res.data : []) as unknown as ApiTable[];
}

export async function getTable(this: Ctx, key: string, itemIndex?: number): Promise<ApiTable> {
	const res = await apiRequest.call(this, 'GET', `/tables/${encodeURIComponent(key)}/fields`, { itemIndex });
	return res as unknown as ApiTable;
}

export async function getForm(this: Ctx, id: string, itemIndex?: number): Promise<FormDef> {
	const res = await apiRequest.call(this, 'GET', `/forms/${encodeURIComponent(id)}`, { itemIndex });
	return (res.form ?? {}) as unknown as FormDef;
}
