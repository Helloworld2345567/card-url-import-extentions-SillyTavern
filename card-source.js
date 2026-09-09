/**
 * Helpers shared by the card URL importer.
 *
 * This module deliberately has no SillyTavern or network dependencies.  It is
 * usable from the browser before the importer starts a request and from the
 * small Node test suite that exercises the same rules.
 */

export const MAX_CARD_BYTES = 32 * 1024 * 1024;

const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DISCORD_IMAGE_QUERY_KEYS = new Set(['format', 'quality', 'width', 'height', 'fit']);
const DISCORD_MESSAGE_ERROR = '这是 Discord 消息链接，请复制图片的原始链接（cdn.discordapp.com/attachments/.../*.png）后再导入。';

const CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    return value >>> 0;
}));

function isHostOrSubdomain(hostname, domain) {
    return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isDiscordMessageHost(hostname) {
    return isHostOrSubdomain(hostname, 'discord.com') || isHostOrSubdomain(hostname, 'discordapp.com');
}

function isDiscordHost(hostname) {
    return isDiscordMessageHost(hostname)
        || isHostOrSubdomain(hostname, 'discordapp.net')
        || isHostOrSubdomain(hostname, 'discord.net');
}

function isIpv4(hostname) {
    return /^\d+(?:\.\d+){0,3}$/.test(hostname);
}

/**
 * URL parsers accept the abbreviated, decimal, hexadecimal and octal forms
 * of IPv4 addresses.  URL.hostname is normally canonicalized for us, but
 * keeping this parser here also makes the check work in less complete browser
 * URL implementations.
 */
function parseIpv4(hostname) {
    if (!isIpv4(hostname)) {
        return null;
    }

    const parts = hostname.split('.');
    const values = [];
    for (const part of parts) {
        if (part === '') {
            return null;
        }

        let radix = 10;
        let digits = part;
        if (/^0x/i.test(digits)) {
            radix = 16;
            digits = digits.slice(2);
        } else if (digits.length > 1 && digits.startsWith('0')) {
            radix = 8;
            digits = digits.slice(1);
        }

        if (!digits || !/^[0-9a-f]+$/i.test(digits)) {
            return null;
        }

        const value = Number.parseInt(digits, radix);
        if (!Number.isSafeInteger(value)) {
            return null;
        }
        values.push(value);
    }

    // The forms accepted by the URL standard are:
    // a.b.c.d, a.b.c (last part is 16-bit), a.b (last part is 24-bit), and a
    // single 32-bit value.
    let value;
    switch (values.length) {
        case 1:
            value = values[0];
            if (value > 0xffffffff) return null;
            break;
        case 2:
            if (values[0] > 0xff || values[1] > 0xffffff) return null;
            value = (values[0] * 0x1000000) + values[1];
            break;
        case 3:
            if (values[0] > 0xff || values[1] > 0xff || values[2] > 0xffff) return null;
            value = (values[0] * 0x1000000) + (values[1] * 0x10000) + values[2];
            break;
        case 4:
            if (values.some(part => part > 0xff)) return null;
            value = (values[0] * 0x1000000) + (values[1] * 0x10000) + (values[2] * 0x100) + values[3];
            break;
        default:
            return null;
    }

    return value >>> 0;
}

function isPrivateIpv4(value) {
    const first = value >>> 24;
    const second = (value >>> 16) & 0xff;

    return first === 0 // unspecified/current network
        || first === 10
        || first === 127
        || (first === 100 && second >= 64 && second <= 127) // shared address space
        || (first === 169 && second === 254) // link local
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 0)
        || (first === 192 && second === 168)
        || (first === 198 && (second === 18 || second === 19)) // benchmark networks
        || first >= 224; // multicast and reserved
}

