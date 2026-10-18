module.exports = function(RED) {
    function ampioevents(config) {
        RED.nodes.createNode(this,config);
        var node = this;

        node.ampioserv = config.server;
        node.brokerConn = RED.nodes.getNode(node.ampioserv);
    
        this.on("input", function(msg,send,done) {
            let outmsg={};
            outmsg.payload=msg.payload;
            outmsg.topic = 'ampio/to/event'
            this.brokerConn.publish(outmsg, function(err) {
				done(err);
			});
        });

        this.on('close', function(removed, done) {
            if (node.brokerConn) {
                node.brokerConn.unsubscribe('ampio/from/+/event', node.id, removed);
                node.brokerConn.deregister(node, done);
            } else {
                done();
            }
        });

        node.brokerConn.register(node);

        node.brokerConn.subscribe('ampio/from/+/event',function(topic,payload){
            var msg = {topic:topic, payload:payload.toString('utf-8')};
            msg.eventSender = msg.topic.split('/')[2];
            node.send(msg);
        }, node.id);
        if(node.brokerConn.connected){
            node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
        }

    }
    RED.nodes.registerType("Ampio v2 Events",ampioevents);
};


