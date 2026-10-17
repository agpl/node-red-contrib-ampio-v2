#!/usr/bin/env node
// Generates ampioin/db/leafdefs.json from the Ampio Designer bundle (http://<mserv>/assets/App-*.js).
//
//   node tools/extract-designer-defs.js App-xxxx.js > ampioin/db/leafdefs.json
//
// Minified names change between Designer builds, so tables are located by their content.
// Only plain object literals are cut out of the bundle and evaluated, in an empty vm context.
'use strict';
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');
const IDENT = '[A-Za-z_$][\\w$]*';

// returns the balanced {...} literal starting at index `at`
function literalAt(at) {
    let depth = 0, quote = null;
    for (let i = at; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) { quote = null; }
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') { depth++; }
        else if (c === '}' && --depth === 0) { return src.slice(at, i + 1); }
    }
    throw new Error('unbalanced literal at ' + at);
}

function find(re, what) {
    const m = re.exec(src);
    if (!m) { throw new Error('could not locate ' + what); }
    return m;
}

const typeEnum = find(new RegExp('(' + IDENT + ')=\\{BIN_FLAG_OLD:3,'), 'leaf type enum');
const enumName = typeEnum[1];
const table = find(new RegExp('(' + IDENT + ')=\\{\\[' + enumName.replace('$', '\\$') + '\\.BIN_IN\\]:\\{name:"BIN_IN"'), 'leaf definition table');
const tableText = literalAt(table.index + table[1].length + 1);

// collect identifiers referenced by a literal (member bases and bare values), resolve them recursively
const literals = {};
function strip(text) { return text.replace(/"(?:[^"\\]|\\.)*"/g, '""'); }
// identifiers a literal refers to: member bases (Za.R), bare values (:fde,) and spreads (...fde)
function refsOf(text) {
    const plain = strip(text);
    const refs = new Set();
    for (const m of plain.matchAll(new RegExp('(?:^|[^\\w$.])(' + IDENT + ')\\.' + IDENT, 'g'))) { refs.add(m[1]); }
    for (const m of plain.matchAll(new RegExp(':(' + IDENT + ')(?=[,}])', 'g'))) { refs.add(m[1]); }
    for (const m of plain.matchAll(new RegExp('\\.\\.\\.(' + IDENT + ')', 'g'))) { refs.add(m[1]); }
    ['true', 'false', 'null', 'void'].forEach(function (k) { refs.delete(k); });
    return refs;
}
function resolve(text, before) {
    for (const name of refsOf(text)) {
        if (literals[name]) { continue; }
        const at = src.lastIndexOf(name + '={', before);
        if (at < 0) { throw new Error('no literal for ' + name); }
        literals[name] = literalAt(at + name.length + 1);
        resolve(literals[name], at);
    }
}
resolve(tableText, table.index);

const all = Object.values(literals).concat(tableText).map(strip).join('\n');
if (/\b(function|new|import|require|process|globalThis|this)\b|=>|\(/.test(all)) {
    throw new Error('non-literal code found, refusing to evaluate');
}

// dependency order: a literal can only be declared after the literals it references
const order = [];
function visit(name, stack) {
    if (order.includes(name)) { return; }
    if (stack.includes(name)) { throw new Error('cycle at ' + name); }
    refsOf(literals[name]).forEach(function (other) { visit(other, stack.concat(name)); });
    order.push(name);
}
Object.keys(literals).forEach(function (name) { visit(name, []); });

const code = order.map(function (n) { return 'const ' + n + '=' + literals[n] + ';'; }).join('\n') + '\n(' + tableText + ')';
const defs = vm.runInContext(code, vm.createContext(Object.create(null)), {timeout: 1000});

// English labels: first "KEY":"text" occurrence in the bundle (English is the first translation)
function label(key) {
    if (!/^[A-Z][A-Z0-9_-]*$/.test(key)) { return key; }
    const m = new RegExp('"' + key.replace(/[-]/g, '\\-') + '":"((?:[^"\\\\]|\\\\.)*)"').exec(src);
    if (m && m[1]) { return JSON.parse('"' + m[1] + '"'); }
    return key.charAt(0) + key.slice(1).toLowerCase().replace(/_/g, ' ');
}

const rwNames = {0: 'NONE', 1: 'R', 2: 'W', 3: 'RW'};
const out = {};
Object.keys(defs).forEach(function (type) {
    const d = defs[type];
    const attributes = {};
    Object.keys(d.attributes || {}).forEach(function (attr) {
        const a = d.attributes[attr];
        const rw = rwNames[a.rw];
        if (rw === 'NONE') { return; }
        const def = {label: a.nameSuffix ? label(a.nameSuffix) : '', rw: rw, kind: a.leafType};
        ['min', 'max', 'unit', 'precision'].forEach(function (k) { if (a[k] !== undefined) { def[k] = a[k]; } });
        if (a.enumName) {
            def.enum = {};
            Object.keys(a.enumName).forEach(function (v) { def.enum[v] = label(a.enumName[v]); });
        }
        if (a.fields) {
            def.fields = Object.keys(a.fields).map(function (f) { return a.fields[f].key; });
        }
        attributes[attr] = def;
    });
    if (Object.keys(attributes).length) {
        out[type] = {name: d.name, label: label(d.name), attributes: attributes};
    }
});
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
