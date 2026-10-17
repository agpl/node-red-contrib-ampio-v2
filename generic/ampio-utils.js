exports.sanitize_mac = function(mac_string) {
    mac_string = mac_string.toUpperCase();
    let mac_stripped_leading_zeroes = false;
    while(mac_stripped_leading_zeroes == false){
        if(mac_string[0] == '0'){
            mac_string = mac_string.substring(1);
        } else {
            mac_stripped_leading_zeroes = true;
        }
    }
    return mac_string;
}

exports.sanitize_ioid = function(ioid_string) {
    let ioid_stripped_leading_zeroes = false;
    while(ioid_stripped_leading_zeroes == false){
        if(ioid_string[0]=='0'){
            ioid_string = ioid_string.substring(1);
        } else{
            ioid_stripped_leading_zeroes=true;
        }
    }
    return ioid_string;
}

exports.setup_mqtt_client = function(node, config) {
    const mqtt = require('mqtt');
    const client = mqtt.connect('mqtt://' + config.srvaddress);
    return client;
}

exports.setup_node_status_from_mqtt_client = function(node) {
    node.status({fill: "yellow", shape: "dot", text: "not connected"});

    node.client.on('reconnect', function () {
        node.status({fill:"yellow", shape: "dot", text: "reconnecting"});
    })

    node.client.on('error', function() {
        node.status({fill: "red", shape: "dot", text: "error"});
    })

    node.client.on('close', function() {
        node.status({fill: "red",shape: "dot", text: "connection closed"});
    })

    node.client.on('offline', function() {
        node.status({fill: "red", shape:"dot", text: "disconnected"});
    })
}

exports.hex2rgb565 = function (hexcol){
    var leftPad = require('left-pad');
	let r=hexcol.substring(0,2);
	let g=hexcol.substring(2,4);
	let b=hexcol.substring(4,6);

	r = parseInt(r,16);
	g = parseInt(g,16);
	b = parseInt(b,16);

	let r5 = r>>3;
	let g6 = g>>2;
	let b5 = b>>3;

	let rgb565 = r5<<11 | g6<<5 | b5;

    let byte_h = (rgb565 >> 8) & 0xFF;
    let byte_l = (rgb565 >> 0) & 0xFF;
    rgb565 = byte_l << 8 | byte_h;

	let rgb565s = leftPad(rgb565.toString(16),4,'0');

	return rgb565s.toUpperCase();
}

exports.decStrToHexStr = function (dec_str) {
    const val = parseInt(dec_str, 10);
    return val.toString(16).padStart(2, '0');
}

// device/v1/<state|set>/leaf/<MAC>/<type>/<attribute>/<index>
exports.build_topic = function (action, mac, type, attribute, index) {
    return 'device/v1/' + action + '/leaf/' + mac + '/' + type + '/' + attribute + '/' + index;
}

// Payloads are JSON objects carrying the value in "v", ex. {"v": 1} or {"v": {"h": 0, "s": 0, "v": 0}}
exports.encode_value = function (value) {
    return JSON.stringify({v: value});
}

exports.decode_value = function (payload) {
    const data = JSON.parse(payload.toString('utf-8'));
    if (data === null || typeof data !== 'object' || !data.hasOwnProperty('v')) {
        throw new Error('missing "v" field');
    }
    return data.v;
}

// Minimal protobuf reader: [{field, value}], value is Number for varints, Buffer for length-delimited
function pb_fields(buf) {
    const out = [];
    let i = 0;
    function varint() {
        let r = 0, mul = 1, b;
        do {
            b = buf[i++];
            r += (b & 0x7f) * mul;
            mul *= 128;
        } while (b & 0x80);
        return r;
    }
    while (i < buf.length) {
        const key = varint();
        const wt = key % 8;
        const field = Math.floor(key / 8);
        if (wt === 0) {
            out.push({field: field, value: varint()});
        } else if (wt === 2) {
            const len = varint();
            out.push({field: field, value: buf.slice(i, i + len)});
            i += len;
        } else if (wt === 5) {
            i += 4;
        } else if (wt === 1) {
            i += 8;
        } else {
            throw new Error('unsupported protobuf wire type ' + wt);
        }
    }
    return out;
}

