module.exports = function(RED) {
    const au = require('../generic/ampio-utils');

    function ampioout(config) {
        RED.nodes.createNode(this,config);
        const node = this;

        node.mac = config.mac;
        node.valtype = config.valtype || '';
        node.devtype = config.devtype;
        node.attribute = config.attribute;
        node.index = config.index;
        node.brokerConn = RED.nodes.getNode(config.server);

        if (!node.brokerConn) {
            node.error("Ampio server configuration missing");
            return;
        }

        // msg.valtype selects the legacy ampio/ API ("raw" = raw CAN frame), msg.devtype device/v1,
        // otherwise node configuration decides
        function target(msg) {
            const mac = msg.hasOwnProperty('mac') ? String(msg.mac) : node.mac;
            const index = Number(msg.hasOwnProperty('index') ? msg.index : (node.index || 0));
            const valtype = msg.hasOwnProperty('valtype') ? String(msg.valtype) : (msg.hasOwnProperty('devtype') ? '' : node.valtype);
            if (!mac || !Number.isInteger(index)) {
                throw new Error("Invalid target: mac=" + mac + " index=" + index);
            }
            if (valtype === 'raw') {
                return {topic: au.raw_topic(mac), payload: au.encode_raw(msg.payload)};
            }
            if (valtype !== '') {
                return {topic: au.legacy_set_topic(mac, valtype, index), payload: au.encode_legacy_value(msg.payload)};
            }
            const devtype = Number(msg.hasOwnProperty('devtype') ? msg.devtype : node.devtype);
            const attribute = Number(msg.hasOwnProperty('attribute') ? msg.attribute : (node.attribute || 0));
            if (!Number.isInteger(devtype) || !Number.isInteger(attribute)) {
                throw new Error("Invalid target: mac=" + mac + " devtype=" + devtype + " attribute=" + attribute + " index=" + index);
            }
            return {topic: au.build_topic('set', mac, devtype, attribute, index), payload: au.encode_value(msg.payload, msg.time)};
        }

        node.on("input", function(msg, send, done) {
            let out;
            try {
                out = target(msg);
            } catch (err) {
                done(err);
                return;
            }
            node.brokerConn.publish(out, function(err) {
                done(err);
            });
        });

        node.on('close', function(removed, done) {
            node.brokerConn.deregister(node, done);
        });

        node.brokerConn.register(node);
    }
    RED.nodes.registerType("Ampio v2 OUT",ampioout);
};
