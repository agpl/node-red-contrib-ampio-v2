// Consistency of the definition files and the editor HTML
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const leafdefs = require('../ampioin/db/leafdefs.json');
const legacydefs = require('../ampioin/db/legacytypes.json');
const RW = ['R', 'W', 'RW'];

test('leafdefs.json', async (t) => {
    await t.test('every type has a name, label and usable attributes', () => {
        for (const [type, def] of Object.entries(leafdefs)) {
            assert.match(type, /^\d+$/, 'type code ' + type);
            assert.ok(def.name && def.label, 'name/label of ' + type);
            assert.ok(Object.keys(def.attributes).length > 0, 'attributes of ' + type);
            for (const [attr, a] of Object.entries(def.attributes)) {
                const where = type + '/' + attr;
                assert.match(attr, /^\d+$/, where);
                assert.ok(RW.includes(a.rw), 'rw of ' + where);
                assert.equal(typeof a.kind, 'string', 'kind of ' + where);
                if (a.min !== undefined) {
                    assert.ok(a.max >= a.min, 'range of ' + where);
                }
                if (a.enum) {
                    assert.ok(Object.keys(a.enum).length > 0 && Object.keys(a.enum).every((k) => /^\d+$/.test(k)), 'enum of ' + where);
                }
            }
        }
    });
    await t.test('contains types seen on real installations', () => {
        assert.equal(leafdefs[129].attributes[0].rw, 'RW');
        assert.deepEqual(leafdefs[136].attributes[2].enum, {0: 'Stop', 1: 'Close', 2: 'Open'});
        assert.equal(leafdefs[130].attributes[0].unit, '℃');
        assert.deepEqual(leafdefs[134].attributes[0].fields, ['h', 's', 'v']);
    });
});

test('legacytypes.json', async (t) => {
    await t.test('every legacy type has a label and access', () => {
        for (const [valtype, def] of Object.entries(legacydefs)) {
            assert.ok(def.label, 'label of ' + valtype);
            assert.ok(RW.includes(def.rw), 'rw of ' + valtype);
            if (def.with) {
                assert.ok(legacydefs[def.with], valtype + ' refers to unknown ' + def.with);
            }
            if (def.set) {
                assert.ok(legacydefs[def.set], valtype + ' is written through unknown ' + def.set);
            }
        }
    });
    await t.test('raw is write only and available everywhere', () => {
        assert.equal(legacydefs.raw.rw, 'W');
        assert.equal(legacydefs.raw.always, true);
    });
});

test('package registers every node file', () => {
    const pkg = require('../package.json');
    for (const file of Object.values(pkg['node-red'].nodes)) {
        assert.ok(fs.existsSync(path.join(ROOT, file)), file);
        assert.ok(fs.existsSync(path.join(ROOT, file.replace(/\.js$/, '.html'))), file + ' editor html');
    }
});

test('editor HTML', async (t) => {
    const files = fs.readdirSync(path.join(ROOT, 'ampioin')).filter((f) => f.endsWith('.html'));
    for (const file of files) {
        await t.test(file + ': scripts parse, template and help exist for every registered type', () => {
            const html = fs.readFileSync(path.join(ROOT, 'ampioin', file), 'utf8');
            const scripts = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
            assert.ok(scripts.length > 0, 'no script in ' + file);
            scripts.forEach((code) => assert.doesNotThrow(() => new Function(code), file));
            for (const [, type] of html.matchAll(/RED\.nodes\.registerType\('([^']+)'/g)) {
                assert.ok(html.includes('data-template-name="' + type + '"'), 'template of ' + type);
                assert.ok(html.includes('data-help-name="' + type + '"'), 'help of ' + type);
            }
        });
    }
});
