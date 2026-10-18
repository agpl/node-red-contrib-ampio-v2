// Builders for binary formats used by the Ampio server
'use strict';

// protobuf: length-delimited string / message, varint field (values < 2^14)
function pbLen(field, buf) {
    return Buffer.concat([Buffer.from([field << 3 | 2, buf.length]), buf]);
}
function pbStr(field, str) {
    return pbLen(field, Buffer.from(str));
}
function pbMsg(field, buf) {
    return pbLen(field, buf);
}
function pbVarint(field, value) {
    const bytes = value < 128 ? [value] : [(value & 0x7f) | 0x80, value >> 7];
    return Buffer.from([field << 3].concat(bytes));
}

// device_api descriptions record: [len u16][code u16][index u16][4 bytes][utf-8 name]
function descriptionRecord(code, index, name) {
    const n = Buffer.from(name);
    const b = Buffer.alloc(10 + n.length);
    b.writeUInt16LE(b.length, 0);
    b.writeUInt16LE(code, 2);
    b.writeUInt16LE(index, 4);
    n.copy(b, 10);
    return b;
}

module.exports = { pbStr, pbMsg, pbVarint, descriptionRecord };
