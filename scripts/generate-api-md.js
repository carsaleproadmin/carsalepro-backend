#!/usr/bin/env node
/**
 * Builds docs/API.md from a Swagger JSON document.
 *
 * Usage:
 *   node scripts/generate-api-md.js <openapi.json> [outputPath]
 *
 * Defaults: in=.ai-kit/tmp/openapi.json out=docs/API.md.
 */
const fs = require('node:fs');
const path = require('node:path');

const inPath = process.argv[2] ?? path.join('.ai-kit', 'tmp', 'openapi.json');
const outPath = process.argv[3] ?? path.join('docs', 'API.md');

const spec = JSON.parse(fs.readFileSync(inPath, 'utf8'));

const HEADER = `# API reference

> Generated from the live OpenAPI spec at \`/docs-json\`. Re-generate with:
> \`\`\`bash
> curl https://carsalepro-backend.onrender.com/docs-json -o .ai-kit/tmp/openapi.json
> node scripts/generate-api-md.js
> \`\`\`
>
> Browse interactively at https://carsalepro-backend.onrender.com/docs.

`;

function methodOrder(m) {
  return ['get', 'post', 'put', 'patch', 'delete'].indexOf(m);
}

function paramsTable(params) {
  if (!params?.length) return '';
  const rows = params.map((p) => {
    const required = p.required ? '**yes**' : 'no';
    const type = (p.schema?.type ?? p.schema?.$ref?.split('/').pop()) ?? '—';
    return `| ${p.name} | ${p.in} | ${required} | ${type} | ${p.description ?? ''} |`;
  });
  return [
    '',
    '**Parameters**',
    '',
    '| Name | In | Required | Type | Description |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

function dereference(ref) {
  if (!ref || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let cur = spec;
  for (const p of parts) cur = cur?.[p];
  return cur ?? null;
}

function schemaSnippet(schema, depth = 0) {
  if (!schema) return '';
  if (schema.$ref) {
    const resolved = dereference(schema.$ref);
    if (resolved) return schemaSnippet(resolved, depth);
    return `(ref: ${schema.$ref})`;
  }
  if (schema.type === 'object' && schema.properties) {
    const lines = ['{'];
    for (const [k, v] of Object.entries(schema.properties)) {
      const example = v.example !== undefined ? ` // e.g. ${JSON.stringify(v.example)}` : '';
      lines.push(`${'  '.repeat(depth + 1)}${k}: ${v.type ?? (v.$ref?.split('/').pop() ?? 'any')},${example}`);
    }
    lines.push(`${'  '.repeat(depth)}}`);
    return lines.join('\n');
  }
  if (schema.type === 'array') {
    return `[${schemaSnippet(schema.items, depth)}]`;
  }
  return schema.type ?? 'any';
}

function exampleFromSchema(schema) {
  const example = schema?.example ?? (schema?.$ref ? dereference(schema.$ref)?.example : undefined);
  if (example) return JSON.stringify(example, null, 2);
  if (schema?.$ref) {
    const resolved = dereference(schema.$ref);
    if (resolved?.properties) {
      const ex = {};
      for (const [k, v] of Object.entries(resolved.properties)) {
        if (v.example !== undefined) ex[k] = v.example;
        else if (v.type === 'number' || v.type === 'integer') ex[k] = 0;
        else if (v.type === 'boolean') ex[k] = false;
        else if (v.type === 'array') ex[k] = [];
        else if (v.type === 'object') ex[k] = {};
        else ex[k] = 'string';
      }
      return JSON.stringify(ex, null, 2);
    }
  }
  return null;
}

function responseSection(responses) {
  const rows = [];
  for (const [code, def] of Object.entries(responses)) {
    const schema = def.content?.['application/json']?.schema;
    rows.push(
      `**${code}** — ${def.description ?? ''}`,
      '',
      schema ? '```json\n' + (exampleFromSchema(schema) ?? schemaSnippet(schema)) + '\n```' : '',
      '',
    );
  }
  return rows.join('\n');
}

const tagMap = new Map((spec.tags ?? []).map((t) => [t.name, t]));
const byTag = new Map();
for (const t of spec.tags ?? []) byTag.set(t.name, []);
byTag.set('_untagged', []);

for (const [route, methods] of Object.entries(spec.paths)) {
  const ordered = Object.entries(methods).sort(([a], [b]) => methodOrder(a) - methodOrder(b));
  for (const [method, op] of ordered) {
    const tag = (op.tags ?? [])[0] ?? '_untagged';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push({ route, method: method.toUpperCase(), op });
  }
}

const sections = [HEADER];

for (const [tag, entries] of byTag) {
  if (!entries.length) continue;
  const def = tagMap.get(tag);
  sections.push(`## ${tag}`);
  if (def?.description) sections.push('', def.description, '');
  for (const { route, method, op } of entries) {
    sections.push(`### \`${method} ${route}\``);
    if (op.summary) sections.push('', `*${op.summary}*`);
    if (op.description) sections.push('', op.description);
    sections.push(paramsTable(op.parameters));
    const body = op.requestBody?.content?.['application/json']?.schema;
    if (body) {
      sections.push('**Request body**', '');
      const ex = exampleFromSchema(body);
      sections.push('```json', ex ?? schemaSnippet(body), '```', '');
    }
    if (op.responses) {
      sections.push('**Responses**');
      sections.push('', responseSection(op.responses));
    }
    sections.push('---', '');
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, sections.join('\n'));
console.log(`Wrote ${outPath}`);
