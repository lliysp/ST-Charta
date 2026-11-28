// @ts-nocheck
/* ==================================================
   ST-Charta — 移动端键盘辅助（MVP）
   --------------------------------------------------
   只处理一条已确认路径：
     SillyTavern 原生 getChat() 在 CHAT_LOADED 后约 200ms
     执行 $('#send_textarea').trigger('click').trigger('focus')

   目标：触摸设备上，用户没有主动操作输入框时，取消这次自动焦点。
   不拦截全局 focus/focusin，不修改输入值/选区/属性，不处理其他来源。
   ================================================== */

const LOG = '[ST-Charta:keyboard-guard]';
const INSTALLED = Symbol.for('st-charta.keyboard-guard.installed');

const OBSERVE_MS = 1200;
const SEND_TEXTAREA = '#send_textarea';
const FOCUS_KEEPING = '#send_but, #option_regenerate, #option_continue, #mes_continue, #mes_impersonate';

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
            if (!active || active.token !== token) return;

            // 真实用户点击是 trusted；原生 .trigger('click') 是脚本事件。
            // 只有明确 isTrusted === false 才继续；不支持该属性的环境一律不处理。
            if (event.isTrusted !== false) {
                markIntent();
                return;
            }

            if (active.userIntent) return;

            // 让 trigger('click').trigger('focus') 的同步调用链先走完，
            // 再确认焦点是否真的落在 #send_textarea 上。
            window.setTimeout(() => {
                if (!active || active.token !== token) return;
                if (active.userIntent) return;
                if (document.visibilityState !== 'visible') return;
                if (document.querySelector('dialog[open]')) return;
                if (document.activeElement !== textarea) return;

                textarea.blur();
                disarm();
            }, 0);
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
