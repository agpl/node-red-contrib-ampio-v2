// Unit tests for generic/ampio-utils.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const au = require('../generic/ampio-utils');
const { pbStr, pbMsg, pbVarint, descriptionRecord } = require('./fixtures');

test('build_topic', async (t) => {
    await t.test('state and set topics have 8 segments', () => {
        assert.equal(au.build_topic('state', '1f242', 129, 0, 3), 'device/v1/state/leaf/1f242/129/0/3');
        assert.equal(au.build_topic('set', '2a2a8', 136, 256, 0), 'device/v1/set/leaf/2a2a8/136/256/0');
    });
});

test('encode_value', async (t) => {
    await t.test('wraps value in v', () => {
        assert.equal(au.encode_value(5), '{"v":5}');
        assert.equal(au.encode_value('up'), '{"v":"up"}');
        assert.equal(au.encode_value({h: 120, s: 100, v: 50}), '{"v":{"h":120,"s":100,"v":50}}');
    });
    await t.test('booleans become 1/0', () => {
        assert.equal(au.encode_value(true), '{"v":1}');
        assert.equal(au.encode_value(false), '{"v":0}');
    });
    await t.test('time is added only when given', () => {
        assert.equal(au.encode_value(1, 30), '{"v":1,"time":30}');
        assert.equal(au.encode_value(1, 0), '{"v":1,"time":0}');
        assert.equal(au.encode_value(1, undefined), '{"v":1}');
    });
});

test('decode_value', async (t) => {
    await t.test('returns v from Buffer or string', () => {
        assert.equal(au.decode_value(Buffer.from('{"v":1}')), 1);
        assert.equal(au.decode_value('{"v":21.5}'), 21.5);
        assert.deepEqual(au.decode_value('{"v":{"ct":2700,"v":80}}'), {ct: 2700, v: 80});
    });
    await t.test('keeps falsy values', () => {
        assert.equal(au.decode_value('{"v":0}'), 0);
        assert.equal(au.decode_value('{"v":null}'), null);
        assert.equal(au.decode_value('{"v":false}'), false);
    });
    await t.test('rejects invalid payloads', () => {
        assert.throws(() => au.decode_value('garbage'), SyntaxError);
        assert.throws(() => au.decode_value('{"x":1}'), /missing "v"/);
        assert.throws(() => au.decode_value('1'), /missing "v"/);
        assert.throws(() => au.decode_value('null'), /missing "v"/);
    });
});

test('parse_config_table', async (t) => {
    const b64 = (bytes) => Buffer.from(bytes).toString('base64');
    await t.test('reads 01 <type> <count> records', () => {
        // real table of 1f242: REL x10, BLIND x5, BIN_FLAG x32, U8_FLAG x4, then non-leaf records
        const table = [1, 0x81, 10, 1, 0x88, 5, 1, 0x8b, 32, 1, 0x95, 4, 3, 4, 1, 3, 10, 1, 4, 2, 10];
        assert.deepEqual(au.parse_config_table(b64(table)), [
            {type: 129, count: 10}, {type: 136, count: 5}, {type: 139, count: 32}, {type: 149, count: 4}
        ]);
    });
    await t.test('empty or missing table', () => {
        assert.deepEqual(au.parse_config_table(''), []);
        assert.deepEqual(au.parse_config_table(undefined), []);
    });
    await t.test('ignores a truncated last record', () => {
        assert.deepEqual(au.parse_config_table(b64([1, 0x81, 8, 1, 0x88])), [{type: 129, count: 8}]);
    });
});

test('parse_descriptions', async (t) => {
    const channel = (index, name) => pbMsg(1, Buffer.concat([pbVarint(1, index), pbMsg(2, pbStr(1, name))]));
    const typeBlock = (type, channels) => pbMsg(3, Buffer.concat([pbVarint(1, type), pbMsg(2, Buffer.concat(channels))]));

    await t.test('device name and channel names per type', () => {
        const data = Buffer.concat([
            pbStr(1, 'M-DIM sypialnia'), pbVarint(2, 11),
            typeBlock(133, [channel(0, 'P3 kinkiet prawy'), channel(1, 'P3 kinkiet lewy')]),
            typeBlock(129, [channel(9, 'Ogrzewanie Podłoga Pralnia')])
        ]);
        assert.deepEqual(au.parse_descriptions(data.toString('base64')), {
            name: 'M-DIM sypialnia',
            channels: {133: {0: 'P3 kinkiet prawy', 1: 'P3 kinkiet lewy'}, 129: {9: 'Ogrzewanie Podłoga Pralnia'}}
        });
    });
    await t.test('skips empty channel names', () => {
        const data = Buffer.concat([pbStr(1, 'x'), typeBlock(129, [channel(0, ''), channel(1, 'Lampa')])]);
        assert.deepEqual(au.parse_descriptions(data.toString('base64')).channels, {129: {1: 'Lampa'}});
    });
    await t.test('type without channel list', () => {
        const data = pbMsg(3, pbVarint(1, 139));
        assert.deepEqual(au.parse_descriptions(data.toString('base64')), {name: '', channels: {139: {}}});
    });
    await t.test('empty data', () => {
        assert.deepEqual(au.parse_descriptions(''), {name: '', channels: {}});
    });
    await t.test('unsupported wire type throws', () => {
        assert.throws(() => au.parse_descriptions(Buffer.from([0x0b]).toString('base64')), /wire type/);
    });
});