function pb_get(fields, field) {
    const f = fields.find(function (x) { return x.field === field; });
    return f ? f.value : undefined;
}

// deviceConfigTable: 3-byte records, record 01 <type> <count> describes a leaf type
exports.parse_config_table = function (b64) {
    const buf = Buffer.from(b64 || '', 'base64');
    const leafs = [];
    for (let i = 0; i + 2 < buf.length; i += 3) {
        if (buf[i] === 1) {
            leafs.push({type: buf[i + 1], count: buf[i + 2]});
        }
    }
    return leafs;
}

// Section 17 (protobuf): 1 = device name, 3 = repeated {1 = type, 2 = {1 = repeated {1 = index, 2 = {1 = name}}}}
exports.parse_descriptions = function (b64) {
    const result = {name: '', channels: {}};
    const fields = pb_fields(Buffer.from(b64 || '', 'base64'));
    const name = pb_get(fields, 1);
    result.name = name ? name.toString('utf-8') : '';
    fields.filter(function (f) { return f.field === 3; }).forEach(function (t) {
        const tf = pb_fields(t.value);
        const type = pb_get(tf, 1);
        const list = pb_get(tf, 2);
        const names = result.channels[type] = {};
        if (!list) {
            return;
        }
        pb_fields(list).filter(function (c) { return c.field === 1; }).forEach(function (c) {
            const cf = pb_fields(c.value);
            const desc = pb_get(cf, 2);
            const label = desc ? pb_get(pb_fields(desc), 1) : undefined;
            if (label && label.length) {
                names[pb_get(cf, 1) || 0] = label.toString('utf-8');
            }
        });
    });
    return result;
}

// get_devices device -> {mac, name, leafs: [{type, count}], channels: {type: {index: name}}}
exports.device_info = function (dev) {
    const info = {
        mac: dev.macProd.toString(16),
        name: dev.name ? Buffer.from(dev.name, 'base64').toString('utf-8') : '',
        leafs: exports.parse_config_table(dev.deviceConfigTable),
        channels: {}
    };
    const section = (dev.sections || []).find(function (s) { return s.type === 17 && s.length > 0; });
    if (section) {
        try {
            const desc = exports.parse_descriptions(section.data);
            info.name = info.name || desc.name;
            info.channels = desc.channels;
        } catch (err) {
            // descriptions are optional, device stays usable without names
        }
    }
    return info;
}

// get_devices result + retained state topics -> [{mac, name, leafs: [{type, attribute, count, names}]}]
// Types and channel counts come from deviceConfigTable, attributes from retained states (default 0).
exports.discover_devices = function (rpcDevices, topics) {
    const seen = {};
    topics.forEach(function (topic) {
        const p = topic.split('/');
        if (p.length !== 8) {
            return;
        }
        const types = seen[p[4]] = seen[p[4]] || {};
        const attrs = types[p[5]] = types[p[5]] || {};
        attrs[p[6]] = Math.max(attrs[p[6]] || 0, Number(p[7]) + 1);
    });
    const devices = {};
    rpcDevices.map(exports.device_info).forEach(function (info) {
        devices[info.mac] = info;
    });
    Object.keys(seen).forEach(function (mac) {
        devices[mac] = devices[mac] || {mac: mac, name: '', leafs: [], channels: {}};
    });
    return Object.keys(devices).sort().map(function (mac) {
        const info = devices[mac];
        const retained = seen[mac] || {};
        const counts = {};
        info.leafs.forEach(function (l) { counts[l.type] = l.count; });
        Object.keys(retained).forEach(function (type) {
            if (!counts.hasOwnProperty(type)) {
                counts[type] = Math.max.apply(null, Object.values(retained[type]));
            }
        });
        const leafs = [];
        Object.keys(counts).map(Number).sort(function (a, b) { return a - b; }).forEach(function (type) {
            const attrs = retained[type] ? Object.keys(retained[type]).map(Number) : [0];
            attrs.forEach(function (attribute) {
                leafs.push({type: type, attribute: attribute, count: counts[type], names: info.channels[type] || {}});
            });
        });
        return {mac: mac, name: info.name, leafs: leafs};
    }).filter(function (dev) { return dev.leafs.length > 0; });
}
