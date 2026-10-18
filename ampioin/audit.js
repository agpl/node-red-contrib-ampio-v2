module.exports = function(RED) {
    const au = require('../generic/ampio-utils');
    const leafdefs = require('./db/leafdefs.json');
    const legacydefs = require('./db/legacytypes.json');

    const STATE_TOPICS = 'device/v1/state/leaf/#';
    const LEGACY_STATE_TOPICS = 'ampio/from/+/state/#';
    const REFRESH_TIME = 15 * 60 * 1000;
    const RETRY_TIME = 30 * 1000;

    function ampioaudit(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // auto = device/v1 + legacy values not published on device/v1 by the same module
        node.source = config.source || 'auto';
        node.onlychanges = config.onlychanges !== false;
        node.retained = config.retained === true;
        node.brokerConn = RED.nodes.getNode(config.server);

        if (!node.brokerConn) {
            node.error("Ampio server configuration missing");
            return;
        }

        let devices = {};
        let subscribed = false;
        let timer = null;
        let closed = false;
        const last = {};

        function statusText() {
            return Object.keys(devices).length + " devices";
        }

        function wanted(topic) {
            if (topic.startsWith('device/')) {
                return node.source !== 'legacy';
            }
            if (node.source === 'v1') {
                return false;
            }
            if (node.source === 'auto') {
                return !au.legacy_on_v1(devices[topic.split('/')[2].toLowerCase()], topic.split('/')[4]);
            }
            return true;
        }

        function onMessage(topic, payload, packet) {
            if (payload.length === 0 || !wanted(topic)) {
                return;
            }
            let value;
            try {
                value = topic.startsWith('device/') ? au.decode_value(payload) : au.decode_legacy_value(payload);
            } catch (err) {
                node.warn("Invalid payload on " + topic + ": " + err.message);
                return;
            }
            const key = JSON.stringify(value);
            const changed = last[topic] !== key;
            last[topic] = key;
            // retained = last known state sent on (re)subscribe, it only sets the starting value unless asked for
            if ((packet.retain && !node.retained) || (node.onlychanges && !changed)) {
                return;
            }
            const change = au.describe_change(topic, value, devices, leafdefs, legacydefs);
            if (change) {
                node.send({topic: topic, payload: change});
            }
        }

        function subscribe() {
            if (subscribed || closed) {
                return;
            }
            subscribed = true;
            if (node.source !== 'legacy') {
                node.brokerConn.subscribe(STATE_TOPICS, onMessage, node.id);
            }
            if (node.source !== 'v1') {
                node.brokerConn.subscribe(LEGACY_STATE_TOPICS, onMessage, node.id);
            }
        }

        // names come from discovery; subscribe after the first attempt so the first changes already have them
        function discover() {
            if (closed) {
                return;
            }
            node.status({fill:"yellow",shape:"ring",text:"discovering devices"});
            node.brokerConn.discoverDevices(function(err, list) {
                if (closed) {
                    return;
                }
                if (err) {
                    node.warn("Device discovery failed, values are reported without names: " + err.message);
                    node.status({fill:"yellow",shape:"dot",text:"listening, no device names"});
                    timer = setTimeout(discover, RETRY_TIME);
                } else {
                    const map = {};
                    list.forEach(function(dev) { map[dev.mac] = dev; });
                    devices = map;
                    node.status({fill:"green",shape:"dot",text:"listening, " + statusText()});
                    timer = setTimeout(discover, REFRESH_TIME);
                }
                subscribe();
            });
        }

        node.brokerConn.register(node);
        discover();

        node.on('close', function(removed, done) {
            closed = true;
            clearTimeout(timer);
            node.brokerConn.unsubscribe(STATE_TOPICS, node.id, removed);
            node.brokerConn.unsubscribe(LEGACY_STATE_TOPICS, node.id, removed);
            node.brokerConn.deregister(node, done);
        });
    }
    RED.nodes.registerType("Ampio v2 Audit", ampioaudit);
};
