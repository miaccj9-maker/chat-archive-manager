import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    characters,
    selectCharacterById,
    setActiveGroup,
    getRequestHeaders,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../../scripts/extensions.js';

const MODULE_NAME = 'chat-archive-manager';
const MODULE_VERSION = '1.0.0';

// 初始化扩展设置
if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = {
        notes: {}, // "avatar::fileName" -> 备注文本
    };
}

const settings = extension_settings[MODULE_NAME];
const notes = settings.notes;

let panelContent = null;
let charListEl = null;
let countsStarted = false; // 面板首次展开后才拉取数量（懒加载）
let countsLoaded = false;
const counts = {};        // avatar -> 存档数量
const chatsCache = {};    // avatar -> 完整存档列表（缓存）
const expanded = new Set(); // 当前展开的存档文件夹（avatar，仅会话内）

// ========== 工具函数 ==========

function noteKey(avatar, fileName) {
    return `${avatar}::${fileName}`;
}

// 把 ST 的日期值（ISO 字符串 / 毫秒数 / 秒数）统一转成毫秒
function toMs(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    const s = String(value).trim();
    if (/^\d+$/.test(s)) {
        const n = Number(s);
        return n < 1e11 ? n * 1000 : n;
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? 0 : d.getTime();
}

function formatDateTime(value) {
    const ms = toMs(value);
    if (!ms) return '';
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 纯时间戳命名的存档（未重命名过）→ 格式化为日期时间；否则返回 null
function formatTimestampName(base) {
    if (!/^\d+$/.test(base)) return null;
    return formatDateTime(base);
}

// 按最后消息时间倒序
function sortChats(list) {
    return list.slice().sort((a, b) => toMs(b.last_mes) - toMs(a.last_mes));
}

// ========== 数据获取（走酒馆原生接口） ==========

// 数量用 simple 模式：只读目录，不解析文件内容，非常轻量
async function fetchSimpleCount(avatar) {
    try {
        const res = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, simple: true }),
        });
        if (!res.ok) return 0;
        const data = await res.json();
        if (data && data.error === true) return 0;
        return Array.isArray(data) ? data.length : 0;
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 获取角色存档数量失败:`, e);
        return 0;
    }
}

// 完整信息：file_name / chat_items / file_size / mes / last_mes
async function fetchCharacterChats(avatar) {
    try {
        const res = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data.error === true) return [];
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 获取角色存档失败:`, e);
        return null;
    }
}

// 加载各角色存档数量（只补缺失的）
async function loadCounts() {
    const list = getContext().characters || [];
    countsLoaded = true;
    await Promise.all(list.map(async c => {
        if (!c || !c.avatar) return;
        if (counts[c.avatar] === undefined) {
            counts[c.avatar] = await fetchSimpleCount(c.avatar);
        }
    }));
    await renderCharFolders();
}

// ========== 主题实色跟随（面板不毛玻璃） ==========
// 与角色主题绑定扩展同一套方案：读取主题 CSS 变量，透明色合成为
// 不透明实色后写入 --cam-*，只模仿主题配色，绝不产生毛玻璃观感。