test('device_info', async (t) => {
    await t.test('MAC from macUser, falls back to macProd', () => {
        assert.equal(au.device_info({macProd: 0x9999, macUser: 0x1a2b}).mac, '1a2b');
        assert.equal(au.device_info({macProd: 0x1f242}).mac, '1f242');
    });
    await t.test('name from base64 name of old devices', () => {
        const info = au.device_info({macProd: 1, name: Buffer.from('M-SENS Łazienka M').toString('base64')});
        assert.equal(info.name, 'M-SENS Łazienka M');
        assert.deepEqual(info.leafs, []);
    });
    await t.test('name and channels from section 17, leafs from config table', () => {
        const s17 = Buffer.concat([pbStr(1, 'Salon'), pbMsg(3, Buffer.concat([pbVarint(1, 129),
            pbMsg(2, pbMsg(1, Buffer.concat([pbVarint(1, 0), pbMsg(2, pbStr(1, 'Lampa'))])))]))]);
        const info = au.device_info({
            macProd: 0x1a2b,
            deviceConfigTable: Buffer.from([1, 0x81, 8]).toString('base64'),
            sections: [{type: 16, length: 0, data: ''}, {type: 17, length: s17.length, data: s17.toString('base64')}]
        });
        assert.deepEqual(info, {mac: '1a2b', name: 'Salon', leafs: [{type: 129, count: 8}], channels: {129: {0: 'Lampa'}}});
    });
    await t.test('broken section 17 does not fail the device', () => {
        const info = au.device_info({macProd: 1, sections: [{type: 17, length: 1, data: Buffer.from([0x0b]).toString('base64')}]});
        assert.deepEqual(info.channels, {});
    });
});

test('discover_devices', async (t) => {
    const rpc = [
        {macProd: 0x1a2b, macUser: 0x1a2b, deviceConfigTable: Buffer.from([1, 0x81, 8, 1, 0x88, 5]).toString('base64'), sections: []},
        {macProd: 0x5555, macUser: 0x5555, name: Buffer.from('M-SENS').toString('base64'), deviceConfigTable: '', sections: []}
    ];
    const topics = [
        'device/v1/state/leaf/1a2b/136/0/4', 'device/v1/state/leaf/1a2b/136/2/0',
        'device/v1/state/leaf/1a2b/139/0/31', 'device/v1/state/leaf/bad'
    ];
    const legacy = ['ampio/from/5555/state/f/3', 'ampio/from/5555/state/f/1', 'ampio/from/5555/state/t/1', 'ampio/from/7777/state/i/2', 'ampio/from/5555/raw'];
    const api = [{macProd: 0x5555, macUser: 0x5555, name: '', descriptions: descriptionRecord(6, 2, 'Obecność').toString('base64')}];
    const out = au.discover_devices(rpc, topics, legacy, api);
    const byMac = Object.fromEntries(out.map((d) => [d.mac, d]));

    await t.test('devices sorted by MAC, including ones seen only in topics', () => {
        assert.deepEqual(out.map((d) => d.mac), ['1a2b', '5555', '7777']);
    });
    await t.test('channel counts from config table, attributes from retained states', () => {
        assert.deepEqual(byMac['1a2b'].leafs.map((l) => [l.type, l.attribute, l.count]), [
            [129, 0, 8], [136, 0, 5], [136, 2, 5], [139, 0, 32]
        ]);
    });
    await t.test('legacy flag for devices without device/v1 leafs', () => {
        assert.equal(byMac['1a2b'].legacy, false);
        assert.equal(byMac['5555'].legacy, true);
        assert.equal(byMac['7777'].legacy, true);
    });
    await t.test('legacy types with sorted indexes and names', () => {
        assert.deepEqual(byMac['5555'].legacyTypes, [
            {valtype: 'f', indexes: [1, 3], names: {3: 'Obecność'}},
            {valtype: 't', indexes: [1], names: {}}
        ]);
        assert.equal(byMac['5555'].name, 'M-SENS');
        assert.deepEqual(byMac['7777'].legacyTypes, [{valtype: 'i', indexes: [2], names: {}}]);
    });
    await t.test('works without rpc data and without api list', () => {
        const only = au.discover_devices([], ['device/v1/state/leaf/abcd/129/0/2'], [], null);
        assert.deepEqual(only, [{mac: 'abcd', name: '', legacy: false, leafs: [{type: 129, attribute: 0, count: 3, names: {}}], legacyTypes: []}]);
    });
});