function parseIpv6(hostname) {
    let value = hostname.toLowerCase();
    if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1);
    }
    if (!value.includes(':')) {
        return null;
    }

    // IPv4-mapped IPv6 addresses contain a dotted final component.
    if (value.includes('.')) {
        const lastColon = value.lastIndexOf(':');
        const ipv4 = parseIpv4(value.slice(lastColon + 1));
        if (ipv4 === null) return null;
        const high = ((ipv4 >>> 16) & 0xffff).toString(16);
        const low = (ipv4 & 0xffff).toString(16);
        value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
    }

    const sides = value.split('::');
    if (sides.length > 2) return null;

    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
    if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/i.test(part))) {
        return null;
    }
    if (sides.length === 1 && left.length !== 8) return null;
    if (sides.length === 2 && left.length + right.length >= 8) return null;

    const words = [
        ...left.map(part => Number.parseInt(part, 16)),
        ...(sides.length === 2 ? Array(8 - left.length - right.length).fill(0) : []),
        ...right.map(part => Number.parseInt(part, 16)),
    ];
    return words.length === 8 ? words : null;
}

function isPrivateIpv6(hostname) {
    const words = parseIpv6(hostname);
    if (!words) return false;

    const first = words[0];
    const isUnspecified = words.every(word => word === 0);
    const isLoopback = words.slice(0, 7).every(word => word === 0) && words[7] === 1;
    const isUniqueLocal = (first & 0xfe00) === 0xfc00;
    const isLinkLocal = (first & 0xffc0) === 0xfe80;
    const isMulticast = (first & 0xff00) === 0xff00;
    const isV4Mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;

    if (isUnspecified || isLoopback || isUniqueLocal || isLinkLocal || isMulticast) {
        return true;
    }
    return isV4Mapped && isPrivateIpv4((words[6] << 16) | words[7]);
}

function rejectPrivateHost(url) {
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
        throw new Error('为安全起见，不允许访问本机或内网地址。');
    }

    const ipv4 = parseIpv4(hostname);
    if (ipv4 !== null && isPrivateIpv4(ipv4)) {
        throw new Error('为安全起见，不允许访问本机或内网地址。');
    }
    if (isPrivateIpv6(hostname)) {
        throw new Error('为安全起见，不允许访问本机或内网地址。');
    }
}

