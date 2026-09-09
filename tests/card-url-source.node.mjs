import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_CARD_BYTES,
    normalizeCardUrl,
    validateCardPng,
} from '../card-source.js';

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    return value >>> 0;
});

function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) {
        value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, content) {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : Uint8Array.from(content);
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    const typeBytes = new TextEncoder().encode(type);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    const crcInput = Uint8Array.from([...typeBytes, ...data]);
    view.setUint32(8 + data.length, crc32(crcInput));
    return chunk;
}

function cardPng(metadata, keyword = 'chara') {
    const text = `${keyword}\0${Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64')}`;
    const ihdr = new Uint8Array(13);
    const iend = pngChunk('IEND', []);
    const textChunk = pngChunk('tEXt', text);
    const output = new Uint8Array(PNG_SIGNATURE.length + 12 + ihdr.length + textChunk.length + iend.length);
    let offset = 0;
    output.set(PNG_SIGNATURE, offset);
    offset += PNG_SIGNATURE.length;
    output.set(pngChunk('IHDR', ihdr), offset);
    offset += 12 + ihdr.length;
    output.set(textChunk, offset);
    offset += textChunk.length;
    output.set(iend, offset);
    return output;
}

test('normalizes Discord media URLs without losing attachment signatures', () => {
    const result = normalizeCardUrl('https://media.discordapp.net/attachments/1/2/card.png?format=webp&quality=lossless&width=512&height=512&fit=cover&ex=abc&is=def&hm=ghi&foo=bar');

    assert.equal(result.url, 'https://cdn.discordapp.com/attachments/1/2/card.png?ex=abc&is=def&hm=ghi&foo=bar');
    assert.equal(result.filename, 'card.png');
    assert.equal(result.isDiscord, true);
    assert.equal(result.normalized, true);
});

test('also strips Discord CDN transform parameters while preserving raw unknown query values', () => {
    const source = 'https://cdn.discordapp.com/attachments/1/2/'
        + `${'a'.repeat(220)}.png?format=webp&ex=abc%2Fdef&is=ghi&hm=jkl&unknown=a+b&other=%2f`;
    const result = normalizeCardUrl(source);

    assert.equal(result.url, 'https://cdn.discordapp.com/attachments/1/2/'
        + `${'a'.repeat(220)}.png?ex=abc%2Fdef&is=ghi&hm=jkl&unknown=a+b&other=%2f`);
    assert.equal(result.url.endsWith('.png?ex=abc%2Fdef&is=ghi&hm=jkl&unknown=a+b&other=%2f'), true);
    assert.equal(result.filename.endsWith('.png'), true);
    assert.ok(result.filename.length <= 180);
    assert.equal(result.normalized, true);
});

test('removes transform parameters after Discord adds an empty query item', () => {
    const result = normalizeCardUrl('https://media.discordapp.net/attachments/1375164604052803675/1388047353549684906/3.0.png'
        + '?ex=6aa1a915&is=6aa05795&hm=756789de2c0fe5f9f7361b1de92341715fe4585bb32e8bd93a71727dc611aefb'
        + '&=&format=webp&quality=lossless');

    assert.equal(result.url, 'https://cdn.discordapp.com/attachments/1375164604052803675/1388047353549684906/3.0.png'
        + '?ex=6aa1a915&is=6aa05795&hm=756789de2c0fe5f9f7361b1de92341715fe4585bb32e8bd93a71727dc611aefb');
    assert.equal(result.normalized, true);
});

test('keeps non-Discord PNG query parameters unchanged', () => {
    const source = 'https://cards.example.test/path/My%20Card.png?format=webp&quality=lossless&x=a+b&sig=%2F';
    const result = normalizeCardUrl(source);

    assert.equal(result.url, source);
    assert.equal(result.filename, 'My Card.png');
    assert.equal(result.isDiscord, false);
    assert.equal(result.normalized, false);
});

test('rejects Discord message links and non-PNG attachment names', () => {
    assert.throws(
        () => normalizeCardUrl('https://discord.com/channels/1/2/3'),
        /原始链接/,
    );
    assert.throws(
        () => normalizeCardUrl('https://cdn.discordapp.com/attachments/1/2/card.webp?ex=abc'),
        /PNG/,
    );
});

test('rejects credentials and local/private hosts', () => {
    assert.throws(() => normalizeCardUrl('https://user:pass@example.com/card.png'), /用户名或密码/);
    assert.throws(() => normalizeCardUrl('https://localhost/card.png'), /本机或内网/);
    assert.throws(() => normalizeCardUrl('https://127.0.0.1/card.png'), /本机或内网/);
    assert.throws(() => normalizeCardUrl('https://[::1]/card.png'), /本机或内网/);
});

test('reads v3 metadata in preference to a v2 chara chunk', () => {
    const bytes = (() => {
        const ihdr = pngChunk('IHDR', new Uint8Array(13));
        const chara = pngChunk('tEXt', `chara\0${Buffer.from(JSON.stringify({ name: 'V2' }), 'utf8').toString('base64')}`);
        const ccv3 = pngChunk('tEXt', `ccv3\0${Buffer.from(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'V3' } }), 'utf8').toString('base64')}`);
        const iend = pngChunk('IEND', []);
        return Uint8Array.from([...PNG_SIGNATURE, ...ihdr, ...chara, ...ccv3, ...iend]);
    })();

    assert.deepEqual(validateCardPng(bytes), { name: 'V3', spec: 'chara_card_v3' });
});

test('rejects ordinary images, WebP, truncated PNGs, and cards without a name', () => {
    assert.throws(() => validateCardPng(new Uint8Array([0x52, 0x49, 0x46, 0x46])), /PNG/);
    assert.throws(() => validateCardPng(PNG_SIGNATURE), /IEND/);
    assert.throws(() => validateCardPng(cardPng({ name: '' })), /非空/);
    assert.throws(() => validateCardPng(cardPng({ description: 'no name' })), /非空/);
});

test('enforces the maximum card size before parsing', () => {
    assert.throws(() => validateCardPng(new Uint8Array(MAX_CARD_BYTES + 1)), /32 MB/);
});
