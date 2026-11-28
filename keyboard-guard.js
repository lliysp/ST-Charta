// @ts-nocheck
/* ==================================================
   ST-Charta — 移动端键盘辅助（MVP）
   --------------------------------------------------
   处理两条已确认路径：
     1) getChat() 在 CHAT_LOADED 后约 200ms 自动聚焦 #send_textarea
     2) displayPastChats() 在聊天管理界面打开后约 200ms 自动聚焦 #select_chat_search

   目标：触摸设备上，用户没有主动操作输入框时，取消这次自动焦点。
   不拦截全局 focus/focusin，不修改输入值/选区/属性，不处理其他来源。
   ================================================== */

const LOG = '[ST-Charta:keyboard-guard]';
const INSTALLED = Symbol.for('st-charta.keyboard-guard.installed');

const OBSERVE_MS = 1200;
const SEND_TEXTAREA = '#send_textarea';
const FOCUS_KEEPING = '#send_but, #option_regenerate, #option_continue, #mes_continue, #mes_impersonate';

const SEARCH_POPUP = '#select_chat_popup';
const SEARCH_INPUT = '#select_chat_search';
const SEARCH_INTENT_MS = 1000;

/**
 * 只在“主输入方式是触摸、且没有 hover”的设备启用。
 * 触摸屏笔记本（同时有鼠标）保持桌面行为。
 * @returns {boolean}
 */
function isTouchDevice() {
    return navigator.maxTouchPoints > 0
        || (typeof window.matchMedia === 'function'
            && window.matchMedia('(pointer: coarse)').matches);
}

/**
 * @param {unknown} element
 * @returns {boolean}
 */
function isEditable(element) {
    if (!(element instanceof Element)) return false;
    if (element.isContentEditable) return true;
    return element.tagName === 'INPUT'
        || element.tagName === 'TEXTAREA'
        || element.tagName === 'SELECT';
}

