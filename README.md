## Ampio Node-RED module (v2)
Ampio add-on made to use Ampio Smart Home devices in Node-RED, using the `device/v1` MQTT API.

Published as `node-red-contrib-ampio-v2`. It can be installed alongside the original `node-red-contrib-ampio`: all node types (`Ampio v2 IN`, `Ampio v2 OUT`, `Ampio v2 LCD`, `Ampio v2 Events`, `ampiov2config`), the palette category (`Ampio v2`) and editor endpoints (`/ampio-v2/...`) have their own names, so existing v1 flows keep working.

## Pre-requisites
You need Ampio Smart Home system, because this module is meant only to integrate it with another node-red plugins.
You also need M-SERV-s with latest firmware, or Ampio Smart Home server installed in docker and connected through special serial-CAN adapter with Docker host device.

## Install
This node should be pre-installed on your M-SERV-s. In case of having software in Docker, use MENU -> Manage Palette -> Install and type ampio-v2. Another way is to use Terminal, and installing this add-on in your ~/.node-red directory.]

## Using this add-on
After having this module installed, you will see helpful instructions in Help sections.
Basically, after installing you will have 4 add-ons:
- Ampio v2 IN, node meant to receive informations from modules, such like: states of inputs, outputs, flags, temperatures from sensors, states of analog inputs/outputs, and 8,16,32-bit measurements. Values will be delivered immediately, after they will change, they are not sent periodically.
- Ampio v2 OUT, meant to control outputs and flagfs ion Ampio system. You can also change temperature controller desired temperatures.
- Ampio v2 LCD, a complete tool to display text and shapes on LCD screen on MDOT touch panels.
- Ampio v2 Events, to send and/or receive events from your CAN Network.

## Leaf definitions
`ampioin/db/leafdefs.json` lists every leaf type with its attributes (read/write access, value kind, range, unit, enum values, labels). It is generated from the Ampio Designer bundle served by the server:

```
curl -o /tmp/App.js http://<server>/assets/App-<hash>.js   # name of the main script from Designer page source
node tools/extract-designer-defs.js /tmp/App.js > ampioin/db/leafdefs.json
```

The script only evaluates plain object literals cut from the bundle, in an empty sandbox.

## Tests
`npm test` runs the IN/OUT/config nodes against an in-process MQTT broker.

## Changelog
Disclaimer: every version lower than 1.0.0 is considered as beta. I do all my best to make every release as stable as possible, but due to fast development of protocol, API changes may occur. 1.0.0 is planned after transition to /b/ MQTT broadcasts, which requires many changes.

### 0.7.x
0.7.0 - Package renamed to `node-red-contrib-ampio-v2` with own node type names, so it does not collide with v1. **Breaking:** Ampio IN/OUT moved to the new MQTT API. State is read from `device/v1/state/leaf/<MAC>/<type>/<attribute>/<index>` and commands are sent to `device/v1/set/leaf/<MAC>/<type>/<attribute>/<index>`, with JSON payload `{"v": value}` (value can be an object, ex. RGBW `{h,s,v}`). Devices, types, channel counts, device names and channel descriptions are discovered with `get_devices` over `rpc/v2/request/ampio-mqtt/<id>` (same source as Ampio Designer); attributes come from retained states. IN/OUT editors list all readable/writable attributes of every type (generated from Ampio Designer definitions) with the expected value. OUT sends `true`/`false` as `1`/`0` and passes optional `msg.time`. Older CAN devices which are not available on `device/v1` (M-SENS, M-REL-10s, M-DIM-2s, ...) are listed as legacy and used through the legacy `ampio/from|to/<MAC>/...` topics; legacy value types (flags, inputs, outputs, temperatures, sensors, zones, ...) are also offered for every device in a separate *Legacy* group, with channel names from `device_api/to/list`. Raw CAN commands, I/O descriptions and old value types were removed. **Existing IN/OUT nodes must be reconfigured (device, type, attribute, index).**<br>

### 0.6.x
0.6.8 - support for CO2 in M-SENS<br>
0.6.7 - support for new touch panels<br>
0.6.6 - support for new devices<br>
0.6.5 - add support for new devices<br>
0.6.4 - "Legacy mode..." bug fix<br>
0.6.3 - device list bug fix<br>
0.6.2 - no changes<br>
0.6.1 - no changes<br>
0.6.0 - local unix-socket based connection option added

### 0.5.x
0.5.1 - Update devtypes.json
0.5.0 - add support for M-DOT-M18

### 0.4.x
0.4.5 - fixed LCD node.<br>
0.4.4 - fixed an issue, when user opened node parameters, deviced list was being generated 3 times, which sometimes resulted in tripled outputs list. Removed faulty "update MQTT" warnings.<br>
0.4.3 - fixed lack of support of linear flags in devices with protocol >= 22. <br>
0.4.2 - bugfix - unknown device type was crashing device list. Now this bug is handled. <br>
0.4.1 - bugfix, outputs were not visible for MIN-11p <br>
0.4.0 - general update, modified backend to create only one, shared client for every MQTT broker, added config node, which gives possibility to store configurations of many brokers, updated list of device types. **Manual configuration update is required after update - you will need to go add broker configuration and select it in ever Ampio Node.** <br>


### 0.3.x
0.3.0 - Added functionality of loading input/output descriptions from modules.**Requires MQTT bridge in version 3.14 or later to support this functionality**; corrected encoding in module names<br>

### 0.2.x
0.2.5 - corrected big font bug<br>
0.2.4 - corrected bug with flags<br>
0.2.3 - corrected bug - outputs not working<br>
0.2.2 - corrected the bug - MRT heating/cooling functions were not working, now it's OK; added IR codes sending from MSENS module; updated help files with latest functionalities<br>
0.2.1 - added au8, au16, au32 values for MCON devices. Moved values descriptions to external database. Modified and updated help files. Created readme file and updated package.json to fit node-red requirements.<br>
0.2.0 - general update, adding auto discovery for modules and auto-discovery for functions of modules
