// tools/extract-designer-defs.js on a synthetic, minified-looking Designer bundle
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOL = path.join(__dirname, '..', 'tools', 'extract-designer-defs.js');

// same shape as the real bundle: enums, a shared attribute literal used via spread, the table, i18n strings
const BUNDLE = [
    'var q=1;Za={NONE:0,R:1,W:2,RW:3},wn={Binary:"binary",LinearU8:"linearU8",Enum:"enum",ClimateSource:"climateSource"},',
    'xn={BIN_FLAG_OLD:3,BIN_IN:128,REL:129,BLIND:136,CLIMATE:155,UART_MODE:164},',
    'fde={rw:Za.R,leafType:wn.ClimateSource,fields:{0:{key:"onOff"},1:{key:"mode"}}},',
    'g3={[xn.BIN_IN]:{name:"BIN_IN",attributes:{0:{rw:Za.R,leafType:wn.Binary}}},',
    '[xn.REL]:{name:"RELAY",attributes:{0:{rw:Za.RW,leafType:wn.Binary}}},',
    '[xn.BLIND]:{name:"BLIND",attributes:{0:{nameSuffix:"POSITION",rw:Za.RW,leafType:wn.LinearU8,min:0,max:100},',
    '2:{nameSuffix:"MOTOR",rw:Za.RW,leafType:wn.Enum,enumName:{0:"STOP",2:"OPEN"}}}},',
    '[xn.CLIMATE]:{name:"CLIMATE",attributes:{11:{...fde,nameSuffix:"CLIMATE_SOURCE1"}}},',
    '[xn.UART_MODE]:{name:"UART_MODE",doNotDisplay:!0,attributes:{0:{rw:Za.NONE,leafType:wn.Binary}}}};',
    'const en={"BIN_IN":"Input","RELAY":"Relay","BLIND":"Blind","POSITION":"Position","MOTOR":"Motor","STOP":"Stop","OPEN":"Open","1":"auto"};'
].join('');

function run(bundle) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ampio-extract-'));
    const file = path.join(dir, 'App.js');
    fs.writeFileSync(file, bundle);
    try {
        return execFileSync(process.execPath, [TOOL, file], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
}

test('extract-designer-defs', async (t) => {
    const defs = JSON.parse(run(BUNDLE));

    await t.test('types, access and labels', () => {
        assert.deepEqual(defs[128], {name: 'BIN_IN', label: 'Input', attributes: {0: {label: '', rw: 'R', kind: 'binary'}}});
        assert.equal(defs[129].label, 'Relay');
        assert.equal(defs[129].attributes[0].rw, 'RW');
    });
    await t.test('ranges and translated enums', () => {
        assert.deepEqual(defs[136].attributes[0], {label: 'Position', rw: 'RW', kind: 'linearU8', min: 0, max: 100});
        assert.deepEqual(defs[136].attributes[2].enum, {0: 'Stop', 2: 'Open'});
    });
    await t.test('spread literals are resolved, missing labels are derived from the key', () => {
        assert.deepEqual(defs[155].attributes[11], {label: 'Climate source1', rw: 'R', kind: 'climateSource', fields: ['onOff', 'mode']});
        assert.equal(defs[155].label, 'Climate');
    });
    await t.test('types without usable attributes are left out', () => {
        assert.equal(defs[164], undefined);
    });
    await t.test('refuses to evaluate code', () => {
        for (const code of ['require("fs")', '(()=>1)()', 'globalThis.x']) {
            const evil = BUNDLE.replace('leafType:wn.Binary}}},[xn.REL]', 'leafType:wn.Binary,x:' + code + '}}},[xn.REL]');
            assert.notEqual(evil, BUNDLE, 'injection applied');
            assert.throws(() => run(evil), /non-literal code|no literal for/, code);
        }
    });
    await t.test('fails clearly when the table is not found', () => {
        assert.throws(() => run('var a=1;'), /could not locate leaf type enum/);
    });
});
