'use strict';
// Minimal stand-ins for the n8n function contexts the node uses. HTTP goes to
// the fake API with the credential's own `authenticate` header applied, the
// way n8n's httpRequestWithAuthentication does it.

const { SuperfoodAppsApi } = require('../dist/credentials/SuperfoodAppsApi.credentials.js');

function getPath(obj, path) {
	return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function authHeaders(creds) {
	const cred = new SuperfoodAppsApi();
	const out = {};
	for (const [name, tmpl] of Object.entries(cred.authenticate.properties.headers)) {
		out[name] = String(tmpl).replace(/^=/, '').replace('{{$credentials.apiKey}}', creds.apiKey);
	}
	return out;
}

function baseContext(api, { creds, node = { name: 'Superfood Apps', type: 'n8n-nodes-superfood-apps.superfoodApps', typeVersion: 1, parameters: {} } }) {
	const calls = [];
	const helpers = {
		async httpRequestWithAuthentication(credName, req) {
			if (credName !== 'superfoodAppsApi') throw new Error(`wrong credential ${credName}`);
			const u = new URL(req.url);
			for (const [k, v] of Object.entries(req.qs || {})) u.searchParams.set(k, String(v));
			const headers = { ...(req.headers || {}), ...authHeaders(creds) };
			calls.push({ method: req.method, url: u.toString(), headers, body: req.body });
			// Clone through JSON: the node must never share objects with the "server".
			const body = req.body === undefined ? undefined : JSON.parse(JSON.stringify(req.body));
			const res = api.handle(req.method, u.pathname + u.search, headers, body);
			const out = { statusCode: res.status, body: JSON.parse(JSON.stringify(res.body)), headers: {} };
			if (!req.ignoreHttpStatusErrors && res.status >= 400) {
				const e = new Error(`HTTP ${res.status}`);
				e.response = out;
				throw e;
			}
			return req.returnFullResponse ? out : out.body;
		},
		returnJsonArray(list) {
			return list.map((json) => ({ json }));
		},
	};
	return {
		calls,
		helpers,
		getNode: () => node,
		async getCredentials(name) {
			if (name !== 'superfoodAppsApi') throw new Error(`wrong credential ${name}`);
			return creds;
		},
	};
}

/** An IExecuteFunctions over `items`, with parameters given per item index
 *  (a function (i) => params) or once for every item (an object). */
function executeContext(api, { creds, items, params, continueOnFail = false }) {
	const ctx = baseContext(api, { creds });
	const paramsFor = typeof params === 'function' ? params : () => params;
	return Object.assign(ctx, {
		getInputData: () => items,
		continueOnFail: () => continueOnFail,
		getNodeParameter(name, i, fallback) {
			const v = getPath(paramsFor(i), name);
			if (v === undefined) {
				if (arguments.length >= 3) return fallback;
				throw new Error(`missing parameter ${name}`);
			}
			return v;
		},
	});
}

function loadOptionsContext(api, { creds, current }) {
	const ctx = baseContext(api, { creds });
	return Object.assign(ctx, {
		getCurrentNodeParameter: (name) => current[name],
		getNodeParameter: (name, fallback) => (name in current ? current[name] : fallback),
	});
}

function pollContext(api, { creds, params, staticData = {}, mode = 'trigger' }) {
	const ctx = baseContext(api, { creds });
	return Object.assign(ctx, {
		staticData,
		getMode: () => mode,
		getWorkflowStaticData: () => staticData,
		getNodeParameter(name, fallback) {
			const v = getPath(params, name);
			if (v === undefined) {
				if (arguments.length >= 2) return fallback;
				throw new Error(`missing parameter ${name}`);
			}
			return v;
		},
	});
}

module.exports = { executeContext, loadOptionsContext, pollContext };
