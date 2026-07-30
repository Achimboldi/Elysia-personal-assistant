const { ipcRenderer } = require('electron');

let currentMemoId = null;
let isPinned = false;
let isCollapsed = false;
let isEditMode = false;
let currentFontSize = 14;
let isAltPressed = false;
let lastUsedColor = '#fff9c4';
let savedScrollTop = 0;

let stickyQuill = null; // ★ 富文本编辑器实例（与备忘录一致的 Quill）

let saveMemoDebounceTimer = null;
const SAVE_DEBOUNCE_DELAY = 500;

// 滚动条拖拽状态
let isDragging = false;
let startY = 0;
let startScrollTop = 0;
let scrollHideTimer = null;
let scrollbarThumb = null;

/**
 * ★ 返回当前用于滚动/显示的内容元素：
 *   优先返回 Quill 编辑器（.ql-editor），否则回退到富文本显示 div。
 */
function getActiveContentEl() {
    if (stickyQuill && stickyQuill.root) {
        const container = document.getElementById('stickyEditorContainer');
        if (container && container.style.display !== 'none') {
            return stickyQuill.root;
        }
    }
    return document.getElementById('stickyContentDisplay');
}

function initColorFromStorage() {
    try {
        const savedColor = localStorage.getItem('stickyNoteLastColor');
        if (savedColor) {
            lastUsedColor = savedColor;
            applyColor(savedColor);
        }
    } catch (e) {
        console.log('无法读取保存的颜色');
    }
}

/**
 * ★ 初始化与备忘录完全一致的 Quill 富文本编辑器。
 * 支持：Markdown 快捷输入、分割线、表格/分割线 blot 渲染、图片粘贴、链接点击打开、
 * 以及加粗/斜体/下划线/标题/列表/引用/代码等富文本格式（与备忘录同一套能力）。
 */