test('legacy API helpers', async (t) => {
    await t.test('topics use uppercase MAC', () => {
        assert.equal(au.legacy_state_topic('1fe5c', 't', 1), 'ampio/from/1FE5C/state/t/1');
        assert.equal(au.legacy_set_topic('1fe5c', 'f', 5), 'ampio/to/1FE5C/f/5/cmd');
    });
    await t.test('analog outputs are written through o', () => {
        assert.equal(au.legacy_set_topic('1dd55', 'a', 2), 'ampio/to/1DD55/o/2/cmd');
        assert.equal(au.legacy_set_topic('14ae0', 'rm', 1), 'ampio/to/14AE0/rm/1/cmd');
    });
    await t.test('decode_legacy_value converts numbers only', () => {
        assert.equal(au.decode_legacy_value(Buffer.from('19.0')), 19);
        assert.equal(au.decode_legacy_value(Buffer.from('-3')), -3);
        assert.equal(au.decode_legacy_value(Buffer.from('0,0,0,0')), '0,0,0,0');
        assert.equal(au.decode_legacy_value(Buffer.from('ON')), 'ON');
        assert.equal(au.decode_legacy_value(Buffer.from(' ')), ' ');
    });
    await t.test('encode_legacy_value', () => {
        assert.equal(au.encode_legacy_value(true), '1');
        assert.equal(au.encode_legacy_value(false), '0');
        assert.equal(au.encode_legacy_value(21.5), '21.5');
        assert.equal(au.encode_legacy_value('19,20'), '19,20');
        assert.equal(au.encode_legacy_value({a: 1}), '{"a":1}');
        assert.equal(au.encode_legacy_value(null), 'null');
    });
});

test('raw frames', async (t) => {
    await t.test('raw_topic uses lowercase MAC', () => {
        assert.equal(au.raw_topic('15D6C'), 'ampio/to/15d6c/raw');
    });
    await t.test('encode_raw accepts hex strings, Buffers and byte arrays', () => {
        assert.equal(au.encode_raw('0901'), '0901');
        assert.equal(au.encode_raw('0x09 01'), '0901');
        assert.equal(au.encode_raw('09:0A-FF'), '090aff');
        assert.equal(au.encode_raw(Buffer.from([9, 1])), '0901');
        assert.equal(au.encode_raw([0x0a, 255]), '0aff');
    });
    await t.test('encode_raw rejects other input', () => {
        assert.throws(() => au.encode_raw('xyz'), /hex bytes/);
        assert.throws(() => au.encode_raw('090'), /hex bytes/);
        assert.throws(() => au.encode_raw(''), /hex bytes/);
        assert.throws(() => au.encode_raw(9), /hex bytes/);
    });
});

test('parse_legacy_descriptions', async (t) => {
    await t.test('maps description codes to legacy value types and indexes', () => {
        const blob = Buffer.concat([
            descriptionRecord(1, 0, '.'),
            descriptionRecord(3, 0, 'Temperatura wewnętrzna'),
            descriptionRecord(6, 4, 'Alarm Uzbrojony'),
            descriptionRecord(38, 0, 'Wilgotność'),
            descriptionRecord(39, 0, 'Jasność'),
            descriptionRecord(40, 0, 'CO2'),
            descriptionRecord(29, 3, 'Deye - export'),
            descriptionRecord(44, 0, 'Korytarz Kinkiet'),
            descriptionRecord(19, 0, 'icon, not mapped')
        ]);
        assert.deepEqual(au.parse_legacy_descriptions(blob.toString('base64')), {
            t: {1: 'Temperatura wewnętrzna'},
            f: {5: 'Alarm Uzbrojony'},
            au16l: {1: 'Wilgotność', 4: 'Jasność', 7: 'CO2'},
            au32: {3: 'Deye - export'},
            a: {1: 'Korytarz Kinkiet'},
            o: {1: 'Korytarz Kinkiet'}
        });
    });
    await t.test('stops at a truncated record', () => {
        const blob = Buffer.concat([descriptionRecord(6, 0, 'ok'), descriptionRecord(6, 1, 'cut').subarray(0, 12)]);
        assert.deepEqual(au.parse_legacy_descriptions(blob.toString('base64')), {f: {1: 'ok'}});
    });
    await t.test('empty input', () => {
        assert.deepEqual(au.parse_legacy_descriptions(''), {});
        assert.deepEqual(au.parse_legacy_descriptions(undefined), {});
    });
});

