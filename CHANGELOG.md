# Changelog

## 0.1.0 (2026-11-06)

First version, for self-hosted n8n.

- Superfood Apps API credential: company API key, Production, Beta or a custom Base URL, tested against `GET /api/v1`.
- Superfood Apps node:
  - Record: Get, Get Many (filters, Changed Since, sort, Return All with a cap), Create, Update, Create or Update, over every table the API lists. Writable fields load from the account and map with n8n's field mapper.
  - Form: Get Many, Get, Submit (answers mapped per field).
  - Custom App: Send Records to a company custom endpoint, batched up to 200 per request with a result per item.
  - Usable as an AI Agent tool.
- Superfood Apps Trigger (polling): New Record, New or Updated Record, New Form Submission, with filters and a per-check cap. Each change fires once, even when many records share one timestamp.
