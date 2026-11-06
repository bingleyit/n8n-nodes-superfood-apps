'use strict';
// Serves the in-memory Superfood API over HTTP so a real n8n can run the node
// against it: `node test/serve-fake-api.js 5679`, then point a credential's
// Custom URL at http://127.0.0.1:5679. Prints each request it answers.

const http = require('node:http');
const { createFakeApi } = require('./fake-api');

const port = Number(process.argv[2] || 5679);
const api = createFakeApi({
	customEndpoints: ['demo-app/readings'],
	forms: [
		{
			id: 'cf-11111111-1111-4111-8111-111111111111',
			name: 'Milk receival',
			category: 'Quality',
			sections: [{ title: 'Milk', fields: [{ id: 'temp', label: 'Temperature', type: 'number', required: true }, { id: 'supplier', label: 'Supplier', type: 'text' }] }],
		},
	],
});
api.seed('products', [{ product_name: 'Greek yoghurt 1kg', sku: 'GY1' }, { product_name: 'Feta 200g', sku: 'FE2' }]);
api.seed('complaints', [{ status: 'Open', customer_name: 'Coles', details: 'Lid split' }]);

http
	.createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			let body;
			try {
				body = raw ? JSON.parse(raw) : undefined;
			} catch {
				body = raw;
			}
			const out = api.handle(req.method, req.url, req.headers, body);
			process.stdout.write(`${req.method} ${req.url} ${out.status} auth=${req.headers.authorization ? 'Bearer' : 'none'} ua=${req.headers['user-agent']}\n`);
			res.writeHead(out.status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(out.body));
		});
	})
	.listen(port, '127.0.0.1', () => process.stdout.write(`fake Superfood API on http://127.0.0.1:${port}\n`));
