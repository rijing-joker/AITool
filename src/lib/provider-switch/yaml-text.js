"use strict";
const YAML = require("yaml");
const equal = require("node:util").isDeepStrictEqual;

// Patch changed YAML values at AST ranges. Unchanged comments, anchors, flow
// collections and user entries remain byte-for-byte; ambiguous alias edits fail.
function patch(text, next) {
  if (!text.trim()) return YAML.stringify(next);
  const doc = YAML.parseDocument(text, { keepSourceTokens: true, logLevel: "silent" });
  if (doc.errors.length) throw new Error("Invalid native YAML; edit the file directly");
  const old = doc.toJS({ maxAliasCount: 100 });
  if (equal(old, next)) return text;
  const edits = [];
  const indentAt = offset => offset - text.lastIndexOf("\n", offset - 1) - 1;
  const render = (value, indent, flow = false) => YAML.stringify(value, { collectionStyle: flow ? "flow" : "block", lineWidth: 0 }).trimEnd().split("\n").map((line, i) => i ? " ".repeat(indent) + line : line).join("\n");
  const replace = (node, value) => {
    if (!node?.range || YAML.isAlias(node) || node.tag) throw new Error("This YAML value uses a tag or alias; edit it in the native file");
    const block = YAML.isCollection(node) && !node.flow;
    const suffix = block && text[node.range[1] - 1] === "\n" ? "\n" : "";
    edits.push([node.range[0], node.range[1], render(value, indentAt(node.range[0]), node.flow) + suffix]);
  };
  const visit = (node, before, after) => {
    if (equal(before, after)) return;
    if (YAML.isSeq(node) && !node.flow && Array.isArray(before) && Array.isArray(after) && before.length !== after.length) {
      // Native plugin lists grow at the end or lose individual entries. Keep
      // every surviving item's bytes, including unknown tags and comments.
      if (!after.length) {
        const start = text.lastIndexOf("\n", node.range[0]) + 1;
        edits.push([start, node.range[1], "[]\n"]);
        return;
      }
      let cursor = 0;
      const removed = [];
      before.forEach((value, index) => { if (equal(value, after[cursor])) cursor++; else removed.push(index); });
      if (cursor === after.length) {
        for (const index of removed) {
          const item = node.items[index];
          edits.push([text.lastIndexOf("\n", item.range[0]) + 1, item.range[2], ""]);
        }
        return;
      }
      if (before.every((value, index) => equal(value, after[index]))) {
        const end = node.range[1], indent = indentAt(node.range[0]);
        edits.push([end, end, (text[end - 1] === "\n" ? "" : "\n") + render(after.slice(before.length), indent) + "\n"]);
        return;
      }
    }
    if (YAML.isSeq(node) && !node.flow && Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
      node.items.forEach((item, index) => visit(item, before[index], after[index]));
      return;
    }
    if (YAML.isMap(node) && !node.flow && before && after && !Array.isArray(after) && typeof after === "object") {
      for (const pair of node.items) {
        const key = String(pair.key?.value);
        if (!Object.hasOwn(after, key)) {
          const start = pair.key.range[0] - indentAt(pair.key.range[0]);
          const end = pair.value?.range?.[2] ?? pair.key.range[2];
          edits.push([start, end, ""]);
        } else visit(pair.value, before[key], after[key]);
      }
      const added = Object.keys(after).filter(key => !Object.hasOwn(before, key));
      if (added.length) {
        const indent = indentAt(node.items[0]?.key?.range?.[0] ?? node.range[0]);
        const end = node.range[1];
        const body = YAML.stringify(Object.fromEntries(added.map(key => [key, after[key]])), { lineWidth: 0 }).trimEnd().split("\n").map(line => " ".repeat(indent) + line).join("\n") + "\n";
        edits.push([end, end, (text[end - 1] === "\n" ? "" : "\n") + body]);
      }
    } else replace(node, after);
  };
  visit(doc.contents, old, next);
  let result = text;
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + value + result.slice(end);
  if (!equal(YAML.parse(result, { logLevel: "silent" }), next)) throw new Error("Native YAML aliases or layout conflict with this edit; the file was kept");
  return result;
}
module.exports = { patch };