export function install() {
    if (globalThis[INSTALLED]) return;
    globalThis[INSTALLED] = true;

    if (!isTouchDevice()) {
        console.debug(LOG, '非触摸设备，跳过安装');
        return;
    }

    /**
     * 当前观察窗口。同一时间只允许一个，避免连续 CHAT_LOADED 叠加监听。
     * @type {{ token: number, timer: number, element: HTMLElement, clickHandler: (event: MouseEvent) => void, userIntent: boolean } | null}
     */
    let active = null;
    let generation = 0;

    let searchGuardBound = false;
    let searchBindAttempts = 0;
    let searchIntentAt = 0;
    let searchBlurTimer = 0;

    function markIntent() {
        if (active) active.userIntent = true;
    }

    function disarm() {
        if (!active) return;
        window.clearTimeout(active.timer);
        active.element.removeEventListener('click', active.clickHandler, true);
        active = null;
    }

    function arm() {
        disarm();

        const textarea = document.querySelector(SEND_TEXTAREA);
        if (!(textarea instanceof HTMLElement)) return;

        // 原生逻辑在 activeElement 已是可见输入框时会直接返回。
        // 这里同样跳过，避免把用户已有的焦点误判成自动焦点。
        if (isEditable(document.activeElement)) return;

        const token = ++generation;

        const clickHandler = (event) => {
            console.log('[KeyboardGuard] click captured:', event.isTrusted);
            if (!active || active.token !== token) return;

            // 真实用户点击是 trusted；原生 .trigger('click') 是脚本事件。
            // 只有明确 isTrusted === false 才继续；不支持该属性的环境一律不处理。
            if (event.isTrusted !== false) {
                markIntent();
                return;
            }

            if (active.userIntent) return;

            // 原生 .trigger('click') 的下一步就是 .trigger('focus')，仍在同一个同步任务里。
            // Blink 是在 focus() 内部、focus 事件派发完之后才发出软键盘显示请求的，
            // 所以必须在 focus 事件里同步 blur；setTimeout / 微任务都发生在那之后，
            // 只能和已经发出的显示请求赛跑（偶发闪现就是这么来的）。
            const blurOnFocus = () => {
                if (!active || active.token !== token) return;
                if (active.userIntent) return;
                if (document.visibilityState !== 'visible') return;
                if (document.querySelector('dialog[open]')) return;
                if (document.activeElement !== textarea) return;

                textarea.blur();
                disarm();
            };

            // 用冒泡阶段（默认）：让酒馆自己的 #send_textarea focus 处理器先跑，
            // 再由我们 blur，这样它的 blur 处理器能把 chatbarInFocus 正确复位。
            textarea.addEventListener('focus', blurOnFocus);
            // 原生链在本任务内完成；下一微任务就摘掉，避免影响之后真正的用户聚焦。
            queueMicrotask(() => textarea.removeEventListener('focus', blurOnFocus));
        };

        active = {
            token,
            timer: window.setTimeout(disarm, OBSERVE_MS),
            element: textarea,
            clickHandler,
            userIntent: false,
        };

        // 只监听目标元素本身，不监听 document 的 focus/focusin。
        textarea.addEventListener('click', clickHandler, true);
    }

    /**
     * 聊天管理弹窗内的搜索框：只记录“用户主动碰过搜索框”的证据。
     * 监听挂在弹窗容器上，输入框即使后续被替换也能继续收到事件。
     * @param {Event} event
     */
    function onSearchPointerDown(event) {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (!target.closest(SEARCH_INPUT)) return;

        searchIntentAt = Date.now();

        if (searchBlurTimer) {
            window.clearTimeout(searchBlurTimer);
            searchBlurTimer = 0;
        }
    }

    /**
     * 只处理 #select_chat_search 上由脚本触发的 click。
     * 真实用户点击（isTrusted !== false）一律放行，不 blur。
     * @param {MouseEvent} event
     */
    function onSearchClick(event) {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const search = target.closest(SEARCH_INPUT);
        if (!search) return;

        // 真实用户点击，或环境不支持 isTrusted：记录意图，绝不 blur。
        if (event.isTrusted !== false) {
            searchIntentAt = Date.now();
            return;
        }

        // 原生 .trigger('click') 是脚本事件。
        // 如果搜索框已经被用户聚焦，不要抢走焦点。
        if (document.activeElement === search) return;

        if (searchBlurTimer) {
            window.clearTimeout(searchBlurTimer);
            searchBlurTimer = 0;
        }

        // 等 trigger('click').trigger('focus').trigger('select') 同步链走完。
        searchBlurTimer = window.setTimeout(() => {
            searchBlurTimer = 0;

            if (Date.now() - searchIntentAt < SEARCH_INTENT_MS) return;
            if (document.visibilityState !== 'visible') return;
            if (document.querySelector('dialog[open]')) return;
            if (document.activeElement !== search) return;

            search.blur();
        }, 0);
    }

    /**
     * 把监听挂到稳定的弹窗容器上，而不是搜索框本身。
     * 容器尚未出现时做有限次重试，避免留下永久 observer/timer。
     */
    function bindSearchGuard() {
        if (searchGuardBound) return;

        const container = document.querySelector(SEARCH_POPUP);
        if (container) {
            searchGuardBound = true;
            container.addEventListener('click', onSearchClick, true);
            container.addEventListener('pointerdown', onSearchPointerDown, { capture: true, passive: true });
            container.addEventListener('touchstart', onSearchPointerDown, { capture: true, passive: true });
            return;
        }

        searchBindAttempts += 1;
        if (searchBindAttempts >= 40) return;
        window.setTimeout(bindSearchGuard, 250);
    }

    // 只记录“用户主动输入”的证据；不 preventDefault，不改变焦点。
    const pointerIntent = (event) => {
        if (!active) return;
        const target = event.target;
        if (!(target instanceof Element)) return;

        if (isEditable(target) || target.closest(FOCUS_KEEPING)) {
            markIntent();
        }
    };

    // 键盘/输入法说明用户正在操作，直接取消本次抑制。
    const typingIntent = () => {
        if (active) markIntent();
    };

    document.addEventListener('pointerdown', pointerIntent, true);
    document.addEventListener('touchstart', pointerIntent, { capture: true, passive: true });
    document.addEventListener('keydown', typingIntent, true);
    document.addEventListener('beforeinput', typingIntent, true);
    document.addEventListener('compositionstart', typingIntent, true);

    bindSearchGuard();

    let attempts = 0;
    const connect = () => {
        const ctx = globalThis.SillyTavern?.getContext?.();
        const source = ctx?.eventSource;
        const chatLoaded = ctx?.eventTypes?.CHAT_LOADED;

        if (source?.on && chatLoaded) {
            source.on(chatLoaded, arm);
            console.debug(LOG, '已安装');
            return;
        }

        attempts += 1;
        if (attempts >= 60) {
            console.warn(LOG, '等待酒馆事件上下文超时，未安装');
            return;
        }

        window.setTimeout(connect, 250);
    };

    connect();
}
