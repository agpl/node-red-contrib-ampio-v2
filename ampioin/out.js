module.exports = function(RED) {
    const au = require('../generic/ampio-utils');

    function ampioout(config) {
        RED.nodes.createNode(this,config);
        const node = this;

        node.mac = config.mac;
        node.devtype = config.devtype;
        node.attribute = config.attribute;
        node.index = config.index;
        node.brokerConn = RED.nodes.getNode(config.server);

        if (!node.brokerConn) {
            node.error("Ampio server configuration missing");
            return;
        }

        node.on("input", function(msg, send, done) {
            const mac = msg.hasOwnProperty('mac') ? String(msg.mac) : node.mac;
            const devtype = Number(msg.hasOwnProperty('devtype') ? msg.devtype : node.devtype);
            const attribute = Number(msg.hasOwnProperty('attribute') ? msg.attribute : (node.attribute || 0));
            const index = Number(msg.hasOwnProperty('index') ? msg.index : (node.index || 0));

            if (!mac || !Number.isInteger(devtype) || !Number.isInteger(attribute) || !Number.isInteger(index)) {
                done(new Error("Invalid target: mac=" + mac + " devtype=" + devtype + " attribute=" + attribute + " index=" + index));
                return;
            }

            node.brokerConn.publish({
                topic: au.build_topic('set', mac, devtype, attribute, index),
                payload: au.encode_value(msg.payload, msg.time)
            }, function(err) {
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
