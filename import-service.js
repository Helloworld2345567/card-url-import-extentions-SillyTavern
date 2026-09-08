import { MAX_CARD_BYTES, validateCardPng } from './card-source.js';

/** Read the response with a limit, including when Content-Length is absent. */
async function readCardBytes(response) {
    if (Number(response.headers.get('Content-Length')) > MAX_CARD_BYTES) {
        await response.body?.cancel();
        throw new Error('角色卡超过 32 MiB，已停止下载。');
    }
    if (!response.body) throw new Error('服务器没有返回角色卡文件。');
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_CARD_BYTES) {
                await reader.cancel();
                throw new Error('角色卡超过 32 MiB，已停止下载。');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/** Use the authenticated, same-origin ST downloader and its existing domain policy. */
export async function downloadCard(source, { headers, signal, fetchImpl = fetch }) {
    const response = await fetchImpl('/api/content/importURL', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: source.url }),
        credentials: 'same-origin',
        redirect: 'error',
        signal,
    });
    if (response.status === 401 || response.status === 403) {
        throw new Error('酒馆登录或请求验证已过期，请刷新页面后重试。');
    }
    if (!response.ok) {
        if (source.isDiscord && response.status === 404) {
            throw new Error('无法下载 Discord 附件：链接可能已过期或文件已删除。请从 Discord 重新复制完整原图链接（包含 ex、is、hm）；也请确认酒馆允许 cdn.discordapp.com。');
        }
        if (response.status === 404) {
            throw new Error('无法下载：请检查链接是否有效，以及该域名是否在酒馆 whitelistImportDomains 中。默认支持 Discord CDN、Catbox、GitHub Raw。');
        }
        throw new Error(`下载失败（HTTP ${response.status}）。请检查酒馆服务器能否访问图片来源。`);
    }
    const contentType = response.headers.get('Content-Type') || '';
    if (/text\/html/i.test(contentType)) {
        throw new Error('下载到的是网页或登录页面，请刷新酒馆登录，并使用 PNG 原始附件直链。');
    }
    const bytes = await readCardBytes(response);
    const metadata = validateCardPng(bytes);
    return { bytes, metadata };
}

/** Import exactly the validated bytes. Do not overwrite an existing card or retry a write. */
export async function uploadCard(bytes, filename, { headers, userName, fetchImpl = fetch }) {
    const formData = new FormData();
    formData.append('avatar', new File([bytes], filename, { type: 'image/png' }));
    formData.append('file_type', 'png');
    formData.append('user_name', userName || 'User');
    let response;
    try {
        response = await fetchImpl('/api/characters/import', {
            method: 'POST',
            headers,
            body: formData,
            credentials: 'same-origin',
            redirect: 'error',
            signal: AbortSignal.timeout(120_000),
        });
    } catch {
        throw new Error('未收到导入结果。角色卡可能已保存，请刷新角色列表检查后再决定是否重试。');
    }
    if (!response.ok) {
        throw new Error(`酒馆导入未成功返回（HTTP ${response.status}），请先检查角色列表再重试。`);
    }
    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error('酒馆未返回有效导入结果，请刷新角色列表检查；不要连续重复导入。');
    }
    if (!result || result.error || typeof result.file_name !== 'string' || !result.file_name) {
        throw new Error('酒馆未确认角色卡导入成功，请检查角色列表及服务端日志。');
    }
    return `${result.file_name}.png`;
}
