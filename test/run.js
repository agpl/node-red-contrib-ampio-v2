// Runs IN/OUT/config nodes against an in-process MQTT broker (aedes) with a stubbed Node-RED runtime.
//   npm test
'use strict';
const path = require('path');
const net = require('net');
const EventEmitter = require('events');
const mqtt = require('mqtt');
const aedes = require('aedes')();

const ROOT = path.join(__dirname, '..');
const PORT = 18831;
const routes = {}, types = {}, nodes = {};
const quiet = console.log;
let failed = 0;

const RED = {
    nodes: {
        createNode(n, c) {
            Object.assign(n, new EventEmitter());
            n.on = EventEmitter.prototype.on;
            n.emit = EventEmitter.prototype.emit;
            n.id = c.id;
            n.credentials = {};
            n.status = s => (n._status = s);
            n.send = m => (n.sent = (n.sent || []).concat([m]));
            n.warn = w => (n.warns = (n.warns || []).concat([w]));
            n.error = () => {};
            n.log = () => {};
            nodes[c.id] = n;
        },
        registerType(name, fn) { types[name] = fn; },
        getNode(id) { return nodes[id]; },
    },
    httpAdmin: { get(p, perm, h) { routes[p] = h; } },
    auth: { needsPermission() {} },
};

console.log = () => {};
require(path.join(ROOT, 'ampioin/ampio-config.js'))(RED);
require(path.join(ROOT, 'ampioin/in.js'))(RED);
require(path.join(ROOT, 'ampioin/out.js'))(RED);
require(path.join(ROOT, 'ampioin/audit.js'))(RED);
const au = require(path.join(ROOT, 'generic/ampio-utils.js'));

const mk = (t, c) => { const n = {}; types[t].call(n, c); return n; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = (c, m) => { quiet((c ? 'PASS ' : 'FAIL ') + m); if (!c) { failed++; } };
const request = (route) => new Promise(resolve => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; resolve(this); } };
    routes[route]({}, res);
});

// protobuf helpers to build a section 17 description
const pbStr = (f, str) => { const b = Buffer.from(str); return Buffer.concat([Buffer.from([f << 3 | 2, b.length]), b]); };
const pbMsg = (f, buf) => Buffer.concat([Buffer.from([f << 3 | 2, buf.length]), buf]);

function unitTests() {
    ok(au.build_topic('set', '1a2b', 129, 0, 3) === 'device/v1/set/leaf/1a2b/129/0/3', 'build_topic');
    ok(au.encode_value(true) === '{"v":1}' && au.encode_value(false) === '{"v":0}', 'encode_value booleans as 1/0');
    ok(au.encode_value(5, 10) === '{"v":5,"time":10}', 'encode_value with time');
    ok(au.decode_value(Buffer.from('{"v":{"h":1}}')).h === 1, 'decode_value object');
    ok(JSON.stringify(au.parse_config_table(Buffer.from([1, 0x81, 10, 3, 4, 1, 1, 0x88, 5]).toString('base64'))) ===
        '[{"type":129,"count":10},{"type":136,"count":5}]', 'parse_config_table skips non-leaf records');
    const chan = pbMsg(1, Buffer.concat([Buffer.from([0x08, 0x01]), pbMsg(2, pbStr(1, 'Lampa żółta'))]));
    const s17 = Buffer.concat([pbStr(1, 'Salon'), pbMsg(3, Buffer.concat([Buffer.from([0x08, 0x81, 0x01]), pbMsg(2, chan)]))]);
    const desc = au.parse_descriptions(s17.toString('base64'));
    ok(desc.name === 'Salon' && desc.channels[129][1] === 'Lampa żółta', 'parse_descriptions');
    const defs = require(path.join(ROOT, 'ampioin/db/leafdefs.json'));
    ok(defs[136] && defs[136].attributes[2].enum[2] === 'Open' && defs[129].attributes[0].rw === 'RW', 'leafdefs.json has blind enum and relay access');
    ok(au.legacy_state_topic('1fe5c', 'f', 3) === 'ampio/from/1FE5C/state/f/3', 'legacy_state_topic uppercases MAC');
    ok(au.legacy_set_topic('1dd55', 'a', 2) === 'ampio/to/1DD55/o/2/cmd' && au.legacy_set_topic('1dd55', 'f', 2) === 'ampio/to/1DD55/f/2/cmd', 'legacy_set_topic, analog written via o');
    ok(au.decode_legacy_value(Buffer.from('19.0')) === 19 && au.decode_legacy_value(Buffer.from('0,0,0,0')) === '0,0,0,0', 'decode_legacy_value');
    ok(au.encode_legacy_value(true) === '1' && au.encode_legacy_value(21.5) === '21.5', 'encode_legacy_value');
    const rec = (code, idx, name) => { const n = Buffer.from(name); const b = Buffer.alloc(10 + n.length); b.writeUInt16LE(b.length, 0); b.writeUInt16LE(code, 2); b.writeUInt16LE(idx, 4); n.copy(b, 10); return b; };
    const ld = au.parse_legacy_descriptions(Buffer.concat([rec(1, 0, '.'), rec(6, 0, 'Obecność'), rec(39, 2, 'Ciśnienie względne'), rec(99, 0, 'x')]).toString('base64'));
    ok(ld.f[1] === 'Obecność' && ld.au16l[6] === 'Ciśnienie względne' && Object.keys(ld).length === 2, 'parse_legacy_descriptions');
    ok(au.raw_topic('15D6C') === 'ampio/to/15d6c/raw', 'raw_topic lowercases MAC');
    ok(au.encode_raw('0x09 01') === '0901' && au.encode_raw(Buffer.from([9, 1])) === '0901' && au.encode_raw([0x0a, 255]) === '0aff', 'encode_raw formats');
    let rawErr; try { au.encode_raw('xyz'); } catch (e) { rawErr = e; }
    ok(rawErr instanceof Error, 'encode_raw rejects non-hex');
    return s17;
}