test('describe_change', async (t) => {
    const leafdefs = require('../ampioin/db/leafdefs.json');
    const legacydefs = require('../ampioin/db/legacytypes.json');
    const devices = {
        '1f242': {mac: '1f242', name: 'M-REL-C10s', legacy: false, leafs: [{type: 129, attribute: 0, count: 10, names: {1: 'Salon'}}], legacyTypes: []},
        '1fe5c': {mac: '1fe5c', name: 'M-SENS', legacy: true, leafs: [], legacyTypes: [{valtype: 't', indexes: [1], names: {1: 'Wiatrołap'}}]}
    };

    await t.test('device/v1 change with names', () => {
        assert.deepEqual(au.describe_change('device/v1/state/leaf/1f242/129/0/1', 1, devices, leafdefs, legacydefs), {
            value: 1, moduleMac: '1f242', moduleName: 'M-REL-C10s', valueType: 'Relay', valueName: 'Salon', index: 1, api: 'device/v1'
        });
    });
    await t.test('attribute label is part of valueType', () => {
        assert.equal(au.describe_change('device/v1/state/leaf/1f242/136/2/0', 2, devices, leafdefs, legacydefs).valueType, 'Blind - Motor');
        assert.equal(au.describe_change('device/v1/state/leaf/1f242/250/3/0', 2, devices, leafdefs, legacydefs).valueType, 'type 250 - attribute 3');
    });
    await t.test('legacy change with names, MAC lowercased', () => {
        assert.deepEqual(au.describe_change('ampio/from/1FE5C/state/t/1', 21.7, devices, leafdefs, legacydefs), {
            value: 21.7, moduleMac: '1fe5c', moduleName: 'M-SENS', valueType: 'Temperature', valueName: 'Wiatrołap', index: 1, api: 'legacy'
        });
    });
    await t.test('unknown module and channel give undefined names', () => {
        const c = au.describe_change('ampio/from/ABCD/state/zz/2', '1', devices, leafdefs, legacydefs);
        assert.equal(c.moduleName, undefined);
        assert.equal(c.valueName, undefined);
        assert.equal(c.valueType, 'zz');
        assert.ok('valueName' in c && 'moduleName' in c);
    });
    await t.test('other topics are ignored', () => {
        assert.equal(au.describe_change('ampio/from/1FE5C/raw', '0901', devices, leafdefs, legacydefs), null);
        assert.equal(au.describe_change('device/v1/meta/leaf/1f242/129/0/1', 1, devices, leafdefs, legacydefs), null);
        assert.equal(au.describe_change('zigbee2mqtt/bridge/state', 'online', devices, leafdefs, legacydefs), null);
    });
});

test('legacy_on_v1', async (t) => {
    const dev = {legacy: false, leafs: [{type: 139}, {type: 129}]};
    await t.test('legacy value types with a device/v1 counterpart on the same module', () => {
        assert.equal(au.legacy_on_v1(dev, 'f'), true);
        assert.equal(au.legacy_on_v1(dev, 'o'), true);
        assert.equal(au.legacy_on_v1(dev, 'rs'), false);
        assert.equal(au.legacy_on_v1(dev, 'i'), false);
    });
    await t.test('legacy and unknown devices never count as duplicates', () => {
        assert.equal(au.legacy_on_v1({legacy: true, leafs: []}, 'f'), false);
        assert.equal(au.legacy_on_v1(undefined, 'f'), false);
    });
});

test('LCD helpers (legacy behaviour kept)', async (t) => {
    await t.test('sanitize_mac uppercases and strips leading zeros', () => {
        assert.equal(au.sanitize_mac('0001'), '1');
        assert.equal(au.sanitize_mac('00ab12'), 'AB12');
        assert.equal(au.sanitize_mac('0000'), '');
    });
    await t.test('sanitize_ioid strips leading zeros', () => {
        assert.equal(au.sanitize_ioid('007'), '7');
        assert.equal(au.sanitize_ioid('10'), '10');
    });
    await t.test('hex2rgb565 returns byte-swapped RGB565', () => {
        assert.equal(au.hex2rgb565('FF0000'), '00F8');
        assert.equal(au.hex2rgb565('00FF00'), 'E007');
        assert.equal(au.hex2rgb565('FFFFFF'), 'FFFF');
        assert.equal(au.hex2rgb565('000000'), '0000');
    });
    await t.test('decStrToHexStr pads to two digits', () => {
        assert.equal(au.decStrToHexStr('10'), '0a');
        assert.equal(au.decStrToHexStr('255'), 'ff');
    });
});
