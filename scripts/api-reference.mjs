// Renders the OpenAPI document as one reference page: operations grouped by
// tag, then every component schema. Pure function of the spec, so the page
// can never disagree with the server.

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"];

export function renderApiReference(spec, { escapeHtml, slugify, toc, markdown, hljs }) {
  const schemas = spec.components?.schemas ?? {};
  const refName = (ref) => ref.split("/").pop();
  const schemaLink = (name) => `<a class="schema-ref" href="#schema-${slugify(name)}">${escapeHtml(name)}</a>`;
  const md = (s) => (s ? markdown(String(s).replace(/\n+/g, " ")) : "");

  // One-line type rendering for a schema node.
  function typeOf(node, depth = 0) {
    if (!node) return "";
    if (node.$ref) return schemaLink(refName(node.$ref));
    if (node.oneOf) return node.oneOf.map((n) => typeOf(n, depth + 1)).join(" | ");
    if (node.anyOf) return node.anyOf.map((n) => typeOf(n, depth + 1)).join(" | ");
    if (node.allOf) return node.allOf.map((n) => typeOf(n, depth + 1)).join(" &amp; ");
    let t = node.type;
    if (Array.isArray(t)) return t.map((x) => (x === "null" ? "null" : typeOf({ ...node, type: x }, depth + 1))).join(" | ");
    if (t === "array") return `array&lt;${typeOf(node.items, depth + 1) || "any"}&gt;`;
    if (t === "object" && node.additionalProperties !== undefined && !node.properties) return "object";
    if (t === "string" && node.enum) return node.enum.map((e) => `<code>${escapeHtml(JSON.stringify(e))}</code>`).join(" | ");
    if (t === "string" && node.format) return `string (${escapeHtml(node.format)})`;
    if (t === "integer" && node.format) return `integer (${escapeHtml(node.format)})`;
    if (t === "number" && node.format) return `number (${escapeHtml(node.format)})`;
    return t ? escapeHtml(t) : "any";
  }

  function propertiesTable(schema) {
    if (!schema.properties) return "";
    const required = new Set(schema.required ?? []);
    const rows = Object.entries(schema.properties)
      .sort(([a], [b]) => (required.has(b) - required.has(a)) || a.localeCompare(b))
      .map(([name, prop]) => {
        const req = required.has(name) ? '<span class="req">required</span>' : "";
        const desc = prop.description ?? prop.oneOf?.find((n) => n.description)?.description ?? "";
        const extras = [];
        if (prop.minimum !== undefined) extras.push(`min ${prop.minimum}`);
        if (prop.maximum !== undefined) extras.push(`max ${prop.maximum}`);
        return `<tr><td><code>${escapeHtml(name)}</code>${req}</td><td class="type">${typeOf(prop)}</td><td>${md(desc)}${
          extras.length ? ` <span class="dim">(${extras.join(", ")})</span>` : ""
        }</td></tr>`;
      })
      .join("\n");
    return `<div class="table-wrap"><table class="props"><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>\n${rows}\n</tbody></table></div>`;
  }

  function schemaBlock(name) {
    const s = schemas[name];
    if (!s) return "";
    let body = "";
    if (s.enum) {
      body = `<p class="type">One of ${s.enum.map((e) => `<code>${escapeHtml(JSON.stringify(e))}</code>`).join(", ")}.</p>`;
    } else if (s.properties) {
      body = propertiesTable(s);
    } else {
      body = `<p class="type">${typeOf(s)}</p>`;
    }
    return body;
  }

  function paramsTable(params) {
    if (!params?.length) return "";
    const rows = params
      .map(
        (p) =>
          `<tr><td><code>${escapeHtml(p.name)}</code>${p.required ? '<span class="req">required</span>' : ""}</td><td class="type">${escapeHtml(
            p.in,
          )}</td><td class="type">${typeOf(p.schema)}</td><td>${md(p.description)}</td></tr>`,
      )
      .join("\n");
    return `<h4>Parameters</h4><div class="table-wrap"><table class="props"><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Description</th></tr></thead><tbody>\n${rows}\n</tbody></table></div>`;
  }

  function bodySection(requestBody) {
    if (!requestBody) return "";
    const schema = requestBody.content?.["application/json"]?.schema;
    if (!schema) return "";
    const name = schema.$ref ? refName(schema.$ref) : null;
    return `<h4>Request body <span class="dim">application/json</span></h4>${
      name ? `<p class="type">${schemaLink(name)}${schemas[name]?.description ? ` <span class="dim">${md(schemas[name].description)}</span>` : ""}</p>${propertiesTable(schemas[name])}` : `<p class="type">${typeOf(schema)}</p>`
    }`;
  }

  function responsesTable(responses) {
    const rows = Object.entries(responses)
      .map(([code, r]) => {
        const content = r.content ?? {};
        const [ctype, media] = Object.entries(content)[0] ?? [];
        const schema = media?.schema;
        const type = schema ? typeOf(schema) : '<span class="dim">empty</span>';
        return `<tr><td><code class="status status-${code[0]}">${code}</code></td><td class="type">${type}${
          ctype && ctype !== "application/json" ? ` <span class="dim">${escapeHtml(ctype)}</span>` : ""
        }</td><td>${md(r.description)}</td></tr>`;
      })
      .join("\n");
    return `<h4>Responses</h4><div class="table-wrap"><table class="props"><thead><tr><th>Status</th><th>Body</th><th>Meaning</th></tr></thead><tbody>\n${rows}\n</tbody></table></div>`;
  }

  // Group operations by tag, preserving the spec's tag order.
  const byTag = new Map((spec.tags ?? []).map((t) => [t.name, { ...t, ops: [] }]));
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHOD_ORDER) {
      const op = item[method];
      if (!op) continue;
      const tag = op.tags?.[0] ?? "other";
      if (!byTag.has(tag)) byTag.set(tag, { name: tag, description: "", ops: [] });
      byTag.get(tag).ops.push({ path, method, ...op });
    }
  }

  let out = "";
  out += `<p>The server emits this document at <code>/openapi.json</code> and serves an interactive Swagger UI at <code>/docs</code>. A copy of the spec used to build this page is at <a href="/openapi.json">/openapi.json</a>; the canonical file lives in the <a href="https://github.com/elision-labs/queueflow-core/blob/main/spec/openapi.yaml">queueflow-core repository</a> and is attached to every release.</p>`;
  out += `<p>All <code>/api/v1</code> routes require <code>Authorization: Bearer &lt;token&gt;</code>. Tenant routes take a tenant token (API key or JWT); the worker-protocol routes take the deployment's worker token. See <a href="/concepts/auth">Authentication and tenants</a>. Durations are plain integer seconds; timestamps are RFC 3339 strings in UTC. Error responses share one shape:</p>`;
  out += `<div class="code"><span class="code-lang">json</span><button class="copy" type="button" aria-label="Copy code">Copy</button><pre><code class="hljs language-json">${hljs.highlight('{ "error": "job not found", "timestamp": "2026-10-06T12:00:00Z" }', { language: "json" }).value}</code></pre></div>`;

  // Index table.
  out += `<h2 id="endpoints"><a class="anchor" href="#endpoints">#</a>Endpoints</h2>`;
  toc.push({ depth: 2, id: "endpoints", text: "Endpoints" });
  out += `<div class="table-wrap"><table class="endpoints"><tbody>`;
  for (const tag of byTag.values()) {
    for (const op of tag.ops) {
      const id = `op-${slugify(op.operationId)}`;
      out += `<tr><td><span class="method method-${op.method}">${op.method.toUpperCase()}</span></td><td><a href="#${id}"><code>${escapeHtml(op.path)}</code></a></td><td>${escapeHtml(op.operationId)}</td></tr>`;
    }
  }
  out += `</tbody></table></div>`;

  for (const tag of byTag.values()) {
    const tid = `tag-${slugify(tag.name)}`;
    const title = tag.name.charAt(0).toUpperCase() + tag.name.slice(1);
    toc.push({ depth: 2, id: tid, text: title });
    out += `<h2 id="${tid}"><a class="anchor" href="#${tid}">#</a>${escapeHtml(title)}</h2>`;
    if (tag.description) out += `<p>${md(tag.description)}</p>`;
    for (const op of tag.ops) {
      const id = `op-${slugify(op.operationId)}`;
      toc.push({ depth: 3, id, text: `${op.method.toUpperCase()} ${op.path}` });
      out += `<section class="op" id="${id}">`;
      out += `<h3><a class="anchor" href="#${id}">#</a><span class="method method-${op.method}">${op.method.toUpperCase()}</span> <code class="path">${escapeHtml(op.path)}</code></h3>`;
      out += `<p class="op-id"><span class="dim">operationId</span> <code>${escapeHtml(op.operationId)}</code>${op.security ? "" : ' <span class="pill">no auth</span>'}</p>`;
      if (op.summary) out += `<p>${md(op.summary)}</p>`;
      if (op.description) out += `<p>${md(op.description)}</p>`;
      out += paramsTable(op.parameters);
      out += bodySection(op.requestBody);
      out += responsesTable(op.responses ?? {});
      out += `</section>`;
    }
  }

  // Schemas.
  toc.push({ depth: 2, id: "schemas", text: "Schemas" });
  out += `<h2 id="schemas"><a class="anchor" href="#schemas">#</a>Schemas</h2>`;
  out += `<p>Every request and response body is one of these objects. Fields marked required are always present; other fields may be absent or <code>null</code>.</p>`;
  for (const name of Object.keys(schemas).sort()) {
    const id = `schema-${slugify(name)}`;
    toc.push({ depth: 3, id, text: name });
    out += `<section class="schema" id="${id}"><h3><a class="anchor" href="#${id}">#</a><code>${escapeHtml(name)}</code></h3>`;
    if (schemas[name].description) out += `<p>${md(schemas[name].description)}</p>`;
    out += schemaBlock(name);
    out += `</section>`;
  }
  return out;
}
