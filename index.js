// @ts-nocheck
/* ==================================================
   ST-Charta — 用户设定整理
   --------------------------------------------------
   1) 左侧人设列表换成自建列表：★ 置顶 + 单层文件夹 + 未分组
   2) 窄屏切成「列表」「编辑」两个独立全屏视图
   3) 编辑区完全复用原生右列，不改写酒馆数据流
   4) 文件夹与星标存服务端 extension_settings

   依赖的原生锚点（1.19.0）：
     #persona-management-block
     .persona_management_left_column / .persona_management_right_column
     #user_avatar_block            隐藏，仅作「选中人设」的委托入口
     #persona_pagination_container 隐藏（分页与文件夹分组冲突）
   ================================================== */

(function () {
    'use strict';

    const EXT_ID = 'ST-Charta';
    const LOG = '[ST-Charta]';
    const VERSION = '1.1.6';
    const TITLE_LIST = '用户设定管理';
    const TITLE_EDIT = '用户设定编辑';
    const NARROW_QUERY = '(max-width: 1000px)';

    /* ==================================================
       1. 基础工具
       ================================================== */

    function getCtx() {
        try {
            return globalThis.SillyTavern?.getContext?.() ?? null;
        } catch (error) {
            return null;
        }
    }

    const byId = (id) => document.getElementById(id);
    const panel = () => byId('PersonaManagement');
    const narrowMedia = window.matchMedia(NARROW_QUERY);
    const coarseMedia = window.matchMedia('(hover: none) and (pointer: coarse)');

    function isNarrow() {
        const width = window.innerWidth || document.documentElement.clientWidth || 0;
        if (narrowMedia.matches) return true;

        // 某些手机的布局视口会被算到 1000px 以上（缩放 / 桌面模式 / 折叠屏），
        // 对触摸设备一路放宽到 1400px，否则两屏模式永远不触发。
        const touchy = coarseMedia.matches || (navigator.maxTouchPoints || 0) > 0;
        return touchy && width <= 1400;
    }

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function iconBtn(cls, icon, title) {
        const b = el('button', cls);
        b.type = 'button';
        if (title) b.title = title;
        b.appendChild(el('i', 'fa-solid ' + icon));
        return b;
    }

    function quote(value) {
        return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }

    function stripExt(name) {
        return String(name).replace(/\.[^.]+$/, '');
    }

    function debounce(fn, wait) {
        let timer = 0;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    function toast(message, title, kind) {
        const box = globalThis.toastr;
        if (!box) return;
        const fn = box[kind] || box.info;
        if (typeof fn === 'function') fn.call(box, message, title);
    }

    /* ==================================================
       2. 状态（服务端 extension_settings）
       ================================================== */

    function defaults() {
        return {
            version: 1,
            folders: [],
            assign: {},
            stars: {},
            collapsed: {},
            grid: false,
            sort: 'asc',
            current: '',
        };
    }

    let settings = defaults();

    function loadSettings() {
        const ctx = getCtx();
        const store = ctx?.extensionSettings;
        const base = defaults();
        const raw = store && typeof store === 'object' ? store[EXT_ID] : null;

        if (!raw || typeof raw !== 'object') {
            settings = base;
            if (store) store[EXT_ID] = settings;
            return;
        }

        if (Array.isArray(raw.folders)) {
            base.folders = raw.folders
                .filter((f) => f && typeof f.id === 'string' && f.id && typeof f.name === 'string')
                .map((f, i) => ({
                    id: f.id,
                    name: String(f.name).slice(0, 80),
                    order: Number.isFinite(f.order) ? Number(f.order) : i,
                }));
        }

        if (raw.assign && typeof raw.assign === 'object') {
            for (const [key, value] of Object.entries(raw.assign)) {
                if (typeof value === 'string' && value) base.assign[key] = value;
            }
        }

        if (raw.stars && typeof raw.stars === 'object') {
            for (const [key, value] of Object.entries(raw.stars)) {
                const seq = Number(value);
                base.stars[key] = Number.isFinite(seq) ? seq : Date.now();
            }
        }

        if (raw.collapsed && typeof raw.collapsed === 'object') {
            for (const [key, value] of Object.entries(raw.collapsed)) {
                if (value === true) base.collapsed[key] = true;
            }
        }

        base.grid = raw.grid === true;
        base.sort = raw.sort === 'desc' ? 'desc' : 'asc';
        base.current = typeof raw.current === 'string' ? raw.current : '';

        settings = base;
        if (store) store[EXT_ID] = settings;
    }

    function save() {
        const ctx = getCtx();
        if (!ctx) return;
        try {
            if (ctx.extensionSettings && typeof ctx.extensionSettings === 'object') {
                ctx.extensionSettings[EXT_ID] = settings;
            }
            ctx.saveSettingsDebounced?.();
        } catch (error) {
            console.warn(LOG, '保存设置失败', error);
        }
    }

    /* ==================================================
       3. 数据缓存
       ================================================== */

    const cache = {
        avatars: [],
        names: {},
        descs: {},
        titles: {},
        hay: {},
        query: '',
    };

    let bound = false;
    // reload（重新拉头像列表）和 repaint（只重读本地元数据）分开排队：
    // 否则后到的 repaint 会把还没执行的 reload 取消掉。
    let reloadQueued = 0;
    let repaintQueued = 0;
    // 移动端打开系统相册时，不要在相册还开着的时候重绘页面，否则部分浏览器会取消选择。
    let refreshPausedUntil = 0;
    let pendingTarget = '';
    let activeCtx = null;

    function pauseRefreshForPicker(ms = 4000) {
        refreshPausedUntil = Math.max(refreshPausedUntil, Date.now() + ms);
    }

    function refreshPaused() {
        return Date.now() < refreshPausedUntil;
    }

    function readMeta(ids) {
        const ctx = getCtx();
        const pu = ctx?.powerUserSettings || {};
        const personas = pu.personas || {};
        const descriptions = pu.persona_descriptions || {};

        for (const id of ids) {
            cache.names[id] = String(personas[id] || '').trim() || stripExt(id);
            const descriptor = descriptions[id] || {};
            cache.descs[id] = String(descriptor.description || '').trim();
            cache.titles[id] = String(descriptor.title || '').trim();
            // 搜索用的小写索引，避免每次敲键都重新拼接长描述
            cache.hay[id] = (cache.names[id] + '\n' + cache.titles[id] + '\n' + cache.descs[id]).toLowerCase();
        }
    }

    async function fetchAvatars() {
        const ctx = getCtx();
        if (!ctx?.getRequestHeaders) return null;
        try {
            const response = await fetch('/api/avatars/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders({ omitContentType: true }),
            });
            if (!response.ok) return null;
            const list = await response.json();
            if (!Array.isArray(list)) return null;
            return list.filter((item) => typeof item === 'string' && item);
        } catch (error) {
            console.warn(LOG, '拉取人设列表失败', error);
            return null;
        }
    }

    /* ---------------- 连接修复 ----------------
       酒馆的「角色」连接存的是头像文件名（avatar id）。角色改名后文件名会变，
       但原生 1.19.0 不会把 persona_descriptions[*].connections 里的旧 id 迁移过去，
       于是旧连接会一直留在数据里，列表上就会显示成旧角色名。

       这里做三件事：
       1) 收到 CHARACTER_RENAMED 时把旧 id 换成新 id；
       2) 顺手去重（旧、新 id 同时存在时只保留一个）；
       3) 人设列表加载完成后，清掉指向已不存在角色 / 群组的失效连接。
    */

    function personaDescriptionMap() {
        const ctx = getCtx();
        const map = ctx?.powerUserSettings?.persona_descriptions;
        return map && typeof map === 'object' ? map : null;
    }

    function connectionKey(connection) {
        return String(connection?.type) + '\u0000' + String(connection?.id);
    }

    function migrateCharacterConnections(oldAvatar, newAvatar) {
        if (!oldAvatar || !newAvatar || oldAvatar === newAvatar) return false;

        const ctx = getCtx();
        const map = personaDescriptionMap();
        if (!ctx || !map) return false;

        let dirty = false;

        for (const descriptor of Object.values(map)) {
            if (!descriptor || !Array.isArray(descriptor.connections)) continue;

            const next = [];
            const seen = new Set();
            let changed = false;

            for (const original of descriptor.connections) {
                let connection = original;
                if (!connection || typeof connection !== 'object') {
                    changed = true;
                    continue;
                }

                if (connection.type === 'character' && connection.id === oldAvatar) {
                    connection = { ...connection, id: newAvatar };
                    changed = true;
                }

                const key = connectionKey(connection);
                if (seen.has(key)) {
                    changed = true;
                    continue;
                }
                seen.add(key);
                next.push(connection);
            }

            if (changed) {
                descriptor.connections = next;
                dirty = true;
            }
        }

        if (dirty) ctx.saveSettingsDebounced?.();
        return dirty;
    }

    // 角色改名会先触发事件、再刷新 characters 列表。刷新完成前不能清理「未知」连接，
    // 否则刚迁移过去的新 id 会被当成失效项删掉。
    let connectionSweepBlockedUntil = 0;

    function sweepConnections() {
        if (Date.now() < connectionSweepBlockedUntil) return false;

        const ctx = getCtx();
        const map = personaDescriptionMap();
        if (!ctx || !map) return false;

        const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
        // characters 还没加载完（或确实一个角色都没有）时不清理，避免误删有效连接。
        if (!characters.length) return false;

        const characterIds = new Set(characters.map((c) => c?.avatar).filter(Boolean));
        const groups = Array.isArray(ctx.groups) ? ctx.groups : [];
        const groupIds = new Set(groups.map((g) => String(g?.id)).filter(Boolean));
        const groupsKnown = groups.length > 0;

        let dirty = false;

        for (const descriptor of Object.values(map)) {
            if (!descriptor || !Array.isArray(descriptor.connections)) continue;

            const next = [];
            const seen = new Set();
            let changed = false;

            for (const connection of descriptor.connections) {
                if (!connection || typeof connection !== 'object' || !connection.type || !connection.id) {
                    changed = true;
                    continue;
                }

                const key = connectionKey(connection);
                if (seen.has(key)) {
                    changed = true;
                    continue;
                }
                seen.add(key);

                if (connection.type === 'character' && !characterIds.has(connection.id)) {
                    changed = true;
                    continue;
                }
                if (connection.type === 'group' && groupsKnown && !groupIds.has(String(connection.id))) {
                    changed = true;
                    continue;
                }

                next.push(connection);
            }

            if (changed) {
                descriptor.connections = next;
                dirty = true;
            }
        }

        if (dirty) ctx.saveSettingsDebounced?.();
        return dirty;
    }

    function reconcile() {
        let dirty = false;
        const alive = new Set(cache.avatars);

        for (const key of Object.keys(settings.assign)) {
            if (!alive.has(key)) { delete settings.assign[key]; dirty = true; }
        }
        for (const key of Object.keys(settings.stars)) {
            if (!alive.has(key)) { delete settings.stars[key]; dirty = true; }
        }
        if (settings.current && !alive.has(settings.current)) {
            settings.current = '';
            dirty = true;
        }
        sweepConnections();
        if (dirty) save();
    }

    async function reload(delay = 60) {
        clearTimeout(reloadQueued);
        reloadQueued = setTimeout(async () => {
            if (refreshPaused()) return;
            const list = await fetchAvatars();
            if (list) {
                cache.avatars = list;
                readMeta(list);
                reconcile();
            }
            renderLimit = PAGE_SIZE;
            detectCurrent();
            render();
        }, delay);
    }

    function repaint(delay = 120) {
        clearTimeout(repaintQueued);
        repaintQueued = setTimeout(() => {
            if (refreshPaused()) return;
            if (cache.avatars.length) readMeta(cache.avatars);
            sweepConnections();
            // 不重置 renderLimit：只是元数据 / 连接变化，保留用户已经滚动加载出来的行数，
            // 避免在编辑描述时列表反复跳回前 60 条。
            detectCurrent();
            render();
        }, delay);
    }

    function detectCurrent() {
        if (settings.current && cache.avatars.includes(settings.current)) return;

        const selected = document.querySelector('#user_avatar_block .avatar-container.selected');
        const selectedId = selected?.getAttribute('data-avatar-id');
        if (selectedId && (!cache.avatars.length || cache.avatars.includes(selectedId))) {
            settings.current = selectedId;
            return;
        }

        const shown = byId('your_name')?.textContent?.trim();
        if (!shown || !cache.avatars.length) return;
        const hit = cache.avatars.find((id) => cache.names[id] === shown);
        if (hit) settings.current = hit;
    }

    /* ==================================================
       4. 选中人设 / 行内操作
       ================================================== */

    function selectPersona(avatarId) {
        pendingTarget = avatarId;

        const block = byId('user_avatar_block');
        if (block) {
            const proxy = el('div', 'avatar-container charta-proxy');
            proxy.dataset.avatarId = avatarId;
            block.appendChild(proxy);
            try {
                proxy.click();
            } catch (error) {
                console.warn(LOG, '代理点击失败', error);
            }
            proxy.remove();
        } else {
            runCommand('/persona-set mode=lookup ' + quote(avatarId));
        }

        setTimeout(() => {
            if (pendingTarget === avatarId && settings.current !== avatarId) {
                runCommand('/persona-set mode=lookup ' + quote(avatarId));
            }
            if (pendingTarget === avatarId) pendingTarget = '';
        }, 400);
    }

    async function runCommand(command) {
        const ctx = getCtx();
        if (!ctx?.executeSlashCommandsWithOptions) return;
        try {
            await ctx.executeSlashCommandsWithOptions(command);
        } catch (error) {
            console.warn(LOG, '命令执行失败', command, error);
        }
    }

    function setCurrent(avatarId) {
        if (!avatarId || settings.current === avatarId) {
            pendingTarget = '';
            return;
        }
        settings.current = avatarId;
        pendingTarget = '';
        save();
        repaint(0);
    }

    function toggleStar(avatarId) {
        if (settings.stars[avatarId] !== undefined) {
            delete settings.stars[avatarId];
        } else {
            const values = Object.values(settings.stars);
            settings.stars[avatarId] = values.length ? Math.max(...values) + 1 : 1;
        }
        save();
        render();
    }

    function assignFolder(avatarId, folderId) {
        if (folderId) settings.assign[avatarId] = folderId;
        else delete settings.assign[avatarId];
        save();
        render();
    }

    async function createFolder() {
        const ctx = getCtx();
        if (!ctx?.callGenericPopup) return '';

        const name = await ctx.callGenericPopup('新建文件夹', ctx.POPUP_TYPE.INPUT, '');
        if (!name || typeof name !== 'string') return '';

        const folder = {
            id: 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
            name: String(name).trim().slice(0, 80) || '新文件夹',
            order: settings.folders.length,
        };
        settings.folders.push(folder);
        save();
        render();
        return folder.id;
    }

    async function renameFolder(folderId) {
        const ctx = getCtx();
        const folder = settings.folders.find((f) => f.id === folderId);
        if (!folder || !ctx?.callGenericPopup) return;

        const name = await ctx.callGenericPopup('重命名文件夹', ctx.POPUP_TYPE.INPUT, folder.name);
        if (!name || typeof name !== 'string') return;

        folder.name = String(name).trim().slice(0, 80) || folder.name;
        save();
        render();
    }

    async function deleteFolder(folderId) {
        const ctx = getCtx();
        const folder = settings.folders.find((f) => f.id === folderId);
        if (!folder) return;

        if (ctx?.callGenericPopup) {
            const box = el('div', 'charta-confirm');
            box.appendChild(el('div', '', '删除文件夹「' + folder.name + '」？'));
            box.appendChild(el('div', '', '里面的人设会移到「未分组」，不会被删除。'));
            const result = await ctx.callGenericPopup(box, ctx.POPUP_TYPE.CONFIRM);
            if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
        }

        for (const [avatarId, target] of Object.entries(settings.assign)) {
            if (target === folderId) delete settings.assign[avatarId];
        }
        delete settings.collapsed[folderId];
        settings.folders = settings.folders.filter((f) => f.id !== folderId);
        settings.folders.forEach((f, i) => { f.order = i; });
        save();
        render();
    }

    async function renamePersona(avatarId) {
        const ctx = getCtx();
        if (!ctx?.callGenericPopup) return;

        const currentName = cache.names[avatarId] || stripExt(avatarId);
        const name = await ctx.callGenericPopup('重命名人设', ctx.POPUP_TYPE.INPUT, currentName);
        if (!name || typeof name !== 'string') return;

        const next = String(name).trim();
        if (!next || next === currentName) return;

        await runCommand('/persona-update persona=' + quote(avatarId) + ' name=' + quote(next));
        repaint(260);
    }

    async function duplicatePersona(avatarId) {
        await runCommand('/persona-duplicate persona=' + quote(avatarId));
        reload(400);
    }

    /**
     * 单独导出：沿用原生备份的文件结构，可直接用原生「恢复」导入。
     */
    function exportPersona(avatarId) {
        const ctx = getCtx();
        const pu = ctx?.powerUserSettings || {};
        const name = String(pu.personas?.[avatarId] || stripExt(avatarId));
        const descriptor = pu.persona_descriptions?.[avatarId] || {};

        const payload = {
            personas: { [avatarId]: name },
            persona_descriptions: { [avatarId]: JSON.parse(JSON.stringify(descriptor)) },
        };
        if (pu.default_persona === avatarId) payload.default_persona = avatarId;

        const stamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const safeName = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'persona';
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'persona_' + safeName + '_' + stamp + '.json';

        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast('已导出「' + name + '」，可用原生「恢复」导入。', '单独导出', 'success');
    }

    async function deletePersona(avatarId) {
        await runCommand('/persona-delete persona=' + quote(avatarId));
        reload(300);
    }

    async function editPersona(avatarId) {
        setView('edit');
        if (settings.current !== avatarId) selectPersona(avatarId);
        window.setTimeout(() => {
            const right = document.querySelector('#persona-management-block .persona_management_right_column');
            if (right) right.scrollTop = 0;
        }, 0);
    }

    /* ==================================================
       5. 渲染
       ================================================== */

    function sortedFolders() {
        return settings.folders
            .slice()
            .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    }

    function connectionLabel(avatarId) {
        const ctx = activeCtx || getCtx();
        const pu = ctx?.powerUserSettings || {};
        const characters = ctx?.characters || [];
        const groups = ctx?.groups || [];
        const parts = [];

        if (pu.default_persona === avatarId) parts.push('默认');

        const connections = pu.persona_descriptions?.[avatarId]?.connections || [];
        for (const connection of connections) {
            if (connection?.type === 'character') {
                const character = characters.find((c) => c?.avatar === connection.id);
                if (character) {
                    parts.push('角色 · ' + character.name);
                } else if (Date.now() < connectionSweepBlockedUntil) {
                    // 角色刚改名：原生 characters 列表还没换过来，先用新文件名占位。
                    parts.push('角色 · ' + stripExt(connection.id));
                }
                // 其余情况是失效连接：不再把旧角色名显示出来，稍后 sweepConnections 会删掉。
            } else if (connection?.type === 'group') {
                const group = groups.find((g) => String(g?.id) === String(connection.id));
                if (group) {
                    parts.push('群组 · ' + group.name);
                } else if (!groups.length) {
                    parts.push('群组 · ' + connection.id);
                }
            }
        }

        if (ctx?.chatMetadata?.persona === avatarId) parts.push('聊天');

        return parts.join(' ／ ');
    }

    /**
     * 快捷绑定：把这个人设绑到当前打开的角色（等同原生「角色」锁）。
     */
    function linkPersonaToCurrentCharacter(avatarId) {
        const ctx = getCtx();
        const character = ctx?.characters?.[ctx?.characterId];
        const personaName = cache.names[avatarId] || stripExt(avatarId);

        if (!character?.avatar) {
            toast('当前没有打开的角色，先开一个角色再绑定', '人设连接', 'warning');
            return;
        }

        const pu = ctx.powerUserSettings || {};
        const descriptor = pu.persona_descriptions?.[avatarId];
        if (!descriptor) {
            toast('这个人设还没有描述数据，先到编辑页保存一次', '人设连接', 'warning');
            return;
        }

        // 先把指向已删除角色 / 群组的旧连接清掉，避免「旧名 + 新名」同时出现。
        sweepConnections();

        descriptor.connections = Array.isArray(descriptor.connections) ? descriptor.connections : [];
        const already = descriptor.connections.some((c) => c?.type === 'character' && c?.id === character.avatar);
        if (already) {
            toast('「' + personaName + '」已经绑定到「' + character.name + '」', '人设连接', 'info');
            return;
        }

        // 与原生一致：不允许一人多绑时，先把同一角色从别的人设上摘掉
        if (!pu.persona_allow_multi_connections) {
            for (const [otherId, other] of Object.entries(pu.persona_descriptions || {})) {
                if (otherId === avatarId || !Array.isArray(other?.connections)) continue;
                other.connections = other.connections
                    .filter((c) => !(c?.type === 'character' && c?.id === character.avatar));
            }
        }

        descriptor.connections.push({ type: 'character', id: character.avatar });

        ctx.saveSettingsDebounced?.();
        repaint(0);
        toast('已把「' + personaName + '」绑定到「' + character.name + '」', '人设连接', 'success');
    }

    function matchesQuery(avatarId) {
        const query = cache.query.trim().toLowerCase();
        if (!query) return true;
        return (cache.hay[avatarId] || '').includes(query);
    }

    function buildUnits() {
        const folders = sortedFolders();
        const buckets = new Map();
        const folderNames = new Map();
        folders.forEach((f) => {
            buckets.set(f.id, []);
            folderNames.set(f.id, String(f.name || '').toLowerCase());
        });

        const query = cache.query.trim().toLowerCase();
        const searching = query.length > 0;
        const starred = [];
        const loose = [];

        for (const avatarId of cache.avatars) {
            const assigned = settings.assign[avatarId];
            const inFolder = !!assigned && buckets.has(assigned);

            // 搜索命中：人设本身 或 它所在的文件夹名
            const folderName = inFolder ? folderNames.get(assigned) : '';
            if (query && !matchesQuery(avatarId) && !(folderName && folderName.includes(query))) {
                continue;
            }

            if (settings.stars[avatarId] !== undefined) {
                starred.push(avatarId);
                continue;
            }
            if (inFolder) buckets.get(assigned).push(avatarId);
            else loose.push(avatarId);
        }

        const direction = settings.sort === 'desc' ? -1 : 1;
        const cmp = (a, b) => direction * String(cache.names[a] || a)
            .localeCompare(String(cache.names[b] || b), 'zh-Hans-CN');

        starred.sort((a, b) => (settings.stars[a] - settings.stars[b]) || cmp(a, b));
        loose.sort(cmp);
        buckets.forEach((arr) => arr.sort(cmp));

        const units = [];
        let renderable = 0;

        const addGroup = (key, rows, showEmpty) => {
            if (!rows.length && !showEmpty) return;
            const collapsedHere = !searching && settings.collapsed[key] === true;
            units.push({ type: 'header', key, count: rows.length, only: collapsedHere || rows.length === 0 });
            if (collapsedHere) return;
            rows.forEach((avatarId) => {
                units.push({ type: 'row', id: avatarId, key });
                renderable += 1;
            });
        };

        // 顺序：★ 置顶 → 未分组 → 自定义文件夹
        addGroup('star', starred, false);
        addGroup('none', loose, false);
        for (const folder of folders) addGroup(folder.id, buckets.get(folder.id) || [], !searching);

        const total = starred.length + loose.length
            + folders.reduce((sum, f) => sum + (buckets.get(f.id)?.length || 0), 0);

        return { units, total, renderable };
    }

    function makeHeader(key, count) {
        const isStar = key === 'star';
        const isLoose = key === 'none';
        const folder = isStar || isLoose ? null : settings.folders.find((f) => f.id === key);

        const header = el('div', 'charta-folder' + (isStar ? ' is-star' : '') + (isLoose ? ' is-loose' : ''));
        header.dataset.groupKey = key;

        const collapsed = settings.collapsed[key] === true;
        const caret = iconBtn('charta-icon-btn charta-caret', collapsed ? 'fa-caret-right' : 'fa-caret-down', '折叠 / 展开');
        caret.addEventListener('click', (event) => {
            event.stopPropagation();
            if (settings.collapsed[key] === true) delete settings.collapsed[key];
            else settings.collapsed[key] = true;
            save();
            render();
        });

        const mark = el('i', 'fa-solid ' + (isStar ? 'fa-star' : isLoose ? 'fa-layer-group' : 'fa-folder') + ' charta-folder-mark');
        const label = el('span', 'charta-folder-name', isStar ? '★ 置顶' : isLoose ? '未分组' : (folder?.name || '文件夹'));
        const badge = el('span', 'charta-folder-count', count);

        header.append(caret, mark, label, badge);

        if (folder) {
            const actions = el('div', 'charta-folder-actions');
            const rename = iconBtn('charta-icon-btn', 'fa-pen', '重命名文件夹');
            rename.addEventListener('click', (event) => {
                event.stopPropagation();
                renameFolder(folder.id);
            });
            const remove = iconBtn('charta-icon-btn is-danger', 'fa-trash-can', '删除文件夹');
            remove.addEventListener('click', (event) => {
                event.stopPropagation();
                deleteFolder(folder.id);
            });
            actions.append(rename, remove);
            header.appendChild(actions);
        }

        header.addEventListener('click', (event) => {
            if (event.target.closest('button')) return;
            if (settings.collapsed[key] === true) delete settings.collapsed[key];
            else settings.collapsed[key] = true;
            save();
            render();
        });

        header.addEventListener('dragover', (event) => {
            event.preventDefault();
            header.classList.add('is-drop');
        });
        header.addEventListener('dragleave', () => header.classList.remove('is-drop'));
        header.addEventListener('drop', (event) => {
            event.preventDefault();
            header.classList.remove('is-drop');
            const avatarId = event.dataTransfer?.getData('text/plain');
            if (!avatarId || !cache.avatars.includes(avatarId)) return;
            if (key === 'star') toggleStar(avatarId);
            else assignFolder(avatarId, key === 'none' ? '' : key);
        });

        return header;
    }

    function makeRow(avatarId) {
        const row = el('div', 'charta-row');
        row.dataset.avatarId = avatarId;
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.draggable = true;
        if (settings.current === avatarId) row.classList.add('is-current');

        const avatar = el('img', 'charta-ava');
        avatar.alt = '';
        avatar.loading = 'lazy';
        avatar.src = (activeCtx || getCtx())?.getThumbnailUrl?.('persona', avatarId)
            || '/User Avatars/' + encodeURIComponent(avatarId);

        const main = el('div', 'charta-main');
        const nameLine = el('div', 'charta-name-line');
        nameLine.appendChild(el('span', 'charta-name', cache.names[avatarId] || stripExt(avatarId)));
        if (cache.titles[avatarId]) {
            nameLine.appendChild(el('small', 'charta-title', cache.titles[avatarId]));
        }

        const link = connectionLabel(avatarId);
        const sub = el('div', 'charta-sub' + (link ? '' : ' is-empty'), '当前链接: ' + (link || '—'));

        main.append(nameLine, sub);

        const actions = el('div', 'charta-actions');

        const starred = settings.stars[avatarId] !== undefined;
        const star = iconBtn('charta-icon-btn charta-star' + (starred ? ' is-on' : ''), 'fa-star', starred ? '取消置顶' : '置顶');
        if (!starred) star.querySelector('i').className = 'fa-regular fa-star';
        star.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleStar(avatarId);
        });

        const linkBadge = el('span', 'charta-link' + (link ? ' is-on' : ''));
        linkBadge.title = link
            ? '当前连接：' + link + '\n点击可绑定到当前对话角色'
            : '未绑定，点击绑定到当前对话角色';
        linkBadge.appendChild(el('i', 'fa-solid fa-link'));
        linkBadge.addEventListener('click', (event) => {
            event.stopPropagation();
            linkPersonaToCurrentCharacter(avatarId);
        });

        const del = iconBtn('charta-icon-btn is-danger charta-del', 'fa-skull', '删除人设');
        del.addEventListener('click', (event) => {
            event.stopPropagation();
            deletePersona(avatarId);
        });

        const more = iconBtn('charta-icon-btn charta-more', 'fa-ellipsis', '更多');
        more.addEventListener('click', (event) => {
            event.stopPropagation();
            openMenu(more, buildRowMenu(avatarId, more));
        });

        actions.append(star, linkBadge, del, more);
        row.append(avatar, main, actions);

        row.addEventListener('click', () => selectPersona(avatarId));
        row.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            selectPersona(avatarId);
        });
        row.addEventListener('dragstart', (event) => {
            event.dataTransfer?.setData('text/plain', avatarId);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
            row.classList.add('is-dragging');
        });
        row.addEventListener('dragend', () => row.classList.remove('is-dragging'));

        return row;
    }

    function buildRowMenu(avatarId, anchor) {
        const moveItems = [
            {
                label: '＋ 新建文件夹并移入', run: async () => {
                    const id = await createFolder();
                    if (id) assignFolder(avatarId, id);
                },
            },
            null,
            { label: '未分组', run: () => assignFolder(avatarId, '') },
            ...sortedFolders().map((folder) => ({
                label: '移到「' + folder.name + '」',
                run: () => assignFolder(avatarId, folder.id),
            })),
        ];

        return [
            { label: '移动到文件夹…', run: () => openMenu(anchor, moveItems) },
            { label: '重命名', run: () => renamePersona(avatarId) },
            { label: '复制一份', run: () => duplicatePersona(avatarId) },
            { label: '单独导出', run: () => exportPersona(avatarId) },
            { label: '进入编辑', run: () => editPersona(avatarId) },
        ];
    }

    let openMenuNode = null;

    function closeMenus() {
        if (openMenuNode) {
            openMenuNode.remove();
            openMenuNode = null;
        }
    }

    function openMenu(anchor, items) {
        closeMenus();
        if (!anchor) return;

        const menu = el('div', 'charta-menu');
        items.forEach((item) => {
            if (!item) {
                menu.appendChild(el('div', 'charta-menu-sep'));
                return;
            }
            const button = el('button', 'charta-menu-item' + (item.danger ? ' is-danger' : ''), item.label);
            button.type = 'button';
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                event.preventDefault();
                closeMenus();
                try {
                    item.run();
                } catch (error) {
                    console.warn(LOG, error);
                }
            });
            menu.appendChild(button);
        });

        // 必须挂在抽屉内部：酒馆在 html 上监听 touchstart/mousedown，
        // 点到 .openDrawer 之外就会把整个抽屉收起来 —— 菜单挂 body 上会被当成「点外面」。
        const host = panel() || document.body;
        host.appendChild(menu);
        openMenuNode = menu;

        // 双保险：别让按下事件冒到 html
        const swallow = (event) => event.stopPropagation();
        menu.addEventListener('touchstart', swallow, { passive: true });
        menu.addEventListener('mousedown', swallow);

        const hostRect = host.getBoundingClientRect();
        const rect = anchor.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();

        let left = rect.right - hostRect.left - menuRect.width;
        let top = rect.bottom - hostRect.top + 4;

        if (top + menuRect.height > hostRect.height - 6) {
            top = rect.top - hostRect.top - menuRect.height - 4;
        }

        const maxLeft = hostRect.width - menuRect.width - 6;
        const maxTop = hostRect.height - menuRect.height - 6;

        menu.style.left = Math.min(Math.max(6, left), Math.max(6, maxLeft)) + 'px';
        menu.style.top = Math.min(Math.max(6, top), Math.max(6, maxTop)) + 'px';
    }

    const PAGE_SIZE = 60;
    let renderLimit = PAGE_SIZE;
    let lastRowTotal = 0;
    // 列表是独立滚动容器。重绘会清空子节点，所以要把滚动位置记在 JS 里再恢复。
    let listScrollTop = 0;
    let listScrollLeft = 0;

    function render({ keepScroll = true } = {}) {
        if (!bound) return;
        const list = byId('charta-persona-list');
        const pager = byId('charta-pager');
        const countNode = byId('charta-count');
        if (!list) return;

        if (!keepScroll) {
            listScrollTop = 0;
            listScrollLeft = 0;
        } else if (list.clientHeight > 0) {
            // 可见时以 DOM 当前值为准；隐藏时沿用上次记录的值。
            listScrollTop = list.scrollTop;
            listScrollLeft = list.scrollLeft;
        }

        activeCtx = getCtx();

        const { units, total, renderable } = buildUnits();

        const fragment = document.createDocumentFragment();
        let pendingHeader = null;
        let rendered = 0;
        let truncated = false;

        for (const unit of units) {
            if (unit.type === 'header') {
                if (unit.only) {
                    fragment.appendChild(makeHeader(unit.key, unit.count));
                    pendingHeader = null;
                } else {
                    pendingHeader = unit;
                }
                continue;
            }

            if (rendered >= renderLimit) {
                truncated = true;
                break;
            }

            if (pendingHeader) {
                fragment.appendChild(makeHeader(pendingHeader.key, pendingHeader.count));
                pendingHeader = null;
            }

            fragment.appendChild(makeRow(unit.id));
            rendered += 1;
        }

        lastRowTotal = renderable;

        if (truncated) {
            fragment.appendChild(el('div', 'charta-load-hint', '继续向下滚动加载其余 ' + (renderable - rendered) + ' 个'));
        } else if (renderable > PAGE_SIZE) {
            fragment.appendChild(el('div', 'charta-load-hint is-done', '已全部显示（共 ' + total + ' 个）'));
        }

        activeCtx = null;

        list.textContent = '';
        list.appendChild(fragment);
        list.classList.toggle('charta-grid', settings.grid === true);

        // 恢复滚动位置（内容变短时浏览器会自动夹到最大值）。
        // 搜索 / 排序明确要求回顶部时，这里把滚动条复位。
        if (!keepScroll) {
            list.scrollTop = 0;
            list.scrollLeft = 0;
        } else if (listScrollTop || listScrollLeft) {
            list.scrollTop = listScrollTop;
            list.scrollLeft = listScrollLeft;
        }

        if (countNode) countNode.textContent = '共 ' + total + ' 个';
        if (pager) pager.textContent = cache.query.trim() ? '匹配 ' + total + ' 个' : '';
        pager?.classList.toggle('is-hidden', !cache.query.trim());

        if (!cache.avatars.length) {
            list.appendChild(el('div', 'charta-empty-note', '还没有任何人设，点上面的「创建」开始。'));
        }
    }

    /* ==================================================
       6. 视图切换（窄屏两屏）
       ================================================== */

    function titleNode() {
        return panel()?.querySelector('.flex-container h3 span') || null;
    }

    function setView(view) {
        const root = panel();
        if (!root) return;

        const edit = view === 'edit';
        const narrow = isNarrow();
        root.dataset.chartaView = edit ? 'edit' : 'list';

        const left = root.querySelector('.persona_management_left_column');
        const right = root.querySelector('.persona_management_right_column');

        // 显隐直接内联 !important：不依赖样式表命中，也不怕 CSS 被缓存
        if (narrow) {
            left?.style.setProperty('display', edit ? 'none' : 'flex', 'important');
            right?.style.setProperty('display', edit ? 'block' : 'none', 'important');
        } else {
            left?.style.removeProperty('display');
            right?.style.removeProperty('display');
        }

        const title = titleNode();
        if (title) title.textContent = edit && narrow ? TITLE_EDIT : TITLE_LIST;

        const target = edit ? right : left;
        if (target) target.scrollTop = 0;

        // 从编辑页返回列表时，把列表自己的滚动位置恢复回去。
        if (!edit) {
            const list = byId('charta-persona-list');
            if (list) {
                list.scrollTop = listScrollTop;
                list.scrollLeft = listScrollLeft;
            }
        }
    }

    function currentView() {
        return panel()?.dataset.chartaView === 'edit' ? 'edit' : 'list';
    }

    function syncNarrowClass() {
        const head = document.body || document.documentElement;
        head.classList.toggle('charta-narrow', isNarrow());
        setView(currentView());
        updateVersionBadge();
    }

    /** 标题旁的小标签：版本 + 当前模式，用来确认手机加载的是哪一版 */
    function updateVersionBadge() {
        const badge = document.querySelector('.charta-ver');
        if (!badge) return;

        const narrow = isNarrow();
        badge.textContent = 'v' + VERSION + ' · ' + (narrow ? '双屏' : '单页');
        badge.title = [
            'ST-Charta v' + VERSION,
            '模式 ' + (narrow ? '双屏' : '单页'),
            '宽 ' + window.innerWidth,
            'coarse ' + coarseMedia.matches,
            'touch ' + (navigator.maxTouchPoints || 0),
        ].join('｜');
    }

    /* ==================================================
       7. DOM 接管
       ================================================== */

    function injectChrome(left, right) {
        const nativePager = byId('persona_pagination_container');
        if (nativePager && !byId('charta-pager')) {
            const pager = el('div', 'charta-pager is-hidden');
            pager.id = 'charta-pager';
            nativePager.parentElement.insertBefore(pager, nativePager);
        }

        const heading = panel()?.querySelector('.flex-container h3');
        if (heading && !heading.parentElement.querySelector('.charta-ver')) {
            const version = el('span', 'charta-ver');
            heading.insertAdjacentElement('afterend', version);
            updateVersionBadge();
        }

        const nativeList = byId('user_avatar_block');
        if (nativeList && !byId('charta-list-root')) {
            const root = el('div', 'charta-list-root');
            root.id = 'charta-list-root';

            const head = el('div', 'charta-head');

            const newFolder = el('button', 'charta-head-btn');
            newFolder.type = 'button';
            newFolder.title = '新建文件夹';
            newFolder.appendChild(el('i', 'fa-solid fa-folder-plus'));
            newFolder.appendChild(el('span', '', '文件夹'));
            newFolder.addEventListener('click', () => createFolder());

            const count = el('span', 'charta-count');
            count.id = 'charta-count';

            const collapseAll = el('button', 'charta-head-btn charta-head-collapse');
            collapseAll.type = 'button';
            collapseAll.title = '折叠全部 / 展开全部';
            collapseAll.appendChild(el('i', 'fa-solid fa-compress'));
            collapseAll.addEventListener('click', () => {
                const keys = ['star', 'none', ...settings.folders.map((f) => f.id)];
                const anyOpen = keys.some((key) => settings.collapsed[key] !== true);
                keys.forEach((key) => {
                    if (anyOpen) settings.collapsed[key] = true;
                    else delete settings.collapsed[key];
                });
                save();
                render();
            });

            head.append(newFolder, count, collapseAll);

            const list = el('div', 'charta-persona-list');
            list.id = 'charta-persona-list';

            // 无限滚动：滚到底部再追加一批（不打断分组、不用页码）
            let loadingMore = false;
            list.addEventListener('scroll', () => {
                listScrollTop = list.scrollTop;
                listScrollLeft = list.scrollLeft;

                if (loadingMore) return;
                if (list.scrollTop + list.clientHeight < list.scrollHeight - 160) return;
                if (renderLimit >= lastRowTotal) return;

                loadingMore = true;
                const anchorTop = list.scrollTop;
                renderLimit += PAGE_SIZE;
                render();
                list.scrollTop = anchorTop;
                window.setTimeout(() => { loadingMore = false; }, 0);
            });

            root.append(head, list);
            nativeList.parentElement.insertBefore(root, nativeList);
        }

        if (!byId('charta-back')) {
            const back = el('div', 'charta-back');
            back.id = 'charta-back';
            back.setAttribute('role', 'button');
            back.tabIndex = 0;
            back.appendChild(el('i', 'fa-solid fa-chevron-left'));
            back.appendChild(el('span', '', '返回列表'));
            back.addEventListener('click', () => {
                setView('list');
                repaint(0);
            });
            back.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setView('list');
                }
            });
            right.insertBefore(back, right.firstChild);
        }
    }

    /**
     * 原生右列不是所有操作都会发事件（例如「角色 / 聊天 / 默认」连接切换只改内存，
     * 不发 PERSONA_UPDATED），所以要直接观察原生编辑器。
     *
     * 注意：这里只观察几个具体的原生节点，绝不观察 body / 文档，也不观察我们自己渲染的
     * 列表；而 repaint() 只写 #charta-persona-list，不写这些原生节点，所以不会形成
     * 「观察 -> 刷新 -> 再触发观察」的死循环。
     */
    const watchedNodes = new WeakSet();

    function watchNativePersonaEditor() {
        const right = panel()?.querySelector('.persona_management_right_column');
        if (!right) return;

        const kick = debounce(() => repaint(80), 180);

        // 描述 / 位置 / 深度输入：原生会发 PERSONA_UPDATED，但这里再兜一层。
        if (right.dataset.chartaInput !== '1') {
            right.dataset.chartaInput = '1';
            right.addEventListener('input', kick, true);
            right.addEventListener('change', kick, true);
        }

        if (typeof MutationObserver !== 'function') return;

        const observe = (node, options) => {
            if (!node || watchedNodes.has(node)) return;
            watchedNodes.add(node);
            const observer = new MutationObserver(() => kick());
            observer.observe(node, options);
        };

        // 只盯会出现在列表里的信息：名字、连接列表、连接按钮状态。
        observe(byId('your_name'), { childList: true, characterData: true, subtree: true });
        observe(byId('persona_connections_list'), { childList: true, characterData: true, subtree: true });
        observe(byId('persona_connections_info_block'), { childList: true, characterData: true, subtree: true });
        observe(byId('persona_connections_buttons'), {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    function takeoverControls() {
        const ctx = getCtx();

        const search = byId('persona_search_bar');
        if (search && !search.dataset.chartaBound) {
            search.dataset.chartaBound = '1';
            search.addEventListener('input', debounce(() => {
                cache.query = String(search.value || '');
                renderLimit = PAGE_SIZE;
                render({ keepScroll: false });
                // 原生 verifyPersonaSearchSortRule 可能把下拉切成 Search，稍后复原
                window.setTimeout(() => {
                    const select = byId('persona_sort_order');
                    if (select && select.value === 'search') select.value = settings.sort;
                }, 420);
            }, 180));
        }

        const sort = byId('persona_sort_order');
        if (sort && !sort.dataset.chartaBound) {
            sort.dataset.chartaBound = '1';
            sort.value = settings.sort;
            sort.addEventListener('input', () => {
                settings.sort = sort.value === 'desc' ? 'desc' : 'asc';
                save();
                renderLimit = PAGE_SIZE;
                render({ keepScroll: false });
            });
        }

        const grid = byId('persona_grid_toggle');
        if (grid && !grid.dataset.chartaBound) {
            grid.dataset.chartaBound = '1';
            grid.addEventListener('click', () => {
                window.setTimeout(() => {
                    const stored = ctx?.accountStorage?.getItem('Personas_GridView') === 'true';
                    if (stored === settings.grid) {
                        settings.grid = !settings.grid;
                        ctx?.accountStorage?.setItem('Personas_GridView', String(settings.grid));
                    } else {
                        settings.grid = stored;
                    }
                    save();
                    render();
                }, 0);
            });
        }
    }

    /* ==================================================
       8. 启动
       ================================================== */

    function bindEvents() {
        const ctx = getCtx();
        const events = ctx?.eventTypes;
        const source = ctx?.eventSource;

        if (source?.on && events) {
            const on = (name, handler) => {
                if (events[name]) source.on(events[name], handler);
            };

            on('PERSONA_CHANGED', (avatarId) => {
                setCurrent(avatarId);
                repaint(0);
            });
            on('PERSONA_CREATED', () => reload(200));
            on('PERSONA_RENAMED', () => reload(200));
            on('PERSONA_DELETED', () => reload(200));
            on('PERSONA_UPDATED', () => repaint(200));
            on('CHARACTER_RENAMED', (oldAvatar, newAvatar) => {
                const migrated = migrateCharacterConnections(oldAvatar, newAvatar);

                if (migrated) {
                    // 等原生 getCharacters() 把角色列表换成新文件名后再做一次清理。
                    connectionSweepBlockedUntil = Date.now() + 5000;
                    window.setTimeout(() => {
                        connectionSweepBlockedUntil = 0;
                        reload(0);
                    }, 5000);
                }

                reload(150);
            });
            on('CHARACTER_DELETED', () => reload(400));
            on('CHARACTER_EDITED', () => repaint(200));
            on('GROUP_UPDATED', () => reload(200));
            on('CHAT_CHANGED', () => repaint(200));
            on('SETTINGS_LOADED', () => {
                loadSettings();
                applySortValue();
                reload(120);
            });
            on('APP_READY', () => reload(200));
        }

        const button = byId('persona-management-button');
        button?.addEventListener('click', (event) => {
            if (event.target.closest('#PersonaManagement')) return;
            window.setTimeout(() => {
                if (!panel()?.classList.contains('openDrawer')) return;
                setView('list');
                reload(60);
            }, 0);
        });

        // 换头像会打开系统相册；相册开着时暂停一切列表重绘，避免移动端浏览器把相册关掉。
        document.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('#persona_set_image_button, #avatar_upload_file, #user_avatar_block .avatar_upload')) {
                pauseRefreshForPicker(5000);
            }
        }, true);

        document.addEventListener('click', (event) => {
            if (!openMenuNode) return;
            if (event.target.closest('.charta-menu')) return;
            if (event.target.closest('.charta-more')) return;
            closeMenus();
        });

        // 收起菜单：点外部 / 真滑动 / Esc。
        // 不能监听全局 scroll，也不能见 touchmove 就关——轻点时的 1-2px 抖动
        // 会把菜单关掉，点击就落到下面的卡片上了。
        let menuTouchStart = null;

        document.addEventListener('touchstart', (event) => {
            const touch = event.touches?.[0];
            menuTouchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
        }, { passive: true, capture: true });

        document.addEventListener('touchmove', (event) => {
            if (!openMenuNode || !menuTouchStart) return;
            const touch = event.touches?.[0];
            if (!touch) return;
            const dx = Math.abs(touch.clientX - menuTouchStart.x);
            const dy = Math.abs(touch.clientY - menuTouchStart.y);
            if (dx > 10 || dy > 10) {
                closeMenus();
                menuTouchStart = null;
            }
        }, { passive: true, capture: true });

        document.addEventListener('wheel', (event) => {
            if (!openMenuNode) return;
            if (event.target instanceof Element && event.target.closest('.charta-menu')) return;
            closeMenus();
        }, { passive: true });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeMenus();
        });

        window.addEventListener('resize', () => syncNarrowClass());

        if (typeof narrowMedia.addEventListener === 'function') {
            narrowMedia.addEventListener('change', () => {
                closeMenus();
                syncNarrowClass();
            });
        }
    }

    function applySortValue() {
        const sort = byId('persona_sort_order');
        if (sort && sort.value !== settings.sort) sort.value = settings.sort;
    }

    function boot() {
        const ctx = getCtx();
        if (!ctx || typeof ctx.saveSettingsDebounced !== 'function') return false;

        const block = byId('persona-management-block');
        const left = block?.querySelector('.persona_management_left_column');
        const right = block?.querySelector('.persona_management_right_column');
        const nativeList = byId('user_avatar_block');

        if (!block || !left || !right || !nativeList) {
            console.warn(LOG, '未找到原生用户设定面板锚点，放弃接管');
            return true;
        }

        if (!bound) {
            loadSettings();
            injectChrome(left, right);
            watchNativePersonaEditor();
            takeoverControls();
            bindEvents();
            syncNarrowClass();
            setView('list');
            applySortValue();
            document.body.classList.add('charta-on');
            bound = true;
            console.log(LOG + ' v' + VERSION + ' 已接管用户设定面板');
        }

        reload(60);
        return true;
    }

    function init() {
        let attempts = 0;

        const tick = () => {
            attempts += 1;
            if (boot()) return;
            if (attempts >= 60) {
                console.warn(LOG, '等待酒馆上下文超时，已停止');
                return;
            }
            setTimeout(tick, 250);
        };

        tick();
    }

    if (globalThis.__stChartaLoaded) return;
    globalThis.__stChartaLoaded = true;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
