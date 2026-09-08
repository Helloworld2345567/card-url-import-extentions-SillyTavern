import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import test from 'node:test';

import { MAX_CARD_BYTES, normalizeCardUrl, validateCardPng } from '../card-source.js';
import { downloadCard, uploadCard } from '../import-service.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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

function pngChunk(type, data) {
    const content = Buffer.from(data);
    const typeBytes = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBytes, content]);
    const chunk = Buffer.allocUnsafe(12 + content.length);
    chunk.writeUInt32BE(content.length, 0);
    typeBytes.copy(chunk, 4);
    content.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(crcInput), 8 + content.length);
    return chunk;
}

/** Build a small, real PNG with a compressed pixel row and card metadata. */
function cardPng(metadata, keyword = 'chara') {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    const pixels = Buffer.from([0, 255, 255, 255, 255]);
    const text = Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from(Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64'), 'ascii'),
    ]);
    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(pixels)),
        pngChunk('tEXt', text),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

const validPng = cardPng({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: 'Link import test', description: 'Synthetic card' },
});
const source = normalizeCardUrl('https://media.discordapp.net/attachments/1/2/card.png?ex=123&is=456&hm=abc&format=webp');

test('accepts legacy v1 fields in ccv3 chunks created by SillyTavern itself', () => {
    const legacyPng = cardPng({
        spec: 'chara_card_v3',
        spec_version: '3.0',
        name: 'Legacy card',
        description: 'Legacy v1 fields',
    }, 'ccv3');
    assert.deepEqual(validateCardPng(legacyPng), { name: 'Legacy card', spec: 'chara_card_v3' });
});

test('downloads through existing ST API with CSRF, preserving original bytes and signatures', async () => {
    const { bytes, metadata } = await downloadCard(source, {
        headers: { 'X-CSRF-Token': 'test-token' },
        fetchImpl: async (url, options) => {
            assert.equal(url, '/api/content/importURL');
            assert.equal(options.method, 'POST');
            assert.equal(options.headers['X-CSRF-Token'], 'test-token');
            assert.equal(JSON.parse(options.body).url, 'https://cdn.discordapp.com/attachments/1/2/card.png?ex=123&is=456&hm=abc');
            assert.equal(options.redirect, 'error');
            return new Response(validPng, { headers: { 'Content-Type': 'image/png' } });
        },
    });
    assert.deepEqual(Buffer.from(bytes), validPng);
    assert.equal(metadata.name, 'Link import test');
});

test('rejects non-card data even if mislabeled image/png', async () => {
    await assert.rejects(downloadCard(source, {
        headers: {},
        fetchImpl: async () => new Response('RIFFxxxxWEBP', { headers: { 'Content-Type': 'image/png' } }),
    }));
});

test('rejects login pages and gives actionable download errors', async () => {
    for (const [status, pattern] of [[401, /登录/], [403, /登录/], [404, /Discord.*过期/], [500, /HTTP 500/]]) {
        await assert.rejects(downloadCard(source, {
            headers: {}, fetchImpl: async () => new Response('', { status }),
        }), pattern);
    }
    await assert.rejects(downloadCard(source, {
        headers: {}, fetchImpl: async () => new Response('<html>Log in</html>', { headers: { 'Content-Type': 'text/html' } }),
    }), /登录页面/);
});

test('rejects oversized declared and streamed bodies before import', async () => {
    await assert.rejects(downloadCard(source, {
        headers: {}, fetchImpl: async () => new Response('', { headers: { 'Content-Length': String(MAX_CARD_BYTES + 1) } }),
    }), /32 MiB/);
    let cancelled = false;
    let chunks = 0;
    const body = new ReadableStream({
        pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() { cancelled = true; },
    });
    await assert.rejects(downloadCard(source, {
        headers: {}, fetchImpl: async () => new Response(body),
    }), /32 MiB/);
    assert.equal(cancelled, true);
    assert.ok(chunks <= 34);
});

test('uploads exact original PNG through native import API without overwriting', async () => {
    let requests = 0;
    const result = await uploadCard(validPng, 'card.png', {
        headers: { 'X-CSRF-Token': 'test-token' },
        userName: 'Test User',
        fetchImpl: async (url, options) => {
            requests++;
            assert.equal(url, '/api/characters/import');
            assert.equal(options.headers['Content-Type'], undefined);
            assert.equal(options.headers['X-CSRF-Token'], 'test-token');
            assert.equal(options.body.get('file_type'), 'png');
            assert.equal(options.body.get('user_name'), 'Test User');
            assert.equal(options.body.has('preserved_name'), false);
            const file = options.body.get('avatar');
            assert.equal(file.name, 'card.png');
            assert.equal(file.type, 'image/png');
            assert.deepEqual(Buffer.from(await file.arrayBuffer()), validPng);
            return Response.json({ file_name: 'Link import test1' });
        },
    });
    assert.equal(result, 'Link import test1.png');
    assert.equal(requests, 1);
});

test('does not report success or retry after an uncertain or rejected write', async () => {
    for (const response of [Response.json(null), Response.json({ error: true }), Response.json({}), new Response('', { status: 500 }), new Response('<html>login</html>')]) {
        let calls = 0;
        await assert.rejects(uploadCard(validPng, 'card.png', {
            headers: {}, fetchImpl: async () => { calls++; return response; },
        }));
        assert.equal(calls, 1);
    }
    let calls = 0;
    await assert.rejects(uploadCard(validPng, 'card.png', {
        headers: {}, fetchImpl: async () => { calls++; throw new TypeError('Network error'); },
    }), /可能已保存/);
    assert.equal(calls, 1);
});

test('manifest and loader hook match the installed entry point', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
    assert.equal(manifest.js, 'index.js');
    assert.equal(manifest.hooks.activate, 'init');
});
