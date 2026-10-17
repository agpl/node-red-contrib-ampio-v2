module.exports = function(RED) {
    const au = require('../generic/ampio-utils');

    function ampioin(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.mac = config.mac;
        node.valtype = config.valtype || '';
        node.devtype = Number(config.devtype);
        node.attribute = Number(config.attribute) || 0;
        node.index = Number(config.index) || 0;
        node.retainignore = config.retainignore;
        node.brokerConn = RED.nodes.getNode(config.server);

        if (!node.brokerConn) {
            node.error("Ampio server configuration missing");
            return;
        }

        // valtype set = older CAN device on the legacy ampio/ API
        const legacy = node.valtype !== '';
        node.SubPath = legacy
            ? au.legacy_state_topic(node.mac, node.valtype, node.index)
            : au.build_topic('state', node.mac, node.devtype, node.attribute, node.index);
        const decode = legacy ? au.decode_legacy_value : au.decode_value;
        const target = legacy
            ? {mac: node.mac, valtype: node.valtype, index: node.index}
            : {mac: node.mac, devtype: node.devtype, attribute: node.attribute, index: node.index};

        node.status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
        node.brokerConn.register(node);
        node.brokerConn.subscribe(node.SubPath, function(topic, payload, packet) {
            if (payload.length === 0 || (node.retainignore && packet.retain)) {
                return;
            }
            let value;
            try {
                value = decode(payload);
            } catch (err) {
                node.warn("Invalid payload on " + topic + ": " + err.message);
                return;
            }
            node.send(Object.assign({topic: topic, payload: value}, target));
        }, node.id);
        if (node.brokerConn.connected) {
            node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
        }

        node.on('close', function(removed, done) {
            node.brokerConn.unsubscribe(node.SubPath, node.id, removed);
            node.brokerConn.deregister(node, done);
        });
    }
    RED.nodes.registerType("Ampio v2 IN", ampioin);
};
