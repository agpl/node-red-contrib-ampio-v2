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

// Response of device_api/to/list -> {mac: name}, mac being lowercase hex of macProd as used in topics
exports.device_names = function (data) {
    const names = {};
    (data.devices || []).forEach(function (dev) {
        names[dev.macProd.toString(16)] = Buffer.from(dev.name || '', 'base64').toString('utf-8');
    });
    return names;
}

// Retained state topics -> [{mac, name, leafs: [{type, attribute, count}]}]
exports.discover_devices = function (topics, names) {
    const devices = {};
    topics.forEach(function (topic) {
        const p = topic.split('/');
        if (p.length !== 8) {
            return;
        }
        const leafs = devices[p[4]] = devices[p[4]] || {};
        const key = p[5] + '/' + p[6];
        leafs[key] = Math.max(leafs[key] || 0, Number(p[7]) + 1);
    });
    return Object.keys(devices).sort().map(function (mac) {
        return {
            mac: mac,
            name: names[mac] || '',
            leafs: Object.keys(devices[mac]).map(function (key) {
                const ta = key.split('/').map(Number);
                return {type: ta[0], attribute: ta[1], count: devices[mac][key]};
            })
        };
    });
}