function decodePathSegment(segment) {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function safeFilenameFromPath(pathname) {
    const rawSegment = pathname.split('/').filter(Boolean).at(-1) || 'character-card.png';
    let filename = decodePathSegment(rawSegment).normalize('NFKC');

    // Keep the downloaded file a single safe basename even when a URL contains
    // encoded separators, control characters or Windows reserved characters.
    filename = filename
        .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
        .replace(/[<>:"|?*]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim();

    if (!filename || filename === '.' || filename === '..') {
        return 'character-card.png';
    }

    const stem = filename.split('.')[0].toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
        filename = `_${filename}`;
    }

    const extension = /\.png$/i.test(filename) ? filename.slice(-4) : '';
    if (filename.length > 180) {
        const stemLength = Math.max(1, 180 - extension.length);
        filename = `${filename.slice(0, stemLength)}${extension}`;
    }

    return filename || 'character-card.png';
}

function hasPngExtension(pathname) {
    return /\.png$/i.test(decodePathSegment(pathname));
}

function normalizedDiscordUrl(parsed) {
    const before = parsed.toString();
    parsed.hostname = 'cdn.discordapp.com';

    // Filter the raw query segments instead of round-tripping through
    // URLSearchParams.  Discord's ex/is/hm signatures and unknown parameters
    // can contain meaningful percent-encoding that must survive byte-for-byte.
    const rawQuery = parsed.search.startsWith('?') ? parsed.search.slice(1) : '';
    const keptQuery = rawQuery.split('&').filter(segment => {
        const rawKey = segment.split('=', 1)[0];
        // Discord sometimes appends an empty query item (`&=`) before the
        // image transformation parameters.  It has no meaning and would
        // otherwise survive as a dangling `&=` after the known parameters
        // are removed.
        if (!segment || rawKey === '') {
            return false;
        }
        let key = rawKey;
        try {
            key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
        } catch {
            // An invalidly escaped unknown key is retained as-is.  It is not
            // one of the known image transformation keys.
        }
        return !DISCORD_IMAGE_QUERY_KEYS.has(key.toLowerCase());
    });
    const nextQuery = keptQuery.length
        ? `?${keptQuery.join('&')}`
        : '';
    parsed.search = nextQuery;

    return { url: parsed.toString(), normalized: parsed.toString() !== before };
}

/**
 * Validate and normalize a PNG card URL.
 *
 * @param {string|URL} input
 * @returns {{url: string, filename: string, isDiscord: boolean, normalized: boolean}}
 */
export function normalizeCardUrl(input) {
    if (!(typeof input === 'string' || input instanceof URL)) {
        throw new Error('请输入一个 HTTPS PNG 原图链接。');
    }

    const source = String(input).trim();
    let parsed;
    try {
        parsed = new URL(source);
    } catch {
        throw new Error('请输入一个有效的 HTTPS PNG 原图链接。');
    }

    if (parsed.protocol !== 'https:') {
        throw new Error('仅支持 HTTPS 图片链接。');
    }
    if (parsed.username || parsed.password) {
        throw new Error('图片链接不能包含用户名或密码。');
    }

    rejectPrivateHost(parsed);

    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    const isDiscord = isDiscordHost(hostname);
    if (isDiscordMessageHost(hostname) && /^\/channels(?:\/|$)/i.test(parsed.pathname)) {
        throw new Error(DISCORD_MESSAGE_ERROR);
    }

    const isMediaAttachment = hostname === 'media.discordapp.net'
        && /^\/attachments(?:\/|$)/i.test(parsed.pathname);
    const isCdnAttachment = hostname === 'cdn.discordapp.com'
        && /^\/attachments(?:\/|$)/i.test(parsed.pathname);

    if (!hasPngExtension(parsed.pathname)) {
        throw new Error('只支持 PNG 角色卡原图，不能把 WebP 或其他格式改名为 PNG。');
    }

    let resultUrl = source;
    let normalized = false;
    if (isMediaAttachment || isCdnAttachment) {
        ({ url: resultUrl, normalized } = normalizedDiscordUrl(parsed));
    }

    return {
        url: resultUrl,
        filename: safeFilenameFromPath(parsed.pathname),
        isDiscord,
        normalized,
    };
}

function asUint8Array(bytes) {
    if (bytes instanceof Uint8Array) {
        return bytes;
    }
    if (bytes instanceof ArrayBuffer) {
        return new Uint8Array(bytes);
    }
    if (ArrayBuffer.isView(bytes)) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    throw new Error('PNG 数据必须是二进制字节。');
}

function readUint32(bytes, offset) {
    return ((bytes[offset] * 0x1000000)
        + (bytes[offset + 1] << 16)
        + (bytes[offset + 2] << 8)
        + bytes[offset + 3]) >>> 0;
}

function chunkCrc(bytes, start, end) {
    let value = 0xffffffff;
    for (let index = start; index < end; index++) {
        value = CRC32_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
}

function chunkType(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function bytesToAscii(bytes, start, end) {
    let result = '';
    for (let index = start; index < end; index++) {
        result += String.fromCharCode(bytes[index]);
    }
    return result;
}

function decodeBase64Utf8(base64) {
    const compact = base64.replace(/[\t\n\f\r ]/g, '');
    if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
        throw new Error('角色卡元数据不是有效的 Base64。');
    }
    const paddingIndex = compact.indexOf('=');
    if (paddingIndex !== -1 && (paddingIndex < compact.length - 2 || compact.length % 4 !== 0)) {
        throw new Error('角色卡元数据不是有效的 Base64。');
    }

    let binary;
    try {
        binary = globalThis.atob(compact);
    } catch {
        throw new Error('角色卡元数据不是有效的 Base64。');
    }

    const decoded = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        decoded[index] = binary.charCodeAt(index);
    }

    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    } catch {
        throw new Error('角色卡元数据不是有效的 UTF-8。');
    }
}

function readCardTextChunks(bytes) {
    if (bytes.byteLength < PNG_SIGNATURE.length || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
        throw new Error('文件不是有效的 PNG 图片。');
    }

    const textChunks = [];
    let offset = PNG_SIGNATURE.length;
    let foundIend = false;
    let firstChunk = true;
    while (offset < bytes.length) {
        if (bytes.length - offset < 12) {
            throw new Error('PNG chunk 已截断。');
        }

        const dataLength = readUint32(bytes, offset);
        const typeStart = offset + 4;
        const dataStart = offset + 8;
        const dataEnd = dataStart + dataLength;
        const chunkEnd = dataEnd + 4; // four-byte CRC
        if (dataEnd < dataStart || chunkEnd > bytes.length) {
            throw new Error('PNG chunk 边界无效或文件已截断。');
        }

        const type = chunkType(bytes, typeStart);
        if (!/^[A-Za-z]{4}$/.test(type)) {
            throw new Error('PNG chunk 类型无效。');
        }
        if (firstChunk && (type !== 'IHDR' || dataLength !== 13)) {
            throw new Error('PNG 缺少有效的 IHDR chunk。');
        }
        firstChunk = false;
        if (readUint32(bytes, dataEnd) !== chunkCrc(bytes, typeStart, dataEnd)) {
            throw new Error('PNG chunk CRC 校验失败，文件可能已损坏。');
        }
        if (type === 'tEXt') {
            const separator = bytes.indexOf(0, dataStart);
            if (separator === -1 || separator === dataStart || separator >= dataEnd) {
                throw new Error('PNG tEXt chunk 无效。');
            }
            textChunks.push({
                keyword: bytesToAscii(bytes, dataStart, separator),
                text: bytesToAscii(bytes, separator + 1, dataEnd),
            });
        }

        offset = chunkEnd;
        if (type === 'IEND') {
            if (dataLength !== 0 || offset !== bytes.length) {
                throw new Error('PNG IEND chunk 无效或后面仍有数据。');
            }
            foundIend = true;
            break;
        }
    }

    if (!foundIend) {
        throw new Error('PNG 缺少 IEND chunk。');
    }
    return textChunks;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cardName(value) {
    const candidate = value?.data?.name ?? value?.name;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function parseCardMetadata(text, keyword) {
    let parsed;
    try {
        parsed = JSON.parse(decodeBase64Utf8(text));
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error('角色卡元数据不是有效的 JSON。');
        }
        throw error;
    }
    if (!isObject(parsed)) {
        throw new Error('角色卡元数据结构无效。');
    }

    const name = cardName(parsed);
    if (!name) {
        throw new Error('角色卡缺少非空的角色名称。');
    }

    let spec = typeof parsed.spec === 'string' && parsed.spec ? parsed.spec : null;
    if (keyword.toLowerCase() === 'ccv3') {
        // Match TavernCardValidator's v3 version range while still allowing
        // older cards whose parser omitted spec_version.
        // SillyTavern's writer also adds ccv3 to legacy v1 JSON. Its importer
        // accepts these top-level fields when data is absent, so keep the
        // same preference and bytes rather than falling back to another chunk.
        const legacyFields = parsed.data === undefined && typeof parsed.name === 'string' && parsed.name.trim();
        if (spec !== 'chara_card_v3' || (!isObject(parsed.data) && !legacyFields)) {
            throw new Error('ccv3 角色卡元数据结构无效。');
        }
        if (parsed.spec_version !== undefined) {
            const version = Number(parsed.spec_version);
            if (!Number.isFinite(version) || version < 3 || version >= 4) {
                throw new Error('ccv3 角色卡版本无效。');
            }
        }
    }
    if (!spec) {
        spec = keyword.toLowerCase() === 'ccv3' ? 'chara_card_v3' : 'chara_card_v1';
    }
    return { name, spec };
}

/**
 * Validate a PNG and read only its character metadata.  Card JSON is parsed as
 * data and is never evaluated or passed to a template/runtime.
 *
 * @param {ArrayBuffer|ArrayBufferView|Uint8Array} bytes
 * @returns {{name: string, spec: string}}
 */
export function validateCardPng(bytes) {
    const data = asUint8Array(bytes);
    if (data.byteLength > MAX_CARD_BYTES) {
        throw new Error(`角色卡文件不能超过 ${MAX_CARD_BYTES / (1024 * 1024)} MB。`);
    }

    const textChunks = readCardTextChunks(data);
    const ccv3 = textChunks.find(chunk => chunk.keyword.toLowerCase() === 'ccv3');
    const chara = textChunks.find(chunk => chunk.keyword.toLowerCase() === 'chara');
    const selected = ccv3 ?? chara;
    if (!selected) {
        throw new Error('PNG 中没有找到角色卡元数据。');
    }

    return parseCardMetadata(selected.text, selected.keyword);
}
