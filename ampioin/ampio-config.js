module.exports = function(RED) {
    "use strict";
    
    const mqtt = require('mqtt');
    const net = require("net");
    const au = require('../generic/ampio-utils');

    function unixSocketConnectionBuilder(client, opts) {
        return net.createConnection(opts.pathname);
    }

    let node_global={};
    function ampiov2config(config){
    
        RED.nodes.createNode(this,config);
        let node;
        

        function matchTopic(ts,t) {
            if (ts == "#") {
                return true;
            }
            var re = new RegExp("^"+ts.replace(/([\[\]\?\(\)\\\\$\^\*\.|])/g,"\\$1").replace(/\+/g,"[^/]+").replace(/\/#$/,"(\/.*)?")+"$");
            return re.test(t);
        }

        //pass options from Node-RED
        this.server = config.server;
        this.port = config.port;

        //conf state
        this.connected = false;
        this.connecting = false;
        this.closing = false;
        this.subscriptions = {};
        this.queue = [];
        this.options = {};
        this.users = {};
        var node_id=this.id

        //node.tls = config.tls; //in future

        //credentials
        if (this.credentials) {
            
            this.username = this.credentials.user;
            this.password = this.credentials.password;
            console.log(this.id);
        }

        if (typeof this.usetls === 'undefined') {
            this.usetls = false;
        }

        node = this;
        node_global[this.id]=this;

        //MQTT client params & options
        if(!node.port || node.port === ""){
            node.port = '1883';
        }
        if (!node.server || node.server === "") {
            node.brokerurl = "mqtt+unix:///var/run/ampio/mqtt.sock";
            node.options.pathname = "/var/run/ampio/mqtt.sock";
        } else {
            node.brokerurl = "mqtt://" + node.server + ":" + node.port;
        }
        console.log(node.brokerurl)
        this.options.clientId = 'AmpioNodeV2_' + (1+Math.random()*4294967295).toString(16);
        node.options.clean = true;
        node.options.username = node.username;
        node.options.password = node.password;
        node.options.reconnectPeriod = 5000;



        //register and deregister slave nodes to control states etc.
        node.register = function(mqttNode) {
            node.users[mqttNode.id] = mqttNode;
            if(Object.keys(node.users).length === 1){
                node.connect();
            }
        }

        node.deregister = function(mqttNode,done) {
            delete node.users[mqttNode.id];
            if (node.closing){
                node.client.end();
                return done();
            }
            if (Object.keys(node.users).length === 0) {
                if (node.client && node.client.connected){
                    //console.log("0 clients");
                    node.client.end();
                    return done();
                }
                else{
                    node.client.end();
                    return done();
                }
            }
            done();
        }


        node.createClient = function(options){
            if (!node.server || node.server === "") {
                return new mqtt.MqttClient(function (client) {
                    return unixSocketConnectionBuilder(client, client.options);
                }, options);
            }
            return mqtt.connect(node.brokerurl, options);
        };

        node.connect = function(){ //mqtt connection part
            if(!node.connected && !node.connecting){
                node.connecting = true;
                try{
                    //node.client = null;
                    node.client = node.createClient(node.options);
                    node.client.setMaxListeners(0);

                    //handle connect event, update node statuses
                    node.client.on('connect', function(){
                        node.connecting = false;
                        node.connected = true;
                        node.log("Ampio v2 Node instance connected to MQTT on: " + node.brokerurl + " with client id: " + node.options.clientId);

                        for(var id in node.users) {
                            if (node.users.hasOwnProperty(id)) {
                                node.users[id].status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
                            }
                        }

                        node.client.removeAllListeners('message');

                        for(var s in node.subscriptions){
                            if(node.subscriptions.hasOwnProperty(s)){
                                var topic = s;
                                for (var r in node.subscriptions[s]){
                                    if (node.subscriptions[s].hasOwnProperty(r)){
                                        node.client.on('message',node.subscriptions[s][r].handler);
                                    }
                                }
                                var options = {qos: 0};
                                node.client.subscribe(topic, options);
                                //console.log("zasubskrybowano " + topic);
                            }
                        }
                    })

                    //handle reconnect event, set node statuses
                    node.client.on("reconnect", function() {
                        console.log('RECONNECT')
                        for (var id in node.users) {
                            if (node.users.hasOwnProperty(id)) {
                                node.users[id].status({fill:"yellow",shape:"ring",text:"node-red:common.status.connecting"});
                            }
                        }
                    })

                    //handle closing event, change node statuses
                    node.client.on('close', function (){
                        if(node.connected){
                            node.connected = false;
                            node.log("! Ampio v2 Node instance disconnected from MQTT on: " + node.brokerurl + " with client id: " + node.options.clientId);
                            //console.trace();
                            for (var id in node.users) {
                                if (node.users.hasOwnProperty(id)) {
                                    node.users[id].status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
                                }
                            }
                        }
                        else if(node.connecting){
                            node.log("! FAILED Ampio Node MQTT connection to: " + node.brokerurl + " with client id: " + node.options.clientId);
                        }
                    });
                    
                    //error, no need to handle it here
                    node.client.on('error', function(error){
                        console.log(error);
                    });
                }
                catch(err){
                    console.log(err);
                }
            }
        };

        node.subscribe = function(topic, callback, ref){
            ref=ref || 0;
            console.log("Topic: " + topic);
            node.subscriptions[topic] = node.subscriptions[topic]||{};
            var sub = {
                topic:topic,
                handler:function(mtopic,mpayload, mpacket){
                    if (matchTopic(topic,mtopic)){
                        callback(mtopic, mpayload, mpacket);
                    }
                },
                ref: ref
            };

            node.subscriptions[topic][ref] = sub;
            if (node.connected){
                node.client.on('message',sub.handler);
                var options = {};
                node.client.subscribe(topic, options);
            }
        }

        node.unsubscribe = function (topic, ref, removed) {
            ref = ref||0;
            var sub = node.subscriptions[topic];
            if (sub) {
                if (sub[ref]) {
                    node.client.removeListener('message',sub[ref].handler);
                    delete sub[ref];
                }
                if (removed) {
                    if (Object.keys(sub).length === 0) {
                        delete node.subscriptions[topic];
                        if (node.connected) {
                            node.client.unsubscribe(topic);
                        }
                    }
                }
            }
        }

        node.publish = function (msg,done) {
            if (node.connected) {
                console.log(msg.topic + " " + msg.payload)
                if (msg.payload === null || msg.payload === undefined) {
                    msg.payload = "";
                } else if (!Buffer.isBuffer(msg.payload)) {
                    if (typeof msg.payload === "number") {
                        msg.payload = msg.payload.toString();
                    } else if (typeof msg.payload !== "string") {
                        msg.payload = "" + msg.payload;
                    }
                }

                var options = {
                };
                node.client.publish(msg.topic, msg.payload, options, function(err) {
                    done && done(err);
                    return
                });
            } else {
                done && done(new Error("Ampio MQTT broker not connected"));
            }
        };

        


        
        //DEVICES LIST (legacy ampio/ API, used only by the LCD node)
        RED.httpAdmin.get('/ampio-v2/'+node_id+'/devices/list', RED.auth.needsPermission('ampiov2.read'),function(req,res){
            console.log('/ampio-v2/'+node_id+'/devices/list');
            
            node=node_global[node_id];
            function OnSubscribe(){
                return new Promise((resolve,reject) => {
                    try{
                        node.client.subscribe('ampio/from/can/dev/list', function (err) { //topic to subscribe
                            if (!err) {
                                node.client.publish('ampio/to/can/dev/list','');
                                resolve(true); 
                            }
                            console.log(err);
                        });
                    }
                    catch(error){
                        console.error(error);
                    }
                    setTimeout(function() {
                        resolve('timeout');
                    }, 2000);
                });
            }
            function GetMessage(){
                return new Promise((resolve,reject) => {
                    node.client.on('message', function (topic, message) {
                        if(topic === 'ampio/from/can/dev/list'){
                            node.client.unsubscribe('ampio/from/can/dev/list');
                            let devices = JSON.parse(message);
                            resolve(devices.devices);
                        }
                    });
                    setTimeout(function() {
                        resolve('timeout');
                    }, 2000);
                });
            }
            
            if(node.connected){
                Promise.all([
                    OnSubscribe(),
                    GetMessage()
                ])
                .then(resp => {
                    if(resp[1]==='timeout'){
                        res.status(504);
                        res.json("508 server timeout");
                        node.client.unsubscribe('ampio/from/can/dev/list');
                    }
                    else{
                        res.json(resp[1]);
                    }
                });
            }
            
        });

        
        
        //DEVICES DISCOVERY
        //  get_devices over rpc/v2: types, channel counts, names of device/v1 devices
        //  retained device/v1 states: attributes; retained legacy ampio/from states: legacy value types
        //  device_api list: names of legacy channels (optional)
        const STATE_TOPICS = 'device/v1/state/leaf/#';
        const LEGACY_STATE_TOPICS = 'ampio/from/+/state/#';
        const DEVICE_LIST_REQUEST = 'device_api/to/list';
        const DEVICE_LIST_RESPONSE = 'device_api/from/list';
        const DISCOVERY_TIME = 2000;
        // done(err, devices); err.status carries an HTTP status for the editor endpoint
        node.discoverDevices = function(done){
            // Separate client, so retained states re-sent on subscribe do not reach IN nodes
            const client = node.createClient(Object.assign({}, node.options, {
                clientId: node.options.clientId + '_discovery',
                reconnectPeriod: 0,
                connectTimeout: DISCOVERY_TIME
            }));
            // ampio-mqtt replies to ids above int32 range on .../2147483647, keep it below
            const rpcId = 1 + Math.floor(Math.random() * 2147483646);
            const rpcRequest = 'rpc/v2/request/ampio-mqtt/' + rpcId;
            const rpcResponse = 'rpc/v2/response/ampio-mqtt/' + rpcId;
            const topics = [];
            const legacyTopics = [];
            let rpcDevices = null;
            let apiDevices = null;
            let apiWaitOver = false;
            let collecting = true;
            let finished = false;
            function finish(status, body){
                if(finished){
                    return;
                }
                finished = true;
                clearTimeout(timer);
                client.end(true);
                if(status === 200){
                    done(null, body);
                } else {
                    const err = new Error(body);
                    err.status = status;
                    done(err);
                }
            }
            function tryFinish(){
                if(rpcDevices && (apiDevices || apiWaitOver) && !collecting){
                    finish(200, au.discover_devices(rpcDevices, topics, legacyTopics, apiDevices));
                }
            }
            function parse(message, what){
                try{
                    return JSON.parse(message);
                }
                catch(err){
                    node.warn("Invalid " + what + " response: " + err.message);
                    return {};
                }
            }
            client.on('message', function(topic, message){
                if(topic === rpcResponse){
                    const data = parse(message, 'get_devices');
                    if(data.id !== undefined && data.id !== rpcId){
                        return;
                    }
                    rpcDevices = (data.result && data.result.devices) || [];
                    tryFinish();
                }
                else if(topic === DEVICE_LIST_RESPONSE){
                    apiDevices = parse(message, 'device_api list').devices || [];
                    tryFinish();
                }
                else if(message.length > 0){
                    (topic.startsWith('ampio/') ? legacyTopics : topics).push(topic);
                }
            });
            client.on('error', function(err){
                finish(502, "MQTT error: " + err.message);
            });
            client.on('connect', function(){
                client.subscribe([rpcResponse, DEVICE_LIST_RESPONSE, STATE_TOPICS, LEGACY_STATE_TOPICS], function(err){
                    if(err){
                        finish(500, "Subscribe failed: " + err.message);
                        return;
                    }
                    // retained states arrive right after subscribe, give them a moment
                    setTimeout(function(){
                        collecting = false;
                        tryFinish();
                    }, 500);
                    // legacy names are optional, do not wait for them longer than DISCOVERY_TIME
                    setTimeout(function(){
                        apiWaitOver = true;
                        tryFinish();
                    }, DISCOVERY_TIME);
                    client.publish(rpcRequest, JSON.stringify({jsonrpc: "2.0", method: "get_devices", params: {}, id: rpcId}));
                    client.publish(DEVICE_LIST_REQUEST, '');
                });
            });
            const timer = setTimeout(function(){
                if(!client.connected){
                    finish(504, "MQTT broker not reachable");
                    return;
                }
                // no get_devices answer, fall back to retained states only
                node.warn("get_devices timeout, devices discovered without names");
                finish(200, au.discover_devices([], topics, legacyTopics, apiDevices));
            }, DISCOVERY_TIME * 2);
        };

        RED.httpAdmin.get('/ampio-v2/'+node_id+'/devices/v1/list', RED.auth.needsPermission('ampiov2.read'),function(req,res){
            node.discoverDevices(function(err, devices){
                if(err){
                    res.status(err.status || 500).json(err.message);
                    return;
                }
                res.json(devices);
            });
        });

        RED.httpAdmin.get('/ampio-v2/'+node_id+'/legacydefs', RED.auth.needsPermission('ampiov2.read'),function(req,res){
            res.json(require('./db/legacytypes.json'));
        });

        // leaf types and attributes, generated from Ampio Designer by tools/extract-designer-defs.js
        RED.httpAdmin.get('/ampio-v2/'+node_id+'/leafdefs', RED.auth.needsPermission('ampiov2.read'),function(req,res){
            res.json(require('./db/leafdefs.json'));
        });

        RED.httpAdmin.get('/ampio-v2/'+node_id+'/devices/types', RED.auth.needsPermission('ampiov2.read'),function(req,res){
            let DevTypes = require('./db/devtypes.json');
            res.json(DevTypes);
        });


        this.on('close', function(done) {
            this.closing = true;
            if (this.connected) {
                node.client.once('close', function() {
                    //node.client = null;
                    done();
                });
                node.client.end();
            } else if (this.connecting || node.client.reconnecting) {
                node.client.end();
                done();
            } else {
                node.client.end();
                done();
            }
        });
    }

    

    RED.nodes.registerType("ampiov2config",ampiov2config,{
        credentials: {
            user: {type:"text"},
            password: {type: "password"}
        }
        //in future there will be ampio cloud access tokens, as soon as new cloud will be released in prod env
    });

    
}
