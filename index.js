import {
    eventSource,
    event_types,
    getThumbnailUrl,
} from '../../../../script.js';
import { getContext } from '../../../../scripts/extensions.js';

const MODULE_NAME = 'recent-chats-group';
const MODULE_VERSION = '1.1.0';

// 会话内记住各分组的展开状态（key: 角色 avatar；群聊固定为 '__group__'）
const expandedGroups = new Set();

// ========== 主题实色合成（沿用统一方案：只模仿主题配色，不产生毛玻璃） ==========

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

// 把实色写入欢迎面板上的 --rcg-* 变量（分组头与组体都继承）
function applyPanelColors(panel) {
    const colors = computeSolidColors();
    if (!colors) return;
    panel.style.setProperty('--rcg-bg', toRGB(colors.bg));
    panel.style.setProperty('--rcg-fg', toRGB(colors.fg));
    panel.style.setProperty('--rcg-border', toRGB(colors.border));
}

// ========== 按角色分组 ==========

// 解析一条聊天条目里真正的头像地址。
// 部分扩展（如柏宝箱）会把头像换成 1×1 占位图做懒加载，真地址存在
// data-*-src 属性里；直接读 src 会拿到占位图，因此优先取 data-*-src。
function resolveAvatarSrc(img) {
    if (!img) return null;
    for (const attr of img.attributes) {
        const n = attr.name.toLowerCase();
        if (n.startsWith('data-') && n.endsWith('-src') && attr.value && attr.value.trim()) {
            return attr.value.trim();
        }
    }
    const src = (img.src || '').trim();
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return null;
    return src;
}

// 把平铺的 .recentChat 列表重排成「角色档案文件夹 + 可展开内容」结构
function groupRecentChats(panel) {
    if (panel.dataset.rcgGrouped === '1') return; // 防重复处理

    const list = panel.querySelector('.recentChatList');
    if (!list) return;

    const items = Array.from(list.querySelectorAll(':scope > .recentChat'));
    if (items.length === 0) return; // 空状态不处理

    const groupChats = items.filter(it => it.getAttribute('data-group'));
    const soloChats = items.filter(it => !it.getAttribute('data-group'));

    // 按角色（data-avatar）分组，保持原列表顺序（最近在前）
    const groups = new Map();
    for (const item of soloChats) {
        const key = item.getAttribute('data-avatar') || '__unknown__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }

    // 清空后重建（.recentChat 元素本身被移入组体，其点击/置顶/重命名/删除事件保持有效）
    list.innerHTML = '';

    const frag = document.createDocumentFragment();

    for (const [key, chatItems] of groups) {
        frag.appendChild(buildGroupHeader(key, chatItems, false));
        const body = document.createElement('div');
        body.className = 'rcg-group-body';
        chatItems.forEach(it => appendToGroupBody(body, it));
        frag.appendChild(body);
    }

    if (groupChats.length > 0) {
        frag.appendChild(buildGroupHeader('__group__', groupChats, true));
        const body = document.createElement('div');
        body.className = 'rcg-group-body';
        groupChats.forEach(it => appendToGroupBody(body, it));
        frag.appendChild(body);
    }

    list.appendChild(frag);
    applyPanelColors(panel);
    panel.dataset.rcgGrouped = '1';
}

// 移入组体时去掉酒馆的 hidden 状态：展开文件夹即显示该角色全部存档，
// 不再需要点「显示更多」。
function appendToGroupBody(body, item) {
    item.classList.remove('hidden');
    body.appendChild(item);
}

function buildGroupHeader(key, chatItems, isGroup) {
    const header = document.createElement('div');
    header.className = 'rcg-group';
    header.dataset.groupKey = key;

    const chevron = document.createElement('i');
    chevron.className = 'fa-solid fa-chevron-right rcg-chevron';

    // 头像：优先按角色定义解析真实缩略图地址（兼容柏宝箱等懒加载占位图扩展）
    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'rcg-group-avatar';
    let imgSrc = null;
    if (!isGroup) {
        const character = (getContext().characters || []).find(c => c.avatar === key);
        if (character?.avatar) imgSrc = getThumbnailUrl('avatar', character.avatar);
    }
    if (!imgSrc) imgSrc = resolveAvatarSrc(chatItems[0]?.querySelector('.avatar img'));
    if (imgSrc) {
        const img = document.createElement('img');
        img.src = imgSrc;
        img.alt = '';
        img.draggable = false;
        avatarWrap.appendChild(img);
    }

    // 名称：单角色组取角色名；群聊组固定为「群聊」
    const name = document.createElement('strong');
    name.className = 'rcg-group-name';
    if (isGroup) {
        name.textContent = '群聊';
    } else {
        const character = (getContext().characters || []).find(c => c.avatar === key);
        name.textContent = character?.name
            || chatItems[0]?.querySelector('.characterName')?.textContent
            || '未知角色';
    }

    // 数量
    const count = document.createElement('span');
    count.className = 'rcg-group-count';
    count.textContent = `${chatItems.length} 个存档`;

    header.appendChild(chevron);
    header.appendChild(avatarWrap);
    header.appendChild(name);
    header.appendChild(count);

    // 默认收起；有置顶存档的组默认展开（保证置顶操作可见）；会话内记住手动展开的组
    const anyPinned = chatItems.some(it => it.querySelector('.recentChatPinned'));
    if (anyPinned || expandedGroups.has(key)) {
        header.classList.add('rcg-open');
    }

    header.addEventListener('click', () => {
        const isOpen = header.classList.toggle('rcg-open');
        if (isOpen) expandedGroups.add(key);
        else expandedGroups.delete(key);
    });

    return header;
}

// ========== 挂载：监听欢迎面板渲染 ==========

function initObserver() {
    const chat = document.getElementById('chat');
    if (!chat) return;

    // 欢迎面板由酒馆直接 append 到 #chat；只监听直接子节点增删，开销极小
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type !== 'childList') continue;
            for (const node of m.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE
                    && node.classList
                    && node.classList.contains('welcomePanel')) {
                    groupRecentChats(node);
                }
            }
        }
    });

    observer.observe(chat, { childList: true });
}

// ========== 扩展入口 ==========

export async function init() {
    console.log(`[${MODULE_NAME}] v${MODULE_VERSION} 初始化中...`);

    // 处理初始化前已渲染的欢迎面板
    document.querySelectorAll('#chat > .welcomePanel').forEach(groupRecentChats);

    // 监听后续渲染（刷新/置顶/删除/重命名等都会重建面板）
    initObserver();

    // 主题切换时重新上色（本版本无 THEME_CHANGED 事件，用主题下拉框 DOM 事件兜底）
    document.addEventListener('change', (e) => {
        if (e.target && e.target.id === 'themes') {
            document.querySelectorAll('#chat .welcomePanel').forEach(applyPanelColors);
        }
    });

    // 兜底：主题变量可能在扩展初始化后应用
    setTimeout(() => {
        document.querySelectorAll('#chat .welcomePanel').forEach(applyPanelColors);
    }, 800);

    console.log(`[${MODULE_NAME}] 初始化完成`);
}

export async function loop() {
    // 无需循环逻辑
}
