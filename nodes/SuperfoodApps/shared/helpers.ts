// Pure helpers shared by the Superfood Apps node and its trigger. Nothing in
// here talks to the network or to n8n's runtime, so the unit tests can drive
// every function directly.

import type { FieldType, INodePropertyOptions, ResourceMapperField } from 'n8n-workflow';
import { UserError } from 'n8n-workflow';

export const PRODUCTION_URL = 'https://app.superfoodapps.com';
export const BETA_URL = 'https://beta.superfoodapps.com';
export const USER_AGENT = 'n8n-nodes-superfood-apps';

/** The API's page cap: GET /api/v1/tables/:table returns at most 200 rows. */
export const PAGE_MAX = 200;
/** A custom app endpoint takes at most 200 records per request. */
export const CUSTOM_BATCH_MAX = 200;

export type ApiFieldType = 'uuid' | 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'list';

export interface ApiField {
	name: string;
	type: ApiFieldType;
	note?: string;
}

export interface ApiWrites {
	create: boolean;
	update: boolean;
	writable_fields: string[];
	required_on_create: string[];
}

export interface ApiTable {
	key: string;
	label: string;
	group: string;
	description: string;
	changed_field: string;
	fields: ApiField[];
	/** Present (or null) once the API accepts writes; absent on older deployments. */
	writes?: ApiWrites | null;
}

export interface FormFieldDef {
	id: string;
	label: string;
	type: string;
	required?: boolean;
	options?: string[];
}

export interface FormDef {
	id: string;
	name: string;
	sections: { title?: string; fields?: FormFieldDef[] }[];
}

// ── Credential ────────────────────────────────────────────────────────────

/** The origin every request goes to, from the credential's Environment. */
export function resolveBaseUrl(creds: { environment?: unknown; customUrl?: unknown }): string {
	const env = String(creds.environment ?? 'production');
	if (env === 'beta') return BETA_URL;
	if (env === 'custom') {
		const raw = String(creds.customUrl ?? '').trim();
		if (!raw) throw new UserError('Enter a Base URL in the credential, or pick Production.');
		return raw.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
	}
	return PRODUCTION_URL;
}

// ── Errors ────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** One sentence for the error banner. The API already writes "Couldn't …"
 *  sentences with a fix, so its own `error` wins whenever there is one. */
export function apiErrorMessage(status: number, body: unknown): string {
	if (isObject(body) && typeof body.error === 'string' && body.error.trim()) return body.error.trim();
	if (status === 401) {
		return 'The API key was refused. Check it in the credential, or make a new one in Company settings > API.';
	}
	if (status === 403) return 'This API key is not allowed to do that.';
	if (status === 404) return 'Not found.';
	if (status === 429) return 'Too many requests. Wait a moment and try again.';
	return `The Superfood API answered HTTP ${status}.`;
}

/** The detail under the banner: per-record errors, fields that didn't save,
 *  and a hint for the commonest mistakes. */
export function apiErrorDescription(status: number, body: unknown): string | undefined {
	const lines: string[] = [];
	if (isObject(body)) {
		if (Array.isArray(body.errors)) {
			for (const e of body.errors.slice(0, 20)) {
				if (isObject(e)) {
					const where = typeof e.index === 'number' ? `Record ${e.index + 1}: ` : '';
					lines.push(`${where}${String(e.error ?? e.message ?? JSON.stringify(e))}`);
				} else {
					lines.push(String(e));
				}
			}
		}
		if (Array.isArray(body.not_saved) && body.not_saved.length) {
			lines.push(`Not saved: ${body.not_saved.join(', ')}`);
		}
	}
	if (status === 403 && /read/i.test(apiErrorMessage(status, body))) {
		lines.push('Creating or updating needs a key with "Read and write" access. Change it in Company settings > API.');
	}
	if (status === 401) lines.push('Keys start with sf_live_ and are shown once, when they are made.');
	return lines.length ? lines.join('\n') : undefined;
}

// ── Tables and fields ─────────────────────────────────────────────────────

/** `date_of_complaint` → "Date of complaint". Labels only; keys never change. */
export function humanize(name: string): string {
	const words = name.replace(/[_-]+/g, ' ').trim();
	if (!words) return name;
	const s = words.charAt(0).toUpperCase() + words.slice(1);
	return s.replace(/\bid\b/gi, 'ID').replace(/\bids\b/gi, 'IDs').replace(/\bpm\b/gi, 'PM').replace(/\bncr\b/gi, 'NCR');
}

/** API field type → the resource mapper's input widget. Dates stay text so a
 *  plain 2026-11-06 is sent as typed, not turned into a date-time. */
export function mapperType(t: ApiFieldType | undefined): FieldType {
	switch (t) {
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'datetime':
			return 'dateTime';
		case 'json':
			return 'object';
		case 'list':
			return 'array';
		default:
			return 'string';
	}
}

