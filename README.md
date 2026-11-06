# n8n-nodes-superfood-apps

n8n community nodes for [Superfood Apps](https://superfoodapps.com), the food safety and operations platform for food manufacturers. Use them to build automations against your company's Superfood data without hand-writing HTTP requests.

- **Superfood Apps** (action node): read, create and update records in 23 tables, submit forms into the QA queue, and send records to your company's custom app endpoints.
- **Superfood Apps Trigger** (polling): start a workflow when a record is added or changed, or when a form is submitted.

These nodes are for **self-hosted n8n**. They are not verified by n8n, so n8n Cloud can't install them.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [Trigger](#trigger) · [Examples](#examples) · [Limits](#limits) · [Compatibility](#compatibility) · [Development](#development)

## Installation

You need to be the owner or an admin of your n8n instance.

1. In n8n, open **Settings > Community nodes**.
2. Select **Install**, enter `n8n-nodes-superfood-apps`, tick the box to say you understand the risks of community nodes, and select **Install**.
3. Search for "Superfood" in the nodes panel.

Updates appear on the same page when a new version is published.

**Docker:** keep `/home/node/.n8n` on a volume, or set `N8N_REINSTALL_MISSING_PACKAGES=true`, so the node survives a container rebuild.

**Queue mode:** the workers need the package too. Follow n8n's guide for [community nodes in queue mode](https://docs.n8n.io/integrations/community-nodes/installation/), or build the package into your worker image.

**Without npm access:** copy the built package (`dist/` and `package.json`) into `~/.n8n/custom/n8n-nodes-superfood-apps` and restart n8n.

## Credentials

Create a key in Superfood Apps under **Company settings > API** (company admins only). The key starts with `sf_live_` and is shown once.

| Field | What to enter |
| --- | --- |
| API Key | The `sf_live_…` key. Use a **Read only** key unless the workflow creates or updates records. |
| Environment | **Production** (app.superfoodapps.com), **Beta** (beta.superfoodapps.com) or **Custom URL**. Beta and production share one database, so a workflow pointed at Beta still changes real records. |
| Base URL | Only for Custom URL, for example `https://app.superfoodapps.com`. |

Saving the credential calls `GET /api/v1`, which checks the key. Every call made by these nodes shows in the API tab's usage report under the key's name.

## Operations

### Record

Works on any table the API lists (products, ingredients, recipes, production runs, stores and customers, promotions, sales lines, EasyImport orders, form submissions, registers, register entries, complaints, NCRs, incidents, pest visits, assets, job sheets, preventative schedules, spare parts, suppliers, visitors, staff, training records). The table list and each table's fields load from your account, so new tables and fields appear without updating the node.

| Operation | What it does |
| --- | --- |
| Get | One record by ID. |
| Get Many | Records with optional filters (field equals value; `null` finds empty fields), **Changed Since**, and sort. **Return All** pages through everything, up to **Max Records** (5,000 by default) so a very large table can't run for hours. |
| Create | A new record. Pick the fields to fill, or choose **Map automatically** to send the input item's matching fields. Only fields the API accepts for that table are offered. |
| Update | Changes the fields you map on one record. Empty fields are skipped so nothing is cleared by accident; turn on **Send Empty Values** to clear on purpose. |
| Create or Update | Looks for the record whose chosen field equals a value. Updates it if there is one, creates it if there is none, and stops if more than one record matches. The output has `_action: created` or `updated`. |

Creates and updates need a **Read and write** key. Tables that accept writes today: complaints, NCRs, incidents, training records, production runs, pest visits, assets, job sheets, spare parts, suppliers, register entries, and preventative schedules (update only). The reply is the record as stored. If the app ignored a field you sent, it is listed in `_not_saved`, and any warnings in `_warnings`.

### Form

| Operation | What it does |
| --- | --- |
| Get Many | Your company's active forms. |
| Get | One form with its sections and fields. |
| Submit | A completed form, answers mapped field by field. It lands in the QA queue like any submission. |

### Custom App

| Operation | What it does |
| --- | --- |
| Send Records | Posts records to one of your company's custom endpoints. Enter the endpoint as listed under **Custom app endpoints** in Company settings > API (the part after `/api/v1/custom/`). Each input item is one record, or build the record as JSON. Items are sent in batches (50 by default, at most 200) and each item gets its own result back. |

Every operation supports **Continue On Fail**. Errors show the API's own message, for example "Record not found." or which field is wrong.

The action node can also be used as a tool by n8n's AI Agent node.

## Trigger

**Superfood Apps Trigger** checks your account on the schedule you set.

| Trigger On | Fires for |
| --- | --- |
| New Record | Records added to the chosen table. |
| New or Updated Record | Records added or changed. |
| New Form Submission | Submissions of one form, or of every form. |

- The first check after you activate the workflow only notes where to start, so existing records are not replayed.
- Each record fires once per change, even when hundreds are saved in the same instant.
- **Max Records per Check** (1,000 by default) keeps a big import from flooding the workflow; the rest arrive on the next check.
- Every check is one API request in your usage report, even when nothing changed. Checking every 5 minutes or longer is usually enough; every minute adds 1,440 requests a day per workflow.
- A manual test run returns the latest record, so you can map fields straight away.

## Examples

Import these from the `examples/` folder (**Workflows > Import from file**), then pick your credential in each Superfood node.

- `process-street-to-custom-app.json`: a completed Process Street checklist is posted to a custom app endpoint (the Udder Delights milk test pattern).
- `process-street-to-form.json`: a completed Process Street checklist becomes a form submission in the QA queue.
- `new-complaint-to-ncr.json`: a new customer complaint creates a linked NCR.

## Limits

- 200 records per API page; Get Many pages for you.
- 200 records per custom app request.
- Records can't be deleted through the API.
- Keys are pinned to one company. A key made before November 2026 without a company is refused; make a new one.

## Compatibility

Built with `@n8n/node-cli` and tested against n8n 2.46. Requires Node.js 20 or later.

## Development

```bash
npm install
npm run build
npm test        # builds, then runs the unit tests in test/
npm run lint
npm run dev     # n8n with this node loaded (needs Docker or Podman)
```

The tests drive the real node code against an in-memory copy of the Superfood API. `test/fixtures/tables-index.json` is generated from the app's table catalogue (`lib/api-v1-tables.ts`); regenerate it when the catalogue changes.

### Releasing

Publishing runs from GitHub Actions with npm provenance (`.github/workflows/publish.yml`). Either run `npm run release` (bumps the version, updates the changelog, tags and pushes; the tag publishes through npm trusted publishing), or bump `version` and `CHANGELOG.md` by hand and use **Run workflow** on the Publish action. A manual run stages the release by default: approve it on npmjs.com (package > Staged Packages) with 2FA.

## Resources

- [Superfood API guide](https://help.superfoodapps.com/en/articles/15286966)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/installation/)

## License

[MIT](LICENSE.md)