function initStickyQuill(initialHtml, initialText) {
    const editorHost = document.getElementById('stickyQuillEditor');
    const displayEl = document.getElementById('stickyContentDisplay');
    const containerEl = document.getElementById('stickyEditorContainer');

    // ★ 兜底：Quill 不可用（如本地依赖缺失）时，用 div 渲染富文本，至少保证「查看」能力
    if (!editorHost || !window.Quill) {
        displayEl.innerHTML = initialHtml || (initialText ? initialText.replace(/\n/g, '<br>') : '');
        displayEl.style.display = 'block';
        containerEl.style.display = 'none';
        return;
    }

    // ── 注册自定义 Blot（与备忘录一致）：分割线 + 表格（保证备忘录里带表格/分割线的内容正确显示）──
    try {
        if (!window.__stickyDividerRegistered) {
            const BlockEmbed = window.Quill.import('blots/block/embed');
            class DividerBlot extends BlockEmbed {}
            DividerBlot.blotName = 'divider';
            DividerBlot.tagName = 'hr';
            window.Quill.register(DividerBlot);
            window.__stickyDividerRegistered = true;
        }
    } catch (e) {
        console.warn('注册 Divider Blot 失败:', e);
    }

    try {
        if (!window.__stickyTableRegistered) {
            const BlockEmbed = window.Quill.import('blots/block/embed');
            class TableContainer extends BlockEmbed {
                static create(value) {
                    const domNode = document.createElement('table');
                    domNode.classList.add('memo-table');
                    if (typeof value === 'string' && value.includes('<table')) {
                        try {
                            const tmp = document.createElement('div');
                            tmp.innerHTML = value;
                            const src = tmp.querySelector('table');
                            if (src) {
                                domNode.className = src.className || 'memo-table';
                                domNode.innerHTML = src.innerHTML;
                            }
                        } catch (_) { /* 回退空表 */ }
                    }
                    return domNode;
                }
                static value(domNode) { return domNode.outerHTML; }
                constructor(domNode) {
                    super(domNode);
                    try {
                        if (this.contentNode && this.contentNode.parentNode === this.domNode) {
                            while (this.contentNode.firstChild) {
                                this.domNode.insertBefore(this.contentNode.firstChild, this.contentNode);
                            }
                            this.contentNode.parentNode.removeChild(this.contentNode);
                        }
                        [this.leftGuard, this.rightGuard].forEach(g => {
                            if (g && g.parentNode === this.domNode) this.domNode.removeChild(g);
                        });
                    } catch (_) { /* 解包失败不影响兜底 */ }
                }
                update() {}
                optimize() {}
            }
            TableContainer.blotName = 'table-container';
            TableContainer.tagName = 'table';
            window.Quill.register(TableContainer, true);
            window.__stickyTableRegistered = true;
        }
    } catch (e) {
        console.warn('注册 Table Blot 失败:', e);
    }

    // ── 创建 Quill（toolbar:false，与备忘录一致：靠 Markdown 快捷键 + 粘贴实现富文本）──
    const quill = new window.Quill(editorHost, {
        theme: 'snow',
        placeholder: '在这里记录你的想法...（支持 Markdown：# 标题、- 列表、> 引用、``` 代码、**粗体** 等）',
        modules: {
            toolbar: false
        }
    });
    stickyQuill = quill;

    // ── 填充已有内容（优先 htmlContent，否则纯文本）──
    try {
        if (initialHtml && initialHtml.trim()) {
            quill.setText('');
            quill.clipboard.dangerouslyPasteHTML(0, initialHtml, 'api');
        } else if (initialText && initialText.trim()) {
            quill.setText(initialText);
        }
    } catch (e) {
        console.warn('加载富文本内容失败，回退 innerHTML:', e);
        try { quill.root.innerHTML = initialHtml || ''; } catch (_) {}
    }

    // ── 点击链接用系统浏览器打开 ──
    quill.root.addEventListener('click', (e) => {
        const linkEl = e.target.closest('a[href]');
        if (linkEl) {
            e.preventDefault();
            const url = linkEl.getAttribute('href');
            if (url && /^https?:\/\//i.test(url)) {
                try { require('electron').shell.openExternal(url); } catch (_) {}
            }
        }
    });

    // ── 图片粘贴 + 纯 URL 自动转链接 ──
    quill.root.addEventListener('paste', (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (items) {
            for (const item of items) {
                if (item.type.indexOf('image') !== -1) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (file) handleStickyPasteImage(quill, file);
                    return;
                }
            }
        }
        const textPlain = e.clipboardData ? (e.clipboardData.getData('text/plain') || '') : '';
        const urlRegex = /(https?:\/\/[^\s<>"]+|ftp:\/\/[^\s<>"]+|mailto:[^\s<>"]+)/gi;
        const trimmed = textPlain.trim();
        const urlMatch = trimmed.match(urlRegex);
        if (urlMatch && urlMatch[0].length >= trimmed.length * 0.7) {
            e.preventDefault();
            const url = urlMatch[0];
            const sel = quill.getSelection(true);
            const idx = sel ? sel.index : quill.getLength();
            quill.insertText(idx, url, 'link', url, 'user');
            quill.setSelection(idx + url.length, 0, 'silent');
        }
    });

    // ── Markdown 快捷输入（与备忘录一致）──
    setupStickyMarkdown(quill);

    // ── 绑定滚动 / 拖拽 / 字号 等行为到 Quill 编辑器 ──
    bindContentBehaviors(quill.root);

    // ── 编辑时自动保存（仅用户操作触发，避免初始化加载时重复写入）──
    quill.on('text-change', (delta, oldDelta, source) => {
        if (source === 'user') saveMemo();
        // ★ 目录导航展开时刷新大纲（节流 300ms）
        const wrapper = document.getElementById('stickyWrapper');
        if (wrapper && wrapper.classList.contains('nav-open')) {
            if (window.__stickyOutlineDebounce) clearTimeout(window.__stickyOutlineDebounce);
            window.__stickyOutlineDebounce = setTimeout(buildStickyOutline, 300);
        }
    });

    setTimeout(updateScrollbar, 100);
}

/** 把滚动/选择/滚轮等行为绑定到指定内容元素（Quill 编辑器或回退 div） */
function bindContentBehaviors(el) {
    if (!el) return;
    el.addEventListener('scroll', updateScrollbar);
    el.addEventListener('wheel', handleScroll);
    el.addEventListener('wheel', handleFontSizeScroll);
    el.addEventListener('selectstart', handleSelectStart);
}

/** 粘贴图片 → 以 base64 嵌入（与备忘录一致） */
function handleStickyPasteImage(quill, file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const base64Data = e.target.result;
        const range = quill.getSelection();
        quill.insertEmbed(range ? range.index : quill.getLength(), 'image', base64Data);
        quill.setSelection(range ? range.index + 1 : quill.getLength());
    };
    reader.readAsDataURL(file);
}