async function integrationTests(s17) {
    const cfg = mk('ampiov2config', { id: 'cfg', server: '127.0.0.1', port: String(PORT) });
    const inN = mk('Ampio v2 IN', { id: 'in1', server: 'cfg', mac: '1a2b', devtype: '129', attribute: '0', index: '0', retainignore: false });
    const outN = mk('Ampio v2 OUT', { id: 'out1', server: 'cfg', mac: '1a2b', devtype: '129', attribute: '0', index: '0' });
    const ext = mqtt.connect('mqtt://127.0.0.1:' + PORT);
    const seen = [];
    ext.on('message', (t, p) => seen.push([t, p.toString()]));
    await new Promise(r => ext.on('connect', r));
    ext.subscribe(['device/v1/set/#', 'rpc/v2/request/ampio-mqtt/+']);
    await wait(300);

    ext.publish('device/v1/state/leaf/1a2b/136/2/4', '{"v":2}', { retain: true });
    ext.publish('device/v1/state/leaf/1a2b/129/0/0', '{"v":1}');
    ext.publish('device/v1/state/leaf/1a2b/129/0/1', '{"v":9}');
    ext.publish('device/v1/state/leaf/1a2b/129/0/0', 'garbage');
    await wait(200);
    ok(inN.sent && inN.sent.length === 1 && inN.sent[0].payload === 1 && inN.sent[0].index === 0, 'IN receives only its own topic');
    ok(inN.warns && inN.warns.length === 1, 'IN warns on invalid JSON');

    const cfg2 = mk('ampiov2config', { id: 'cfg2', server: '127.0.0.1', port: String(PORT) });
    const skip = mk('Ampio v2 IN', { id: 'in3', server: 'cfg2', mac: '1a2b', devtype: '136', attribute: '2', index: '4', retainignore: true });
    const keep = mk('Ampio v2 IN', { id: 'in4', server: 'cfg2', mac: '1a2b', devtype: '136', attribute: '2', index: '4', retainignore: false });
    await wait(400);
    ok(!skip.sent, 'retainignore=true skips retained state');
    ok(keep.sent && keep.sent[0].payload === 2, 'retainignore=false delivers retained state');

    let err = 'unset', badErr;
    outN.emit('input', { payload: true }, null, e => (err = e));
    outN.emit('input', { payload: { h: 120, s: 100, v: 50 }, devtype: 134, attribute: 0, index: 1, time: 30 }, null, () => {});
    outN.emit('input', { payload: 1, devtype: 'x' }, null, e => (badErr = e));
    await wait(200);
    ok(err === undefined || err === null, 'OUT done() without error');
    ok(seen.some(([t, p]) => t === 'device/v1/set/leaf/1a2b/129/0/0' && p === '{"v":1}'), 'OUT sends true as {"v":1}');
    ok(seen.some(([t, p]) => t === 'device/v1/set/leaf/1a2b/134/0/1' && p === '{"v":{"h":120,"s":100,"v":50},"time":30}'), 'OUT overrides, object payload and time');
    ok(badErr instanceof Error, 'OUT rejects invalid devtype');

    const inL = mk('Ampio v2 IN', { id: 'inL', server: 'cfg', mac: '1fe5c', valtype: 't', devtype: '', index: '2', retainignore: false });
    const outL = mk('Ampio v2 OUT', { id: 'outL', server: 'cfg', mac: '1fe5c', valtype: 'f', devtype: '', index: '5' });
    ext.subscribe('ampio/to/#');
    await wait(200);
    ext.publish('ampio/from/1FE5C/state/t/2', '21.5');
    ext.publish('ampio/from/1FE5C/state/t/3', '9');
    outL.emit('input', { payload: true }, null, () => {});
    outN.emit('input', { payload: 1, valtype: 'o' }, null, () => {});
    outL.emit('input', { payload: 1, devtype: 139, attribute: 0 }, null, () => {});
    await wait(200);
    ok(inL.sent && inL.sent.length === 1 && inL.sent[0].payload === 21.5 && inL.sent[0].valtype === 't' && inL.sent[0].devtype === undefined, 'legacy IN receives number from ampio/from');
    ok(seen.some(([t, p]) => t === 'ampio/to/1FE5C/f/5/cmd' && p === '1'), 'legacy OUT sends to ampio/to/.../cmd');
    ok(seen.some(([t, p]) => t === 'ampio/to/1A2B/o/0/cmd' && p === '1'), 'msg.valtype switches OUT to legacy API');
    ok(seen.some(([t, p]) => t === 'device/v1/set/leaf/1fe5c/139/0/5' && p === '{"v":1}'), 'msg.devtype switches legacy OUT to device/v1');
    const outR = mk('Ampio v2 OUT', { id: 'outR', server: 'cfg', mac: '15D6C', valtype: 'raw', devtype: '', index: 0 });
    let badRaw;
    outR.emit('input', { payload: '09 01' }, null, () => {});
    outR.emit('input', { payload: 'zz' }, null, e => (badRaw = e));
    await wait(200);
    ok(seen.some(([t, p]) => t === 'ampio/to/15d6c/raw' && p === '0901'), 'raw OUT sends hex to ampio/to/<mac>/raw');
    ok(badRaw instanceof Error, 'raw OUT rejects invalid payload');

    // fake ampio-mqtt rpc: macProd differs from macUser, topics use macUser
    ext.on('message', (t, p) => {
        if (!t.startsWith('rpc/v2/request/ampio-mqtt/')) { return; }
        const r = JSON.parse(p);
        ok(r.method === 'get_devices' && r.id < 2147483647 && t.endsWith('/' + r.id), 'rpc request ' + p);
        ext.publish(t.replace('request', 'response'), JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { devices: [
            { macProd: 0x5555, macUser: 0x5555, name: Buffer.from('M-SENS stary').toString('base64'), deviceConfigTable: '', sections: [] },
            { macProd: 0x9999, macUser: 0x1a2b, deviceConfigTable: Buffer.from([1, 0x81, 8, 1, 0x88, 5]).toString('base64'), sections: [{ type: 17, length: s17.length, data: s17.toString('base64') }] },
        ] } }));
    });
    ext.subscribe('device_api/to/list');
    ext.publish('ampio/from/5555/state/f/1', '0', { retain: true });
    ext.publish('ampio/from/5555/state/f/3', '1', { retain: true });
    ext.publish('ampio/from/5555/state/rs/1', '19.0', { retain: true });
    ext.on('message', (t) => {
        if (t !== 'device_api/to/list') { return; }
        const n = Buffer.from('Obecność'); const b = Buffer.alloc(10 + n.length); b.writeUInt16LE(b.length, 0); b.writeUInt16LE(6, 2); b.writeUInt16LE(2, 4); n.copy(b, 10);
        ext.publish('device_api/from/list', JSON.stringify({ devices: [{ macProd: 0x5555, macUser: 0x5555, name: Buffer.from('M-SENS stary').toString('base64'), descriptions: b.toString('base64') }] }));
    });
    await wait(200);
    const before = (keep.sent || []).length;
    const res = await request('/ampio-v2/cfg/devices/v1/list');
    const d = res.body && res.body.find(x => x.mac === '1a2b');
    ok(res.code === 200 && d && d.name === 'Salon' && d.legacy === false, 'discovery uses macUser and device name');
    ok(d && d.leafs.some(l => l.type === 129 && l.count === 8 && l.names[1] === 'Lampa żółta'), 'discovery channel names');
    ok(d && d.leafs.some(l => l.type === 136 && l.attribute === 2 && l.count === 5), 'discovery attributes from retained states');
    const legacy = res.body && res.body.find(x => x.mac === '5555');
    ok(legacy && legacy.legacy === true && legacy.name === 'M-SENS stary' && legacy.leafs.length === 0, 'discovery lists legacy devices');
    const lf = legacy && legacy.legacyTypes.find(x => x.valtype === 'f');
    ok(lf && JSON.stringify(lf.indexes) === '[1,3]' && lf.names[3] === 'Obecność', 'discovery legacy types, indexes and names');
    ok(legacy && legacy.legacyTypes.some(x => x.valtype === 'rs'), 'discovery legacy zone type');
    ok((keep.sent || []).length === before, 'discovery does not re-trigger IN nodes');

    // audit: names from discovery, retained only seeds, repeats skipped, legacy duplicates of device/v1 skipped
    const audit = mk('Ampio v2 Audit', { id: 'audit', server: 'cfg', source: 'auto', onlychanges: true, retained: false });
    await wait(1500);
    ok(audit._status && audit._status.text === 'listening, 2 devices', 'audit discovers devices: ' + (audit._status && audit._status.text));
    ext.publish('device/v1/state/leaf/1a2b/129/0/1', '{"v":1}');
    ext.publish('device/v1/state/leaf/1a2b/129/0/1', '{"v":1}');
    ext.publish('ampio/from/5555/state/f/3', '0');
    ext.publish('ampio/from/1A2B/state/o/1', '1');
    ext.publish('ampio/from/1A2B/state/rs/1', '20');
    ext.publish('device/v1/state/leaf/9999/129/0/0', '{"v":0}');
    await wait(300);
    const got = (audit.sent || []).map(m => m.payload);
    const relay = got.find(c => c.moduleMac === '1a2b' && c.valueType === 'Relay');
    ok(relay && relay.value === 1 && relay.moduleName === 'Salon' && relay.valueName === 'Lampa żółta' && relay.index === 1 && relay.api === 'device/v1', 'audit device/v1 change with names ' + JSON.stringify(relay));
    ok(got.filter(c => c.moduleMac === '1a2b' && c.valueType === 'Relay').length === 1, 'audit skips repeated value');
    const flag = got.find(c => c.moduleMac === '5555');
    ok(flag && flag.value === 0 && flag.valueType === 'Flag' && flag.valueName === 'Obecność' && flag.moduleName === 'M-SENS stary' && flag.api === 'legacy', 'audit legacy change with names ' + JSON.stringify(flag));
    ok(!got.some(c => c.api === 'legacy' && c.moduleMac === '1a2b' && c.valueType === 'Digital output'), 'audit skips legacy duplicate of device/v1 value');
    ok(got.some(c => c.api === 'legacy' && c.moduleMac === '1a2b' && c.valueType === 'Zone set temperature' && c.value === 20), 'audit keeps legacy value without device/v1 counterpart');
    const unknown = got.find(c => c.moduleMac === '9999');
    ok(unknown && unknown.moduleName === undefined && unknown.valueName === undefined && 'valueName' in unknown, 'audit unknown module: names undefined');
    ok(!got.some(c => c.valueType && c.valueType.startsWith('Blind')), 'audit does not report retained states');
    ok(audit.sent && audit.sent.every(m => m.topic && typeof m.payload === 'object'), 'audit msg has topic and payload object');
    await new Promise(r => audit.emit('close', true, r));

    const defsRes = await request('/ampio-v2/cfg/leafdefs');
    ok(defsRes.body && defsRes.body[136].label === 'Blind', 'leafdefs endpoint');

    const listeners = cfg.client.listenerCount('message');
    const subs = Object.values(cfg.subscriptions).reduce((a, s) => a + Object.keys(s).length, 0);
    ok(listeners === subs, 'no leaked message listeners');

    await new Promise(r => inN.emit('close', true, r));
    await wait(100);
    ok(cfg.client.connected, 'removing one IN node keeps shared connection');
    ext.end(true);
}

const server = net.createServer(aedes.handle);
server.listen(PORT, async () => {
    try {
        await integrationTests(unitTests());
    } catch (e) {
        ok(false, 'exception: ' + e.stack);
    }
    quiet(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
});
