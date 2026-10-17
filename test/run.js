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

    // fake ampio-mqtt rpc: macProd differs from macUser, topics use macUser
    ext.on('message', (t, p) => {
        if (!t.startsWith('rpc/v2/request/ampio-mqtt/')) { return; }
        const r = JSON.parse(p);
        ok(r.method === 'get_devices' && r.id < 2147483647 && t.endsWith('/' + r.id), 'rpc request ' + p);
        ext.publish(t.replace('request', 'response'), JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { devices: [
            { macProd: 0x9999, macUser: 0x1a2b, deviceConfigTable: Buffer.from([1, 0x81, 8, 1, 0x88, 5]).toString('base64'), sections: [{ type: 17, length: s17.length, data: s17.toString('base64') }] },
        ] } }));
    });
    const before = (keep.sent || []).length;
    const res = await request('/ampio-v2/cfg/devices/v1/list');
    const d = res.body && res.body.find(x => x.mac === '1a2b');
    ok(res.code === 200 && d && d.name === 'Salon', 'discovery uses macUser and device name');
    ok(d && d.leafs.some(l => l.type === 129 && l.count === 8 && l.names[1] === 'Lampa żółta'), 'discovery channel names');
    ok(d && d.leafs.some(l => l.type === 136 && l.attribute === 2 && l.count === 5), 'discovery attributes from retained states');
    ok((keep.sent || []).length === before, 'discovery does not re-trigger IN nodes');

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