export function canCreate(t: ApiTable): boolean {
	return !!t.writes?.create && (t.writes.writable_fields?.length ?? 0) > 0;
}

export function canUpdate(t: ApiTable): boolean {
	return !!t.writes?.update && (t.writes.writable_fields?.length ?? 0) > 0;
}

/** The dropdown's grey line: the table's area and what it holds. */
export function describeTable(t: ApiTable): string {
	return [t.group, t.description].filter(Boolean).join('. ');
}

export function tableOptions(tables: ApiTable[], filter: (t: ApiTable) => boolean = () => true): INodePropertyOptions[] {
	return tables
		.filter(filter)
		.map((t) => ({ name: t.label, value: t.key, description: describeTable(t) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

const FILTERABLE: ReadonlySet<ApiFieldType> = new Set(['uuid', 'text', 'number', 'boolean', 'date', 'datetime']);

/** Fields the list endpoint can filter on (exact match). */
export function filterFieldOptions(t: ApiTable): INodePropertyOptions[] {
	return t.fields
		.filter((f) => FILTERABLE.has(f.type))
		.map((f) => ({ name: humanize(f.name), value: f.name, description: f.note ?? `${f.type} field` }));
}

/** The resource mapper's columns for a create or an update. */
export function writeMapperFields(t: ApiTable, mode: 'create' | 'update'): ResourceMapperField[] {
	const writable = t.writes?.writable_fields ?? [];
	const required = new Set(mode === 'create' ? t.writes?.required_on_create ?? [] : []);
	return writable.map((name) => {
		const f = t.fields.find((x) => x.name === name);
		return {
			id: name,
			displayName: humanize(name),
			required: required.has(name),
			defaultMatch: false,
			canBeUsedToMatch: false,
			display: true,
			type: mapperType(f?.type),
		};
	});
}

/** The field types of a table, by field name (writable fields not in the read
 *  list count as text). */
export function fieldTypes(t: ApiTable): Record<string, ApiFieldType> {
	const out: Record<string, ApiFieldType> = {};
	for (const f of t.fields) out[f.name] = f.type;
	return out;
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * The JSON body for a create, update or form submission: only the allowed
 * keys, JSON text parsed for object and list fields, and empty values dropped
 * unless the user asked to send them (an update must not blank a field the
 * user simply left alone).
 */
export function cleanWriteBody(
	values: Record<string, unknown> | null | undefined,
	allowed: readonly string[],
	types: Record<string, ApiFieldType | string>,
	sendEmpty: boolean,
): { body: Record<string, unknown>; error?: string } {
	const out: Record<string, unknown> = {};
	if (!values) return { body: out };
	const allow = new Set(allowed);
	for (const [key, raw] of Object.entries(values)) {
		if (!allow.has(key)) continue;
		if (raw === undefined) continue;
		let v: unknown = raw;
		const t = types[key];
		if ((t === 'json' || t === 'list' || t === 'table') && typeof v === 'string' && v.trim()) {
			try {
				v = JSON.parse(v);
			} catch {
				return { body: out, error: `"${humanize(key)}" must be JSON, for example {"key": "value"} or ["a", "b"].` };
			}
		}
		if (isEmpty(v)) {
			if (!sendEmpty) continue;
			v = null;
		}
		out[key] = v;
	}
	return { body: out };
}

/** What a create or update hands to the next node: the record as stored,
 *  plus what didn't stick, so a partial save never looks like a clean one. */
export function writeOutput(body: Record<string, unknown>): Record<string, unknown> {
	const data = isObject(body.data) ? body.data : {};
	const out: Record<string, unknown> = { ...data };
	if (Array.isArray(body.not_saved) && body.not_saved.length) out._not_saved = body.not_saved;
	if (Array.isArray(body.warnings) && body.warnings.length) out._warnings = body.warnings;
	return out;
}

// ── Forms ─────────────────────────────────────────────────────────────────

const NO_INPUT = new Set(['heading', 'paragraph', 'divider', 'image', 'html', 'info']);

/** Form field type → mapper widget. Select and radio fields become dropdowns. */
export function formFieldType(type: string): FieldType {
	if (type === 'number') return 'number';
	if (type === 'checkbox') return 'boolean';
	if (type === 'table') return 'array';
	if (type === 'select' || type === 'radio') return 'options';
	return 'string';
}

/** One mapper column per answerable field. A label that repeats across
 *  sections gets its section's title in front, so the user can tell them apart. */
export function formMapperFields(form: FormDef): ResourceMapperField[] {
	const all: { section: string; f: FormFieldDef }[] = [];
	for (const s of form.sections ?? []) {
		for (const f of s.fields ?? []) {
			if (!f || !f.id || NO_INPUT.has(f.type)) continue;
			all.push({ section: s.title ?? '', f });
		}
	}
	const labelCount = new Map<string, number>();
	for (const { f } of all) labelCount.set(f.label, (labelCount.get(f.label) ?? 0) + 1);
	const seen = new Set<string>();
	const out: ResourceMapperField[] = [];
	for (const { section, f } of all) {
		if (seen.has(f.id)) continue;
		seen.add(f.id);
		const type = formFieldType(f.type);
		const label = f.label || f.id;
		const field: ResourceMapperField = {
			id: f.id,
			displayName: (labelCount.get(f.label) ?? 0) > 1 && section ? `${section}: ${label}` : label,
			required: !!f.required,
			defaultMatch: false,
			canBeUsedToMatch: false,
			display: true,
			type,
		};
		if (type === 'options') field.options = (f.options ?? []).map((o) => ({ name: o, value: o }));
		out.push(field);
	}
	return out;
}

export function formFieldTypes(form: FormDef): Record<string, string> {
	const out: Record<string, string> = {};
	for (const s of form.sections ?? []) for (const f of s.fields ?? []) if (f?.id) out[f.id] = f.type;
	return out;
}

// ── Custom app endpoints ──────────────────────────────────────────────────

/** "uda-milk/milk-tests", "/api/v1/custom/uda-milk/milk-tests" or a whole URL
 *  → "uda-milk/milk-tests". Anything else is refused before a request is sent. */
export function normaliseCustomEndpoint(input: string): string {
	let s = String(input ?? '').trim();
	s = s.replace(/^https?:\/\/[^/]+/i, '');
	s = s.replace(/^\/+/, '').replace(/^api\/v1\//, '').replace(/^custom\//, '').replace(/\/+$/, '');
	if (!s || !/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/i.test(s)) {
		throw new UserError(
			'Enter the endpoint as shown in Company settings > API, for example my-app/records.',
		);
	}
	return s;
}

export function chunk<T>(list: T[], size: number): T[][] {
	const n = Math.max(1, Math.floor(size));
	const out: T[][] = [];
	for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
	return out;
}

/** Pairs a custom endpoint's reply with the records of its batch: one result
 *  per record when the reply lists them in order, otherwise the whole reply. */
export function splitCustomReply(reply: unknown, batchSize: number): Record<string, unknown>[] {
	if (isObject(reply) && Array.isArray(reply.results) && reply.results.length === batchSize) {
		return reply.results.map((r) => (isObject(r) ? r : { result: r }));
	}
	const whole = isObject(reply) ? reply : { response: reply };
	return Array.from({ length: batchSize }, () => whole);
}

// ── Polling ───────────────────────────────────────────────────────────────

export interface PollState {
	/** What the state belongs to; a changed table, event or filter starts over. */
	signature?: string;
	/** The change time the next poll asks from (ISO, millisecond precision). */
	cursor?: string;
	/** Rows already emitted at exactly the cursor's millisecond. */
	boundary?: string[];
	/** The table's change column and creation column, read once when the
	 *  state starts so each check costs one API request, not two. */
	changedField?: string;
	createdField?: string;
}

const ms = (v: unknown): number => {
	const n = typeof v === 'string' || typeof v === 'number' ? Date.parse(String(v)) : NaN;
	return Number.isFinite(n) ? n : NaN;
};

export const rowKey = (row: Record<string, unknown>, changedField: string): string =>
	`${String(row.id)}|${String(row[changedField] ?? '')}`;

/**
 * One page of a poll. The API filters with "changed at or after", so the rows
 * at the cursor's own millisecond come back again: the boundary list drops
 * them. Rows must arrive oldest first.
 */
export function advancePoll(
	rows: Record<string, unknown>[],
	cursor: string,
	boundary: readonly string[],
	changedField: string,
): { fresh: Record<string, unknown>[]; cursor: string; boundary: string[] } {
	const seen = new Set(boundary);
	const fresh = rows.filter((r) => !seen.has(rowKey(r, changedField)));
	let maxMs = ms(cursor);
	for (const r of rows) {
		const t = ms(r[changedField]);
		if (Number.isFinite(t) && (!Number.isFinite(maxMs) || t > maxMs)) maxMs = t;
	}
	if (!Number.isFinite(maxMs)) return { fresh, cursor, boundary: [...boundary] };
	const nextCursor = new Date(maxMs).toISOString();
	const atEdge = rows.filter((r) => ms(r[changedField]) === maxMs).map((r) => rowKey(r, changedField));
	const keep = nextCursor === cursor ? [...boundary, ...atEdge] : atEdge;
	return { fresh, cursor: nextCursor, boundary: Array.from(new Set(keep)) };
}

/** "New record" keeps only rows created at or after the poll's starting point. */
export function isNewSince(row: Record<string, unknown>, createdField: string, since: string): boolean {
	const created = ms(row[createdField]);
	const from = ms(since);
	if (!Number.isFinite(from)) return true;
	return Number.isFinite(created) && created >= from;
}
