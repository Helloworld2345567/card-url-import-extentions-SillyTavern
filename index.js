import { is_send_press } from '/script.js';
import { is_group_generating } from '/scripts/group-chats.js';
import { normalizeCardUrl } from './card-source.js';
import { downloadCard, uploadCard } from './import-service.js';

let busy = false;

/** Add a small, self-contained panel to SillyTavern's extension settings. */
export function init() {
    if (document.getElementById('card_url_import')) return;
    const panel = document.createElement('div');
    panel.id = 'card_url_import';
    panel.className = 'extension_container';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>角色卡链接导入</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p>粘贴 PNG 角色卡直链，自动下载并导入角色列表。</p>
                <label for="card_url_input">角色卡图片地址</label>
                <textarea id="card_url_input" class="text_pole" rows="3"
                    placeholder="https://cdn.discordapp.com/attachments/…/角色卡.png?ex=…&is=…&hm=…"
                    autocomplete="off" spellcheck="false" aria-describedby="card_url_help"></textarea>
                <small id="card_url_help">支持 Discord 原图及预览图片链接、Catbox、GitHub Raw。Discord 中请点图片 → 在浏览器中打开 → 复制完整地址。消息页面链接无法直接导入。</small>
                <div class="card-url-actions">
                    <button type="button" id="card_url_submit" class="menu_button">下载并导入</button>
                    <button type="button" id="card_url_cancel" class="menu_button" hidden>取消下载</button>
                </div>
                <p id="card_url_status" role="status" aria-live="polite"></p>
            </div>
        </div>`;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) throw new Error('找不到酒馆扩展面板。');
    container.append(panel);

    const input = panel.querySelector('#card_url_input');
    const submit = panel.querySelector('#card_url_submit');
    const cancel = panel.querySelector('#card_url_cancel');
    const status = panel.querySelector('#card_url_status');
    let downloadController;
    const setStatus = (text, state = '') => {
        status.textContent = text;
        status.dataset.state = state;
    };
    cancel.addEventListener('click', () => downloadController?.abort());
    submit.addEventListener('click', async () => {
        if (busy) return;
        if (is_send_press || is_group_generating) {
            setStatus('请等当前回复生成完毕，再导入角色卡。', 'error');
            return;
        }
        let source;
        try {
            source = normalizeCardUrl(input.value);
        } catch (error) {
            setStatus(error.message, 'error');
            return;
        }
        busy = true;
        submit.disabled = true;
        input.disabled = true;
        cancel.hidden = false;
        panel.setAttribute('aria-busy', 'true');
        downloadController = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            downloadController?.abort();
        }, 90_000);
        try {
            setStatus(source.normalized ? '已切换到原始 PNG 链接，正在下载…' : '正在下载原始 PNG…');
            const context = SillyTavern.getContext();
            const { bytes, metadata } = await downloadCard(source, {
                headers: context.getRequestHeaders(),
                signal: downloadController.signal,
            });
            downloadController.signal.throwIfAborted();
            clearTimeout(timer);
            downloadController = null;
            cancel.hidden = true;
            if (is_send_press || is_group_generating) {
                throw new Error('角色卡已校验，但当前正在生成回复。请等回复完成后重新导入。');
            }
            setStatus(`已确认角色「${metadata.name}」，正在导入…`);
            const avatar = await uploadCard(bytes, source.filename, {
                headers: context.getRequestHeaders({ omitContentType: true }),
                userName: context.name1,
            });
            input.value = '';
            try {
                await context.getCharacters();
                if (!SillyTavern.getContext().characters.some(character => character.avatar === avatar)) {
                    throw new Error('List not refreshed');
                }
                $('#character_search_bar').val('').trigger('input');
                setStatus(`已导入「${metadata.name}」（${(bytes.byteLength / 1024 / 1024).toFixed(2)} MiB）。可在角色列表中选择。`, 'success');
            } catch {
                setStatus(`角色卡已保存为 ${avatar}，角色列表刷新未完成。请刷新页面查看，无需重复导入。`, 'success');
            }
        } catch (error) {
            if (downloadController?.signal.aborted) {
                setStatus(timedOut ? '下载超过 90 秒，请检查网络后重试。' : '已取消下载，尚未导入角色卡。');
            } else {
                setStatus(error instanceof TypeError
                    ? '无法连接酒馆服务。请检查网络和登录状态后重试。'
                    : error.message, 'error');
            }
        } finally {
            clearTimeout(timer);
            downloadController = null;
            busy = false;
            submit.disabled = false;
            input.disabled = false;
            cancel.hidden = true;
            panel.setAttribute('aria-busy', 'false');
        }
    });
}