function parseColor(str) {
    if (!str) return null;
    str = str.trim();
    let m;
    if ((m = str.match(/^#([0-9a-f]{3,8})$/i))) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
        if (h.length === 6) h += 'ff';
        if (h.length !== 8) return null;
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
            a: parseInt(h.slice(6, 8), 16) / 255,
        };
    }
    if ((m = str.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[, /]\s*([\d.]+%?)\s*)?\)$/i))) {
        const a = m[4] === undefined ? 1 : (m[4].includes('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
        return {
            r: Math.max(0, Math.min(255, Math.round(parseFloat(m[1])))),
            g: Math.max(0, Math.min(255, Math.round(parseFloat(m[2])))),
            b: Math.max(0, Math.min(255, Math.round(parseFloat(m[3])))),
            a: Math.max(0, Math.min(1, a)),
        };
    }
    return null;
}

function blendColor(base, over) {
    const a = over.a;
    return {
        r: Math.round(over.r * a + base.r * (1 - a)),
        g: Math.round(over.g * a + base.g * (1 - a)),
        b: Math.round(over.b * a + base.b * (1 - a)),
        a: 1,
    };
}

function toRGB(c) {
    return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function luminance(c) {
    return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

function relativeLuminance(c) {
    const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrastRatio(a, b) {
    const l1 = relativeLuminance(a);
    const l2 = relativeLuminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function getThemeVar(name) {
    const rootVal = getComputedStyle(document.documentElement).getPropertyValue(name);
    if (rootVal && rootVal.trim()) return rootVal;
    return getComputedStyle(document.body).getPropertyValue(name);
}

function getPageBgColor() {
    const root = getComputedStyle(document.documentElement).backgroundColor;
    const body = getComputedStyle(document.body).backgroundColor;
    return parseColor(root) || parseColor(body) || null;
}

function computeSolidColors() {
    const blurTint = parseColor(getThemeVar('--SmartThemeBlurTintColor'));
    const fgRaw = parseColor(getThemeVar('--SmartThemeBodyColor'));
    const borderRaw = parseColor(getThemeVar('--SmartThemeBorderColor'));

    if (!blurTint && !fgRaw) return null;

    const pageBg = getPageBgColor();
    const tintLum = blurTint ? luminance(blurTint) : -1;
    const base = (pageBg && pageBg.a >= 0.97)
        ? { r: pageBg.r, g: pageBg.g, b: pageBg.b, a: 1 }
        : (tintLum >= 128
            ? { r: 255, g: 255, b: 255, a: 1 }
            : { r: 0, g: 0, b: 0, a: 1 });

    const bg = blurTint
        ? (blurTint.a >= 0.97 ? { ...blurTint, a: 1 } : blendColor(base, blurTint))
        : { ...base, a: 1 };

    let fg = fgRaw ? (fgRaw.a >= 0.97 ? fgRaw : blendColor(bg, fgRaw)) : null;
    if (!fg || contrastRatio(fg, bg) < 3.5) {
        fg = luminance(bg) >= 128
            ? { r: 0, g: 0, b: 0, a: 1 }
            : { r: 255, g: 255, b: 255, a: 1 };
    }

    let border = null;
    if (borderRaw && borderRaw.a >= 0.1) {
        border = blendColor(bg, borderRaw);
        if (Math.abs(luminance(border) - luminance(bg)) < 20) border = null;
    }
    if (!border) {
        border = blendColor(bg, { ...fg, a: 0.35 });
    }

    return { bg, fg, border };
}

function updateThemeColors() {
    const panel = document.getElementById('cam-panel');
    if (!panel) return;
    const colors = computeSolidColors();
    if (!colors) return;
    panel.style.setProperty('--cam-bg', toRGB(colors.bg));
    panel.style.setProperty('--cam-fg', toRGB(colors.fg));
    panel.style.setProperty('--cam-border', toRGB(colors.border));
}

function syncThemeColors() {
    updateThemeColors();
    setTimeout(updateThemeColors, 150);
    setTimeout(updateThemeColors, 500);
}

// ========== UI 构建 ==========

function updateStats() {
    const el = document.getElementById('cam-stats');
    if (!el) return;
    const total = (getContext().characters || []).length;
    const visible = charListEl ? charListEl.querySelectorAll('.cam-char').length : 0;
    el.textContent = countsLoaded
        ? `共 ${total} 个角色，${visible} 个有存档`
        : `共 ${total} 个角色`;
}

function buildCharFolder(c, count) {
    const folder = document.createElement('div');
    folder.className = 'cam-char';
    folder.dataset.avatar = c.avatar;

    const head = document.createElement('div');
    head.className = 'cam-char-head';

    const chevron = document.createElement('span');
    chevron.className = 'cam-chevron';
    chevron.textContent = '▸';

    const name = document.createElement('span');
    name.className = 'cam-char-name';
    name.textContent = c.name || String(c.avatar).replace(/\.png$/i, '');
    name.title = c.name || c.avatar;

    const badge = document.createElement('span');
    badge.className = 'cam-char-count';
    badge.textContent = count === -1 ? '…' : String(count);

    head.appendChild(chevron);
    head.appendChild(name);
    head.appendChild(badge);

    const body = document.createElement('div');
    body.className = 'cam-char-body';

    head.addEventListener('click', () => toggleFolder(folder, c.avatar, chevron));

    folder.appendChild(head);
    folder.appendChild(body);
    return folder;
}

async function toggleFolder(folder, avatar, chevron) {
    if (folder.classList.contains('cam-open')) {
        folder.classList.remove('cam-open');
        chevron.textContent = '▸';
        expanded.delete(avatar);
        return;
    }
    folder.classList.add('cam-open');
    chevron.textContent = '▾';
    expanded.add(avatar);
    const body = folder.querySelector('.cam-char-body');
    if (body) await renderChatList(avatar, body);
}

async function renderChatList(avatar, body) {
    let chats = chatsCache[avatar];

    if (!chats) {
        body.innerHTML = '';
        const loading = document.createElement('div');
        loading.className = 'cam-loading';
        loading.textContent = '加载存档中…';
        body.appendChild(loading);

        chats = await fetchCharacterChats(avatar);
        if (chats === null) {
            body.innerHTML = '';
            const err = document.createElement('div');
            err.className = 'cam-empty';
            err.textContent = '加载失败，请点击右上角「🔄 刷新」重试';
            body.appendChild(err);
            return;
        }
        chats = sortChats(chats);
        chatsCache[avatar] = chats;
        body.innerHTML = '';
    }

    if (chats.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cam-empty';
        empty.textContent = '该角色暂无聊天存档';
        body.appendChild(empty);
        return;
    }

    const currentChat = getContext().chatId;
    const frag = document.createDocumentFragment();
    chats.forEach(chat => frag.appendChild(buildChatRow(chat, avatar, currentChat)));
    body.appendChild(frag);
}

function buildChatRow(chat, avatar, currentChat) {
    const row = document.createElement('div');
    row.className = 'cam-chat';
    row.dataset.file = chat.file_name;
    if (currentChat && chat.file_name === currentChat) {
        row.classList.add('cam-current');
    }

    const meta = document.createElement('div');
    meta.className = 'cam-chat-meta';

    // 标题：未重命名的纯时间戳显示为日期时间；重命名过的显示自定义名
    const title = document.createElement('span');
    title.className = 'cam-chat-title';
    const base = String(chat.file_name || '').replace(/\.jsonl$/i, '');
    title.textContent = formatTimestampName(base) || base || chat.file_name;
    title.title = chat.file_name;

    // 副信息：条数 · 大小 · 最后消息时间
    const sub = document.createElement('span');
    sub.className = 'cam-chat-sub';
    const msgs = Number.isFinite(Number(chat.chat_items)) ? Number(chat.chat_items) : 0;
    let subText = `${msgs} 条 · ${chat.file_size || '?'}`;
    const dateStr = formatDateTime(chat.last_mes);
    if (dateStr) subText += ` · ${dateStr}`;
    sub.textContent = subText;

    // 当前标记
    const curBadge = document.createElement('span');
    curBadge.className = 'cam-current-badge';
    curBadge.textContent = '当前';

    // 加载按钮
    const loadBtn = document.createElement('button');
    loadBtn.className = 'cam-load';
    loadBtn.textContent = '加载';
    loadBtn.addEventListener('click', () => loadChat(avatar, chat.file_name));

    meta.appendChild(title);
    meta.appendChild(sub);
    if (row.classList.contains('cam-current')) meta.appendChild(curBadge);
    meta.appendChild(loadBtn);

    // 最后一条消息预览
    const preview = document.createElement('div');
    preview.className = 'cam-chat-preview';
    const mes = chat.mes && chat.mes !== '[The chat is empty]' ? chat.mes : '';
    preview.textContent = mes;
    preview.title = mes;

    // 备注
    const noteInput = document.createElement('input');
    noteInput.className = 'cam-note';
    noteInput.type = 'text';
    noteInput.placeholder = '✎ 添加备注…';
    noteInput.maxLength = 200;
    noteInput.value = notes[noteKey(avatar, chat.file_name)] || '';
    noteInput.addEventListener('input', () => {
        const v = noteInput.value.trim();
        if (v) notes[noteKey(avatar, chat.file_name)] = v;
        else delete notes[noteKey(avatar, chat.file_name)];
        saveSettingsDebounced();
    });

    row.appendChild(meta);
    row.appendChild(preview);
    row.appendChild(noteInput);
    return row;
}

// 加载指定角色的指定存档（与酒馆原生聊天列表点击行为一致）
async function loadChat(avatar, fileName) {
    const idx = characters.findIndex(c => c && c.avatar === avatar);
    if (idx === -1) {
        console.warn(`[${MODULE_NAME}] 找不到角色:`, avatar);
        toastr?.warning?.(`找不到角色「${avatar}」`);
        return;
    }
    try {
        characters[idx].chat = fileName;
        setActiveGroup(null); // 确保退出群聊模式
        await selectCharacterById(idx);
        toastr?.success?.(`已加载存档：${fileName}`);
    } catch (e) {
        console.error(`[${MODULE_NAME}] 加载存档失败:`, e);
        toastr?.error?.(`加载存档失败：${fileName}`);
    }
}

async function renderCharFolders() {
    if (!charListEl) return;
    charListEl.innerHTML = '';

    const list = getContext().characters || [];

    if (list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cam-empty';
        empty.textContent = '未找到角色卡，请先导入角色';
        charListEl.appendChild(empty);
        updateStats();
        return;
    }

    const frag = document.createDocumentFragment();
    list.forEach(c => {
        if (!c || !c.avatar) return;
        const n = countsLoaded ? (counts[c.avatar] ?? 0) : -1;
        if (countsLoaded && n === 0) return; // 无存档的角色不展示
        frag.appendChild(buildCharFolder(c, n));
    });
    charListEl.appendChild(frag);
    updateStats();

    // 恢复上次展开的文件夹
    await Promise.all(list.map(async c => {
        if (!c || !expanded.has(c.avatar)) return;
        const folder = charListEl.querySelector(`.cam-char[data-avatar="${CSS.escape(c.avatar)}"]`);
        if (!folder) return;
        folder.classList.add('cam-open');
        const chevron = folder.querySelector('.cam-chevron');
        if (chevron) chevron.textContent = '▾';
        const body = folder.querySelector('.cam-char-body');
        if (body) await renderChatList(c.avatar, body);
    }));
}

// 仅更新「当前」标记，不重建列表
function updateCurrentBadges() {
    if (!panelContent) return;
    const current = getContext().chatId;
    const rows = panelContent.querySelectorAll('.cam-chat');
    for (const row of rows) {
        const isCur = current && row.dataset.file === current;
        row.classList.toggle('cam-current', isCur);
        let badge = row.querySelector('.cam-current-badge');
        if (isCur && !badge) {
            badge = document.createElement('span');
            badge.className = 'cam-current-badge';
            badge.textContent = '当前';
            const meta = row.querySelector('.cam-chat-meta');
            const loadBtn = row.querySelector('.cam-load');
            if (meta) meta.insertBefore(badge, loadBtn);
        } else if (!isCur && badge) {
            badge.remove();
        }
    }
}

// 刷新：清空缓存并重拉数量与已展开的存档
async function refreshAll() {
    Object.keys(chatsCache).forEach(k => delete chatsCache[k]);
    Object.keys(counts).forEach(k => delete counts[k]);
    countsLoaded = true;
    await loadCounts();
}

function createSettingsPanel() {
    const container = document.createElement('div');
    container.id = 'cam-panel';
    container.className = 'inline-drawer';

    // 标题栏（inline-drawer-toggle 触发酒馆原生展开/收起）
    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle cam-header';
    header.innerHTML = `
        <span class="cam-title">📁 聊天存档管理器</span>
        <span class="cam-version">v${MODULE_VERSION}</span>
    `;

    // 内容区
    const content = document.createElement('div');
    content.className = 'inline-drawer-content cam-content';

    // 工具栏
    const toolbar = document.createElement('div');
    toolbar.className = 'cam-toolbar';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'cam-refresh';
    refreshBtn.textContent = '🔄 刷新';
    refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '刷新中…';
        await refreshAll();
        refreshBtn.disabled = false;
        refreshBtn.textContent = '🔄 刷新';
    });

    const stats = document.createElement('span');
    stats.className = 'cam-stats';
    stats.id = 'cam-stats';

    toolbar.appendChild(refreshBtn);
    toolbar.appendChild(stats);

    // 角色档案列表
    charListEl = document.createElement('div');
    charListEl.className = 'cam-char-list';
    charListEl.id = 'cam-char-list';

    content.appendChild(toolbar);
    content.appendChild(charListEl);

    container.appendChild(header);
    container.appendChild(content);

    const extensionsSettings = document.getElementById('extensions_settings')
        || document.getElementById('extensions_settings2');
    if (extensionsSettings) {
        extensionsSettings.appendChild(container);
    } else {
        console.warn(`[${MODULE_NAME}] 未找到扩展设置容器，面板将不可用`);
    }

    panelContent = content;

    // 首次展开面板时才拉取各角色存档数量（懒加载，页面加载时零额外请求）
    header.addEventListener('click', () => {
        if (!countsStarted) {
            countsStarted = true;
            loadCounts();
        }
    });

    return content;
}

// ========== 扩展入口 ==========

export async function init() {
    console.log(`[${MODULE_NAME}] v${MODULE_VERSION} 初始化中...`);

    // 创建设置面板
    createSettingsPanel();

    // 面板配色跟随主题（实色、无毛玻璃）；本版本无 THEME_CHANGED 事件，用主题下拉框 DOM 事件兜底
    updateThemeColors();
    setTimeout(updateThemeColors, 600);
    document.addEventListener('change', (e) => {
        if (e.target && e.target.id === 'themes') syncThemeColors();
    });

    // 初始渲染角色列表（数量在面板首次展开后懒加载）
    renderCharFolders();

    // 角色列表加载/变化时重建（清理已删除角色的缓存与展开状态）
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => {
        const avatars = new Set((getContext().characters || []).map(c => c && c.avatar).filter(Boolean));
        Object.keys(chatsCache).forEach(k => { if (!avatars.has(k)) delete chatsCache[k]; });
        Object.keys(counts).forEach(k => { if (!avatars.has(k)) delete counts[k]; });
        expanded.forEach(k => { if (!avatars.has(k)) expanded.delete(k); });
        if (countsStarted) {
            countsLoaded = true;
            loadCounts();
        } else {
            renderCharFolders();
        }
    });

    // 聊天切换时更新「当前」标记
    eventSource.on(event_types.CHAT_CHANGED, updateCurrentBadges);

    console.log(`[${MODULE_NAME}] 初始化完成`);
}

export async function loop() {
    // 无需循环逻辑
}
