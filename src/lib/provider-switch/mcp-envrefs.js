"use strict";

// One stored syntax; projection never resolves a credential into a live file.
// Client mappings follow the Magpie envref audit (see docs/magpie-integration-research.md).
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const whole = value => /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
const hasRef = value => typeof value === "string" && /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);

function mapStrings(value, map) {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map(item => mapStrings(item, map));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]));
  return value;
}

function referenceNames(spec) {
  const names = new Set();
  mapStrings(spec, value => { for (const match of value.matchAll(REF)) names.add(match[1]); return value; });
  // Imported native Codex references can also be checked without expansion on disk.
  for (const name of spec.env_vars || []) names.add(name);
  if (spec.bearer_token_env_var) names.add(spec.bearer_token_env_var);
  for (const name of Object.values(spec.env_http_headers || {})) names.add(name);
  return [...names].sort();
}

function resolveReferences(spec, env = process.env) {
  const result = mapStrings(spec, value => value.replace(REF, (_, name) => {
    if (env[name] === undefined || env[name] === "") throw Object.assign(new Error("MCP environment variable is missing"), { reason: "environment" });
    return env[name];
  }));
  for (const name of result.env_vars || []) {
    if (!env[name]) throw Object.assign(new Error("MCP environment variable is missing"), { reason: "environment" });
    result.env = { ...result.env, [name]: env[name] };
  }
  if (result.bearer_token_env_var) {
    if (!env[result.bearer_token_env_var]) throw Object.assign(new Error("MCP environment variable is missing"), { reason: "environment" });
    result.headers = { ...result.headers, Authorization: `Bearer ${env[result.bearer_token_env_var]}` };
  }
  for (const [key, name] of Object.entries(result.env_http_headers || {})) {
    if (!env[name]) throw Object.assign(new Error("MCP environment variable is missing"), { reason: "environment" });
    result.headers = { ...result.headers, [key]: env[name] };
  }
  return result;
}

function projectReferences(app, spec) {
  const has = referenceNames(spec).length > 0;
  if (!has) return structuredClone(spec);
  if (["agy", "mcode"].includes(app)) throw new Error(`${app} cannot safely read MCP environment references`);
  if (app === "opencode") return mapStrings(spec, value => value.replace(REF, "{env:$1}"));
  if (app !== "codex") return structuredClone(spec);
  const out = structuredClone(spec);
  // Codex only supports variable names in dedicated fields, never interpolation.
  for (const [key, value] of Object.entries(out)) {
    if (["env", "headers", "env_vars", "env_http_headers", "bearer_token_env_var"].includes(key)) continue;
    let found = false;
    mapStrings(value, text => { found ||= hasRef(text); return text; });
    if (found) throw new Error(`Codex cannot interpolate MCP ${key}`);
  }
  for (const [key, value] of Object.entries(out.env || {})) {
    if (!hasRef(value)) continue;
    if (whole(value) !== key) throw new Error(`Codex can pass MCP environment variables only under their own name: ${key}`);
    out.env_vars = [...new Set([...(out.env_vars || []), key])];
    delete out.env[key];
  }
  for (const [key, value] of Object.entries(out.headers || {})) {
    if (!hasRef(value)) continue;
    const bearer = key.toLowerCase() === "authorization" && value.startsWith("Bearer ") ? whole(value.slice(7)) : null;
    if (bearer) out.bearer_token_env_var = bearer;
    else if (whole(value)) out.env_http_headers = { ...out.env_http_headers, [key]: whole(value) };
    else throw new Error(`Codex requires a whole MCP header variable: ${key}`);
    delete out.headers[key];
  }
  return out;
}

function importReferences(app, spec) {
  if (app === "opencode") return mapStrings(spec, value => value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => "${" + name + "}"));
  if (app !== "codex") return spec;
  const out = structuredClone(spec);
  for (const name of out.env_vars || []) {
    if (out.env?.[name] === undefined) out.env = { ...out.env, [name]: "${" + name + "}" };
  }
  if (out.bearer_token_env_var) out.headers = { ...out.headers, Authorization: "Bearer ${" + out.bearer_token_env_var + "}" };
  for (const [key, name] of Object.entries(out.env_http_headers || {})) out.headers = { ...out.headers, [key]: "${" + name + "}" };
  delete out.env_vars; delete out.env_http_headers; delete out.bearer_token_env_var;
  return out;
}

module.exports = { referenceNames, resolveReferences, projectReferences, importReferences };