/**
 * ★ Markdown 快捷输入（与备忘录 setupMarkdownShortcuts 一致，去掉表格插入快捷键——
 *   表格编辑更适合在备忘录全屏编辑器中进行；便利贴只需正确渲染表格即可，由 Table Blot 保证）。
 */
function setupStickyMarkdown(quill) {
    if (!quill) return;

    const linePrefixes = [
        { regex: /^#\s$/, format: 'header', value: 1 },
        { regex: /^##\s$/, format: 'header', value: 2 },
        { regex: /^###\s$/, format: 'header', value: 3 },
        { regex: /^####\s$/, format: 'header', value: 4 },
        { regex: /^#####\s$/, format: 'header', value: 5 },
        { regex: /^######\s$/, format: 'header', value: 6 },
        { regex: /^[-*+]\s$/, format: 'list', value: 'bullet' },
        { regex: /^\d+\.\s$/, format: 'list', value: 'ordered' },
        { regex: /^>\s$/, format: 'blockquote', value: true },
        { regex: /^```\s$/, format: 'code-block', value: true },
    ];

    const hrPatterns = [
        { regex: /^---\s?$/ },
        { regex: /^\*\*\*\s?$/ },
        { regex: /^___\s?$/ },
    ];

    const wrapPatterns = [
        { open: '**', close: '**', format: 'bold' },
        { open: '__', close: '__', format: 'bold' },
        { open: '*', close: '*', format: 'italic' },
        { open: '_', close: '_', format: 'italic' },
        { open: '~~', close: '~~', format: 'strike' },
        { open: '`', close: '`', format: 'code' },
    ];

    quill.on('text-change', (delta, oldDelta, source) => {
        if (source !== 'user') return;
        setTimeout(() => {
            const sel = quill.getSelection();
            if (!sel) return;

            const lineInfo = quill.getLine(sel.index);
            if (!lineInfo || !lineInfo[0]) return;
            const line = lineInfo[0];
            const lineOffset = lineInfo[1];
            const lineStart = sel.index - lineOffset;
            const text = (line.domNode && line.domNode.textContent) || '';

            // ── 分割线检测（独立占一行）──
            for (const p of hrPatterns) {
                if (p.regex.test(text)) {
                    quill.deleteText(lineStart, text.length);
                    quill.insertText(lineStart, '\n', 'divider', true, 'api');
                    setTimeout(() => {
                        const hr = quill.root.querySelector('hr') ||
                                   quill.root.querySelector('.ql-divider') ||
                                   quill.root.querySelector('.memo-divider');
                        if (hr && hr.parentElement && hr.parentElement !== quill.root) {
                            const parent = hr.parentElement;
                            if (parent.nextSibling) {
                                parent.parentNode.insertBefore(hr, parent.nextSibling);
                            } else {
                                parent.parentNode.appendChild(hr);
                            }
                            if (parent.tagName === 'P' && (!parent.textContent || parent.textContent.trim() === '') && parent.children.length === 0) {
                                parent.remove();
                            }
                        }
                    }, 10);
                    quill.setSelection(lineStart + 1, 0, 'silent');
                    return;
                }
            }

            // ── 行首前缀检测 ──
            for (const p of linePrefixes) {
                const m = text.match(p.regex);
                if (m) {
                    const matchLen = m[0].length;
                    quill.deleteText(lineStart, matchLen);
                    quill.formatLine(lineStart, 1, p.format, p.value);
                    quill.setSelection(lineStart, 0, 'silent');
                    return;
                }
            }

            // ── 包裹格式检测（光标在闭合标记紧后方时触发）──
            if (text.length >= 4 && /\s$/.test(text)) {
                const trimmed = text.slice(0, -1);
                for (const wp of wrapPatterns) {
                    const openIdx = trimmed.indexOf(wp.open);
                    if (openIdx === -1) continue;
                    const closeIdx = trimmed.lastIndexOf(wp.close);
                    if (closeIdx <= openIdx + wp.open.length) continue;

                    const inner = trimmed.slice(openIdx + wp.open.length, closeIdx);
                    if (inner.includes(wp.open) || inner.includes(wp.close)) continue;

                    const prefix = trimmed.slice(0, openIdx);
                    const suffix = trimmed.slice(closeIdx + wp.close.length);
                    const fullLen = text.length;

                    quill.deleteText(lineStart, fullLen);

                    let cursorPos = lineStart;
                    if (prefix) {
                        quill.insertText(cursorPos, prefix, 'silent');
                        cursorPos += prefix.length;
                    }

                    quill.insertText(cursorPos, inner, 'silent');
                    quill.formatText(cursorPos, inner.length, wp.format, true, 'silent');

                    cursorPos += inner.length;
                    if (suffix) {
                        quill.insertText(cursorPos, suffix, 'silent');
                        cursorPos += suffix.length;
                    }

                    quill.setSelection(cursorPos, 0, 'silent');
                    return;
                }
            }
        }, 0);
    });

    // ── 回车后清除新行继承的行级格式（与备忘录一致）──
    const FORMAT_CLEAR_ON_ENTER = [
        'bold', 'italic', 'strike', 'underline',
        'header', 'blockquote', 'code-block', 'code', 'list'
    ];
    let pendingNewLineIndex = -1;

    quill.root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            const sel = quill.getSelection();
            if (sel) pendingNewLineIndex = sel.index;
        }
    });

    quill.on('text-change', (delta, oldDelta, source) => {
        if (source !== 'user' || pendingNewLineIndex < 0) return;
        setTimeout(() => {
            const sel = quill.getSelection();
            if (!sel || sel.index <= pendingNewLineIndex) { pendingNewLineIndex = -1; return; }

            const lineInfo = quill.getLine(sel.index);
            if (!lineInfo || !lineInfo[0]) { pendingNewLineIndex = -1; return; }

            const lineStart = sel.index - lineInfo[1];
            const lineText = (lineInfo[0].domNode && lineInfo[0].domNode.textContent) || '';

            if (lineText.trim().length <= 2) {
                const formats = quill.getFormat(lineStart, Math.max(1, lineText.length || 1));
                const hasFormatToClear = FORMAT_CLEAR_ON_ENTER.some(f => formats[f]);
                if (hasFormatToClear) {
                    for (const fmt of FORMAT_CLEAR_ON_ENTER) {
                        if (formats[fmt]) {
                            quill.formatText(lineStart, Math.max(1, lineText.length || 1), fmt, false, 'silent');
                        }
                    }
                }
            }
            pendingNewLineIndex = -1;
        }, 0);
    });
}

function saveMemo() {
    if (!currentMemoId) return;

    if (saveMemoDebounceTimer) {
        clearTimeout(saveMemoDebounceTimer);
    }

    const title = document.getElementById('stickyTitle').value;

    let content = '';
    let htmlContent = '';
    if (stickyQuill) {
        htmlContent = stickyQuill.root.innerHTML;
        content = stickyQuill.getText();
    } else {
        const disp = document.getElementById('stickyContentDisplay');
        htmlContent = disp.innerHTML;
        content = disp.innerText || disp.textContent || '';
    }

    saveMemoDebounceTimer = setTimeout(() => {
        // ★ 与备忘录一致：同时保存纯文本 content 与富文本 htmlContent
        ipcRenderer.invoke('update-sticky-memo', currentMemoId, title, content, htmlContent);
    }, SAVE_DEBOUNCE_DELAY);
}

function toggleCollapse() {
    isCollapsed = !isCollapsed;
    updateCollapseState();
}

function updateCollapseState() {
    const header = document.getElementById('stickyHeader');
    const contentControls = document.getElementById('contentControls');
    const dragArea = document.getElementById('dragArea');

    if (isCollapsed) {
        header.classList.add('collapsed');
        contentControls.classList.remove('hidden');
        dragArea.style.display = 'block';
    } else {
        header.classList.remove('collapsed');
        contentControls.classList.add('hidden');
        dragArea.style.display = 'none';
    }
}

function handleScroll(e) {
    // ↓ 原有逻辑：向下滚动时延迟折叠（不阻断原生滚动）
    if (e.deltaY > 0 && !isCollapsed) {
        if (scrollHideTimer) clearTimeout(scrollHideTimer);
        scrollHideTimer = setTimeout(() => {
            collapseAll();
        }, 100);
    }

    if (isCollapsed) {
        e.stopPropagation();
    }
}

function collapseAll() {
    isCollapsed = true;
    updateCollapseState();

    const titleWrapper = document.getElementById('stickyTitleWrapper');
    if (titleWrapper) {
        titleWrapper.classList.add('collapsed');
    }

    const textareaWrapper = document.getElementById('stickyTextareaWrapper');
    if (textareaWrapper) {
        textareaWrapper.classList.add('collapsed');
    }

    const activeEl = getActiveContentEl();
    savedScrollTop = activeEl ? activeEl.scrollTop : 0;
}

function expandAll() {
    isCollapsed = false;
    updateCollapseState();

    const titleWrapper = document.getElementById('stickyTitleWrapper');
    if (titleWrapper) {
        titleWrapper.classList.remove('collapsed');
    }

    const textareaWrapper = document.getElementById('stickyTextareaWrapper');
    if (textareaWrapper) {
        textareaWrapper.classList.remove('collapsed');
    }

    setTimeout(() => {
        const activeEl = getActiveContentEl();
        if (activeEl) activeEl.scrollTop = savedScrollTop;
    }, 100);
}

// ===== 目录导航抽屉（飞书式标题大纲，浮层滑入，不压缩正文）=====
function toggleStickyOutline() {
    const wrapper = document.getElementById('stickyWrapper');
    if (!wrapper) return;
    const open = wrapper.classList.toggle('nav-open');
    if (open) buildStickyOutline();
}

function buildStickyOutline() {
    const inner = document.getElementById('stickyOutlineInner');
    if (!inner) return;
    const contentEl = getActiveContentEl();
    if (!contentEl) { inner.innerHTML = ''; return; }
    const heads = Array.from(contentEl.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    if (heads.length === 0) {
        inner.innerHTML = '<div class="sticky-outline-empty">暂无标题<br>行首输入 # / ## / ### 可生成</div>';
        return;
    }
    inner.innerHTML = heads.map((h, i) => {
        const level = parseInt(h.tagName.substring(1), 10);
        const text = (h.textContent || '').trim() || '（无标题）';
        return `<a class="sticky-outline-item" data-level="${level}" data-idx="${i}" title="${escapeStickyHtml(text)}" style="padding-left:${10 + (level - 1) * 10}px">${escapeStickyHtml(text)}</a>`;
    }).join('');
    inner.querySelectorAll('.sticky-outline-item').forEach((item, i) => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            scrollStickyToHeading(heads[i]);
            inner.querySelectorAll('.sticky-outline-item').forEach(x => x.classList.remove('active'));
            item.classList.add('active');
            // 便利贴空间小，跳转后自动收起抽屉
            const wrapper = document.getElementById('stickyWrapper');
            if (wrapper) wrapper.classList.remove('nav-open');
        });
    });
}

function scrollStickyToHeading(heading) {
    const contentEl = getActiveContentEl();
    if (!contentEl || !heading) return;
    const rootTop = contentEl.getBoundingClientRect().top;
    const hTop = heading.getBoundingClientRect().top;
    contentEl.scrollTo({ top: contentEl.scrollTop + (hTop - rootTop) - 8, behavior: 'smooth' });
}

function escapeStickyHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function handleFontSizeScroll(e) {
    if (!isAltPressed) return;

    e.preventDefault();

    const delta = e.deltaY > 0 ? -1 : 1;
    const newFontSize = Math.max(8, Math.min(36, currentFontSize + delta));

    if (newFontSize !== currentFontSize) {
        currentFontSize = newFontSize;

        const disp = document.getElementById('stickyContentDisplay');
        const root = stickyQuill ? stickyQuill.root : null;
        if (disp) disp.style.fontSize = currentFontSize + 'px';
        if (root) root.style.fontSize = currentFontSize + 'px';
    }
}

function applyColor(color) {
    if (currentMemoId) {
        ipcRenderer.invoke('update-sticky-color', currentMemoId, color);
    }

    lastUsedColor = color;
    try {
        localStorage.setItem('stickyNoteLastColor', color);
    } catch (e) {
        console.log('无法保存颜色到本地存储');
    }

    const r = parseInt(color.substring(1, 3), 16);
    const g = parseInt(color.substring(3, 5), 16);
    const b = parseInt(color.substring(5, 7), 16);

    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    const isDark = brightness < 128;
    const textColor = isDark ? '#ffffff' : '#333333';

    const stickyContainer = document.getElementById('stickyContainer');
    if (stickyContainer) {
        stickyContainer.style.background = color;
    }

    const titleInput = document.getElementById('stickyTitle');
    const contentDisplay = document.getElementById('stickyContentDisplay');
    const headerBtns = document.querySelectorAll('.sticky-btn');
    const contentBtns = document.querySelectorAll('.sticky-content-btn');

    if (titleInput) titleInput.style.color = textColor;
    if (contentDisplay) contentDisplay.style.color = textColor;

    // ★ Quill 编辑器文本颜色随背景自适应
    const editorRoot = stickyQuill ? stickyQuill.root : null;
    if (editorRoot) editorRoot.style.color = textColor;

    headerBtns.forEach(btn => {
        btn.style.color = textColor;
    });

    const contentBtnNormalColor = isDark ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.35)';
    const contentBtnHoverColor = isDark ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.75)';

    contentBtns.forEach(btn => {
        btn.style.color = contentBtnNormalColor;
        btn.onmouseenter = () => { btn.style.color = contentBtnHoverColor; };
        btn.onmouseleave = () => { btn.style.color = contentBtnNormalColor; };
    });

    const hoverBorderColor = isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.12)';
    const hoverBoxShadow = isDark ? '0 2px 12px rgba(0, 0, 0, 0.3)' : '0 2px 12px rgba(0, 0, 0, 0.1)';

    document.documentElement.style.setProperty('--hover-border-color', hoverBorderColor);
    document.documentElement.style.setProperty('--hover-box-shadow', hoverBoxShadow);
    document.documentElement.style.setProperty('--sticky-bg-color', color);
    // ★ 目录导航抽屉文字颜色随背景自适应
    document.documentElement.style.setProperty('--sticky-text-color', textColor);

    // ★ 富文本装饰元素颜色随背景自适应（圆点 / 引用色条）
    const bulletColor = isDark ? 'rgba(255, 255, 255, 0.75)' : 'rgba(51, 51, 51, 0.7)';
    const accentColor = isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(51, 112, 255, 0.6)';
    document.documentElement.style.setProperty('--sticky-bullet-color', bulletColor);
    document.documentElement.style.setProperty('--sticky-accent-color', accentColor);

    const scrollbarColor = isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.25)';
    const scrollbarHoverColor = isDark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.4)';

    let style = document.getElementById('sticky-dynamic-style');
    if (!style) {
        style = document.createElement('style');
        style.id = 'sticky-dynamic-style';
        document.head.appendChild(style);
    }

    style.textContent = `
        #stickyTitle::placeholder { color: ${isDark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(51, 51, 51, 0.5)'} !important; }
        #stickyContent::placeholder { color: ${isDark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(51, 51, 51, 0.5)'} !important; }
        .sticky-textarea::-webkit-scrollbar-thumb,
        .sticky-content-display::-webkit-scrollbar-thumb {
            background: transparent;
        }
        .sticky-textarea-wrapper:hover .sticky-textarea::-webkit-scrollbar-thumb,
        .sticky-textarea-wrapper:hover .sticky-content-display::-webkit-scrollbar-thumb {
            background: ${scrollbarColor};
        }
        .sticky-textarea,
        .sticky-content-display {
            scrollbar-color: transparent transparent;
        }
        .sticky-textarea-wrapper:hover .sticky-textarea,
        .sticky-textarea-wrapper:hover .sticky-content-display {
            scrollbar-color: ${scrollbarHoverColor} transparent;
        }
        /* ★ 富文本编辑器（Quill）主题适配：占位符颜色随背景自适应 */
        .ql-editor.ql-blank::before {
            color: ${isDark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(51, 51, 51, 0.5)'} !important;
        }
        /* ★ 链接颜色随便利贴背景自适应（深色背景→浅色链接，浅色背景→深色链接） */
        #stickyEditorContainer .ql-editor a,
        .sticky-content-display a {
            color: ${isDark ? 'rgba(180, 210, 255, 0.9)' : 'rgba(30, 100, 220, 0.95)'} !important;
            text-decoration: underline;
            text-underline-offset: 2px;
        }
        #stickyEditorContainer .ql-editor a:hover,
        .sticky-content-display a:hover {
            color: ${isDark ? 'rgba(200, 225, 255, 1)' : 'rgba(20, 80, 180, 1)'} !important;
        }
    `;
}

// ===== 滚动条相关（模块级，供 bindContentBehaviors 复用） =====
function updateScrollbar() {
    const scrollbarArea = document.getElementById('scrollbarArea');
    const scrollbarThumbEl = scrollbarThumb;
    if (!scrollbarArea || !scrollbarThumbEl) return;

    const scrollableElement = getActiveContentEl();
    if (!scrollableElement) return;
    const scrollHeight = scrollableElement.scrollHeight - scrollableElement.clientHeight;

    if (scrollHeight > 0) {
        scrollbarArea.classList.add('has-content');
        const scrollPercent = scrollableElement.scrollTop / scrollHeight;
        const thumbHeight = Math.max(20, (scrollableElement.clientHeight / scrollableElement.scrollHeight) * scrollableElement.clientHeight);
        const thumbTop = scrollPercent * (scrollableElement.clientHeight - thumbHeight);

        scrollbarThumbEl.style.height = `${thumbHeight}px`;
        scrollbarThumbEl.style.top = `${thumbTop}px`;
        scrollbarThumbEl.style.display = 'block';
    } else {
        scrollbarArea.classList.remove('has-content');
        scrollbarThumbEl.style.display = 'none';
    }
}

function handleScrollbarDown(e) {
    e.preventDefault();
    e.stopPropagation();

    const scrollableElement = getActiveContentEl();
    if (!scrollableElement) return;
    const scrollHeight = scrollableElement.scrollHeight - scrollableElement.clientHeight;

    if (scrollHeight <= 0) return;

    isDragging = true;
    startY = e.clientY;

    const activeElement = document.activeElement;
    if (activeElement === scrollableElement) {
        startScrollTop = activeElement.scrollTop;
    } else {
        startScrollTop = scrollableElement.scrollTop;
    }

    document.addEventListener('mousemove', handleScrollbarMove);
    document.addEventListener('mouseup', handleScrollbarUp);
}

function handleScrollbarMove(e) {
    if (!isDragging) return;

    const scrollableElement = getActiveContentEl();
    if (!scrollableElement) return;
    const scrollHeight = scrollableElement.scrollHeight - scrollableElement.clientHeight;

    if (scrollHeight > 0) {
        const deltaY = e.clientY - startY;
        const scrollPercent = deltaY / scrollableElement.clientHeight;
        scrollableElement.scrollTop = Math.max(0, Math.min(scrollHeight, startScrollTop + scrollHeight * scrollPercent));
        updateScrollbar();
    }
}

function handleScrollbarUp() {
    isDragging = false;
    document.removeEventListener('mousemove', handleScrollbarMove);
    document.removeEventListener('mouseup', handleScrollbarUp);
}

function handleSelectStart(e) {
    const target = e.target;
    const rect = target.getBoundingClientRect();
    const scrollbarWidth = 12;
    if (e.clientX > rect.right - scrollbarWidth) {
        e.preventDefault();
    }
}

// ===== 事件绑定入口 =====
document.addEventListener('DOMContentLoaded', () => {
    const stickyContainer = document.getElementById('stickyContainer');
    stickyContainer.style.background = lastUsedColor;

    initColorFromStorage();

    ipcRenderer.on('load-memo', (event, memo) => {
        currentMemoId = memo.id;
        document.getElementById('stickyTitle').value = memo.title || '';

        const contentDisplay = document.getElementById('stickyContentDisplay');
        const editorContainer = document.getElementById('stickyEditorContainer');

        const html = memo.htmlContent || '';
        const text = memo.content || '';

        // ★ 用 Quill 富文本编辑器替换原纯文本 textarea（与备忘录一致）
        initStickyQuill(html, text);

        contentDisplay.style.display = 'none';
        editorContainer.style.display = 'flex';

        isEditMode = true;

        if (memo.color) {
            applyColor(memo.color);
        } else if (lastUsedColor) {
            applyColor(lastUsedColor);
        }

        expandAll();
    });

    ipcRenderer.on('apply-color', (event, color) => {
        applyColor(color);
    });

    document.getElementById('stickyTitle').addEventListener('input', saveMemo);

    const contentDisplay = document.getElementById('stickyContentDisplay');
    const scrollbarArea = document.getElementById('scrollbarArea');

    scrollbarThumb = document.createElement('div');
    scrollbarThumb.className = 'scrollbar-thumb';
    scrollbarArea.appendChild(scrollbarThumb);

    scrollbarArea.addEventListener('mousedown', handleScrollbarDown);
    scrollbarArea.addEventListener('selectstart', (e) => e.preventDefault());

    contentDisplay.addEventListener('selectstart', handleSelectStart);
    contentDisplay.addEventListener('scroll', updateScrollbar);

    contentDisplay.addEventListener('wheel', handleScroll);
    contentDisplay.addEventListener('wheel', handleFontSizeScroll);
    document.addEventListener('wheel', handleFontSizeScroll);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Alt') {
            isAltPressed = true;
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.key === 'Alt') {
            isAltPressed = false;
        }
    });

    document.getElementById('pinBtn').addEventListener('click', () => {
        isPinned = !isPinned;
        const pinBtn = document.getElementById('pinBtn');
        pinBtn.classList.toggle('pinned', isPinned);
        ipcRenderer.invoke('toggle-sticky-pin', isPinned);
    });

    document.getElementById('expandBtn').addEventListener('click', () => {
        expandAll();
    });

    document.getElementById('minimizeBtn').addEventListener('click', () => {
        ipcRenderer.invoke('minimize-sticky-note');
    });

    document.getElementById('closeBtn').addEventListener('click', () => {
        ipcRenderer.invoke('close-sticky-note', currentMemoId);
    });

    document.getElementById('colorBtn').addEventListener('click', () => {
        ipcRenderer.invoke('open-color-picker', currentMemoId);
    });

    document.getElementById('colorBtnContent').addEventListener('click', () => {
        ipcRenderer.invoke('open-color-picker', currentMemoId);
    });

    // ★ 目录导航：展开态 / 折叠态 / 抽屉内关闭按钮
    document.getElementById('navToggleBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStickyOutline();
    });
    document.getElementById('navToggleBtnContent').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStickyOutline();
    });
    document.getElementById('stickyOutlineClose').addEventListener('click', (e) => {
        e.stopPropagation();
        const wrapper = document.getElementById('stickyWrapper');
        if (wrapper) wrapper.classList.remove('nav-open');
    });
});
