// content.js — MCP Multi Bridge 内容脚本
// 注入到 AI 聊天页面，提供侧边栏 UI、工具调用检测、执行和结果注入。

'use strict';

(function () {
  // 防止重复注入
  if (window.__mcpMultiBridgeLoaded) return;
  window.__mcpMultiBridgeLoaded = true;

  // ==================== 平台检测 ====================
  const PLATFORM = detectPlatform();

  function detectPlatform() {
    const h = location.hostname;
    if (h.includes('chatgpt.com') || h.includes('chat.openai.com')) return 'chatgpt';
    if (h.includes('gemini.google.com')) return 'gemini';
    if (h.includes('chat.deepseek.com')) return 'deepseek';
    if (h.includes('grok.com')) return 'grok';
    if (h.includes('perplexity.ai')) return 'perplexity';
    if (h.includes('aistudio.google.com')) return 'aistudio';
    if (h.includes('chat.mistral.ai')) return 'mistral';
    if (h.includes('kimi.com') || h.includes('kimi.moonshot.cn')) return 'kimi';
    if (h.includes('t3.chat')) return 't3';
    if (h.includes('qwen.ai') || h.includes('qianwen.com')) return 'qwen';
    if (h.includes('chatglm.cn') || h.includes('chat.z.ai')) return 'chatglm';
    if (h.includes('github.com')) return 'copilot';
    if (h.includes('doubao.com')) return 'doubao';
    return 'unknown';
  }

  // 判断当前平台是否使用拖放注入方式（仅 Gemini）
  function usesDragDropInjection() {
    return PLATFORM === 'gemini';
  }

  // ==================== 保活端口 ====================
  let keepalivePort = null;
  function ensureKeepalive() {
    if (!keepalivePort) {
      keepalivePort = chrome.runtime.connect({ name: 'keepalive' });
      keepalivePort.onDisconnect.addListener(() => { keepalivePort = null; });
    }
  }
  ensureKeepalive();

  // ==================== 消息通信 ====================
  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp) return reject(new Error('无响应'));
        if (!resp.ok) return reject(new Error(resp.error || '未知错误'));
        resolve(resp.data);
      });
    });
  }

  const MAX_RETRIES = 5;
  const RETRY_BASE_DELAY = 1000; // ms

  async function sendWithRetry(msg, onRetry) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await send(msg);
      } catch (e) {
        lastError = e;
        console.warn(`[MCP] 调用失败 (第${attempt}/${MAX_RETRIES}次):`, e.message);
        if (onRetry) onRetry(attempt, MAX_RETRIES, e);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY * attempt));
        }
      }
    }
    throw lastError;
  }

  // ==================== 状态 ====================
  let allTools = [];
  let selectedServers = new Set(); // 已选中的 MCP 服务器名称
  let autoExecute = false;
  let autoSubmit = false;
  let pasteIntercept = true;
  let autoSendDelay = 4;   // 秒：最后一个MCP返回后等待多久再注入（等待AI继续输出新调用）
  let fileParsDelay = 8;   // 秒：注入文件后等待多久再发送（等待平台解析文件）
  let sidebarVisible = false;
  let darkMode = false;
  const processedBlocks = new WeakMap(); // element → 已处理的调用数量（支持流式增量检测）
  // Gemini 专用：基于内容签名的去重集合
  // Gemini 在流式输出时会销毁并重建 <code> 元素，导致 WeakMap 丢失引用
  // 通过 name+callId+params 生成唯一签名来避免重复检测
  const processedCallSignatures = new Set();

  // ==================== 批量执行状态 ====================
  // 当同一批检测到多个工具调用时，收集所有结果后再统一注入+发送
  let pendingExecutions = 0;
  let collectedResults = []; // { call, result, error }
  let batchInjectTimer = null;

  // ==================== 跨周期累积 & 统一计时器 ====================
  // 跨扫描周期累积的所有已完成结果（等最后一个调用完成后 8s 再统一注入）
  let accumulatedResults = [];
  let autoSendTimer = null; // 8 秒自动发送定时器 ID
  let sendRetryTimer = null; // 1 秒发送延迟定时器 ID（可取消，防止调用未完成就发送）

  // ==================== Gemini 拖放监听器注入 ====================
  let geminiDragDropInjected = false;
  let geminiDragDropReady = null; // Promise that resolves when script is loaded

  function injectGeminiDragDropListener() {
    if (!usesDragDropInjection()) return Promise.resolve(false);
    if (geminiDragDropInjected && geminiDragDropReady) return geminiDragDropReady;
    geminiDragDropReady = new Promise((resolve) => {
      try {
        const scriptEl = document.createElement('script');
        scriptEl.src = chrome.runtime.getURL('dragDropListener.js');
        scriptEl.onload = () => {
          scriptEl.remove();
          geminiDragDropInjected = true;
          console.log('[MCP] Gemini dragDropListener 已注入到页面主世界');
          resolve(true);
        };
        scriptEl.onerror = () => {
          console.warn('[MCP] Gemini dragDropListener 脚本加载失败');
          resolve(false);
        };
        (document.head || document.documentElement).appendChild(scriptEl);
      } catch (e) {
        console.warn('[MCP] Gemini dragDropListener 注入失败:', e);
        resolve(false);
      }
    });
    return geminiDragDropReady;
  }

  // Gemini 专用：通过 postMessage 让主世界的 dragDropListener 执行拖放
  async function geminiDropFile(file) {
    // 确保 dragDropListener.js 已加载到页面主世界
    const injected = await injectGeminiDragDropListener();
    if (!injected) {
      console.warn('[MCP] geminiDropFile: dragDropListener 未就绪');
      return false;
    }

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        // Gemini 仅接受 text/plain，不接受 text/markdown
        // 保留 .md 文件扩展名，但使用 text/plain MIME 类型
        const safeType = file.type === 'text/markdown' ? 'text/plain' : file.type;
        window.postMessage({
          type: 'MCP_DROP_FILE',
          platform: PLATFORM,
          fileName: file.name,
          fileType: safeType,
          fileSize: file.size,
          lastModified: file.lastModified,
          fileData: reader.result, // base64 data URL
        }, '*');
        // 给平台时间处理拖放事件，然后检查文件预览元素
            setTimeout(() => {
              const preview = document.querySelector('.file-preview, .xap-filed-upload-preview, .attachment-preview');
              if (preview) {
                console.log('[MCP] 文件预览已出现，附件成功');
              } else {
                console.warn('[MCP] 文件预览未出现，但仍视为成功（乐观模式）');
              }
          resolve(true);
        }, 800);
      };
      reader.onerror = () => {
        console.warn('[MCP] geminiDropFile: FileReader 读取失败');
        resolve(false);
      };
      reader.readAsDataURL(file);
    });
  }

  // ==================== 会话切换检测 ====================
  // 防止切换会话时自动执行旧会话中已存在的工具调用
  // 原理：不额外轮询，而是在已有的 MutationObserver 回调中顺便检测 URL 变化
  // SPA 切换会话时 pushState 改 URL → 框架更新 DOM → MutationObserver 触发 → 检测到 URL 变化
  let lastUrl = location.href;
  let suppressAutoExecuteUntil = 0;

  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onConversationSwitch();
    }
  }

  function onConversationSwitch() {
    console.log('[MCP] 检测到会话切换，暂停自动执行 3 秒');
    // 设置 3 秒抑制窗口：在此期间扫描到的工具调用只创建卡片，不自动执行
    suppressAutoExecuteUntil = Date.now() + 3000;

    // 清空旧会话的调用卡片列表（旧会话的调用卡片在新会话中无意义）
    const callList = shadowRoot?.querySelector('#mcpCallList');
    if (callList) {
      callList.innerHTML = '<div class="mcp-empty">尚未检测到工具调用。</div>';
    }
    callIdCounter = 0;

    // 清理跨周期累积状态 & 取消待发送的自动发送定时器
    clearTimeout(autoSendTimer);
    autoSendTimer = null;
    clearTimeout(sendRetryTimer);
    sendRetryTimer = null;
    accumulatedResults = [];
    // Gemini: 清空签名去重集合，新会话重新开始
    processedCallSignatures.clear();
  }

  // ==================== 侧边栏创建 ====================
  function createSidebar() {
    const host = document.createElement('div');
    host.id = 'mcp-multi-bridge-host';
    host.style.display = 'none'; // 默认收起
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });

    // 加载样式
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('sidebar.css');
    shadow.appendChild(link);

    const sidebar = document.createElement('div');
    sidebar.className = 'mcp-sidebar';
    sidebar.innerHTML = buildSidebarHTML();
    shadow.appendChild(sidebar);

    // 切换按钮（放在 shadow 外部保证可见）
    const toggle = document.createElement('div');
    toggle.id = 'mcp-multi-bridge-toggle';
    toggle.title = 'MCP Multi Bridge';
    toggle.textContent = 'MCP';
    toggle.classList.add('collapsed'); // 默认收起状态
    toggle.addEventListener('click', (e) => {
      e.stopPropagation(); // 防止 document click 立即收起
      sidebarVisible = !sidebarVisible;
      host.style.display = sidebarVisible ? 'block' : 'none';
      toggle.classList.toggle('collapsed', !sidebarVisible);
    });
    document.body.appendChild(toggle);

    // 点击侧边栏外部区域时收起
    host.addEventListener('click', (e) => {
      e.stopPropagation(); // 点击侧边栏内部不收起
    });
    document.addEventListener('click', () => {
      if (sidebarVisible) {
        sidebarVisible = false;
        host.style.display = 'none';
        toggle.classList.add('collapsed');
      }
    });

    return { host, shadow, sidebar };
  }

  function buildSidebarHTML() {
    return `
      <div class="mcp-header">
        <span class="mcp-title">MCP Multi Bridge</span>
        <div class="mcp-header-right">
          <span class="mcp-server-count" id="mcpServerCount">0 个服务器</span>
          <button class="mcp-theme-btn" id="mcpThemeToggle" title="切换到深色模式">深色</button>
        </div>
      </div>

      <div class="mcp-tabs">
        <button class="mcp-tab active" data-tab="tools">工具</button>
        <button class="mcp-tab" data-tab="calls">调用</button>
        <button class="mcp-tab" data-tab="skills">Skills</button>
        <button class="mcp-tab" data-tab="settings">设置</button>
      </div>

      <div class="mcp-tab-content active" id="mcpTabTools">
        <div class="mcp-actions-col">
          <div class="mcp-actions-row">
            <button class="mcp-btn mcp-btn-primary mcp-btn-flex" id="mcpAttachPrompt">附加 .md</button>
            <button class="mcp-btn mcp-btn-flex" id="mcpDownloadPrompt">下载 .md</button>
            <button class="mcp-btn mcp-btn-flex" id="mcpCopyPrompt">复制</button>
          </div>
          <div class="mcp-actions-row">
            <button class="mcp-btn mcp-btn-full mcp-btn-flex" id="mcpRefreshTools">刷新工具列表</button>
            <button class="mcp-btn mcp-btn-flex" id="mcpSelectAllServers">全选</button>
            <button class="mcp-btn mcp-btn-flex" id="mcpClearServers">清除</button>
          </div>
        </div>
        <div class="mcp-tool-list" id="mcpToolList">
          <div class="mcp-empty">暂无可用工具。请通过扩展弹窗添加 MCP 服务器。</div>
        </div>
      </div>

      <div class="mcp-tab-content" id="mcpTabCalls">
        <div class="mcp-call-list" id="mcpCallList">
          <div class="mcp-empty">尚未检测到工具调用。</div>
        </div>
      </div>

      <div class="mcp-tab-content" id="mcpTabSkills">
        <div class="mcp-actions-col">
          <div class="mcp-actions-row">
            <button class="mcp-btn mcp-btn-primary mcp-btn-flex" id="mcpImportSkillFolder">导入文件夹</button>
            <button class="mcp-btn mcp-btn-flex" id="mcpInjectSkills">注入选中</button>
            <button class="mcp-btn mcp-btn-flex mcp-btn-danger" id="mcpDeleteSkill">删除</button>
          </div>
          <input type="file" id="mcpSkillFolderInput" webkitdirectory multiple style="display:none" />
        </div>
        <div class="mcp-skill-list" id="mcpSkillList">
          <div class="mcp-empty">暂无 Skills。点击上方按钮导入文件夹。</div>
        </div>
      </div>

      <div class="mcp-tab-content" id="mcpTabSettings">
        <label class="mcp-toggle-row">
          <input type="checkbox" id="mcpAutoExecute" />
          <span>自动执行工具调用</span>
        </label>
        <label class="mcp-toggle-row">
          <input type="checkbox" id="mcpAutoSubmit" />
          <span>注入结果后自动发送</span>
        </label>
        <label class="mcp-toggle-row">
          <input type="checkbox" id="mcpPasteIntercept" checked />
          <span>粘贴拦截（MCP结果→文件附件）</span>
        </label>
        <div class="mcp-delay-row">
          <label for="mcpAutoSendDelay">等待注入延迟</label>
          <div class="mcp-delay-input-wrap">
            <input type="number" id="mcpAutoSendDelay" min="1" max="30" value="4" />
            <span class="mcp-delay-unit">秒</span>
          </div>
          <span class="mcp-delay-hint">最后一个调用完成后等待新调用的时间</span>
        </div>
        <div class="mcp-delay-row">
          <label for="mcpFileParsDelay">发送前延迟</label>
          <div class="mcp-delay-input-wrap">
            <input type="number" id="mcpFileParsDelay" min="1" max="30" value="8" />
            <span class="mcp-delay-unit">秒</span>
          </div>
          <span class="mcp-delay-hint">注入文件后等待平台解析再发送</span>
        </div>
        <hr class="mcp-divider" />
        <div class="mcp-section-title">已连接的服务器</div>
        <div id="mcpServerList" class="mcp-server-list"></div>
        <p class="mcp-hint">请通过扩展弹窗管理服务器（点击工具栏图标）。</p>
      </div>
    `;
  }

  // ==================== Skills 管理 ====================
  // skill 结构: { id, name, files: [{name, content}] }
  let skills = [];

  async function loadSkills() {
    try {
      const result = await chrome.storage.local.get('mcp_skills');
      skills = result.mcp_skills || [];
    } catch (e) {
      console.warn('[MCP] 加载 skills 失败:', e);
      skills = [];
    }
  }

  function saveSkills() {
    try {
      chrome.storage.local.set({ mcp_skills: skills });
    } catch (e) {
      console.warn('[MCP] 保存 skills 失败:', e);
    }
  }

  function addSkillFolder(folderName, files) {
    // 如果同名文件夹已存在则覆盖
    const existing = skills.findIndex(s => s.name === folderName);
    const skill = { id: Date.now().toString(), name: folderName, files };
    if (existing >= 0) {
      skills[existing] = skill;
    } else {
      skills.push(skill);
    }
    saveSkills();
    renderSkillList();
  }

  function removeSkillById(id) {
    skills = skills.filter(s => s.id !== id);
    saveSkills();
    renderSkillList();
  }

  function buildSkillMarkdown(skill) {
    // 将文件夹内所有文件拼接为一个 .md 内容
    const lines = [`# Skill: ${skill.name}`, ''];
    for (const f of skill.files) {
      lines.push(`## ${f.name}`, '');
      lines.push(f.content);
      lines.push('');
    }
    return lines.join('\n');
  }

  function renderSkillList() {
    if (!shadowRoot) return;
    const list = shadowRoot.querySelector('#mcpSkillList');
    if (!list) return;

    if (skills.length === 0) {
      list.innerHTML = '<div class="mcp-empty">暂无 Skills。点击上方按钮导入文件夹。</div>';
      return;
    }

    list.innerHTML = skills.map(s => `
      <div class="mcp-skill-item" data-id="${s.id}">
        <label class="mcp-skill-check-label">
          <input type="checkbox" class="mcp-skill-checkbox" data-id="${s.id}" />
          <span class="mcp-skill-name">${s.name}</span>
        </label>
        <span class="mcp-skill-meta">${s.files.length} 个文件</span>
      </div>
    `).join('');
  }

  function getSelectedSkillIds() {
    if (!shadowRoot) return [];
    return [...shadowRoot.querySelectorAll('.mcp-skill-checkbox:checked')].map(cb => cb.dataset.id);
  }

  async function injectSelectedSkills() {
    const selectedIds = getSelectedSkillIds();
    if (selectedIds.length === 0) {
      showNotification('请先勾选要注入的 Skill');
      return;
    }
    const selected = skills.filter(s => selectedIds.includes(s.id));
    // 拼接所有选中的 skills 为一个 .md 内容
    const combined = selected.map(s => buildSkillMarkdown(s)).join('\n---\n\n');
    const mimeType = PLATFORM === 'gemini' ? 'text/plain' : 'text/markdown';
    const fileName = selected.length === 1
      ? `skill-${selected[0].name}.md`
      : `skills-combined-${Date.now()}.md`;
    const file = new File([combined], fileName, { type: mimeType, lastModified: Date.now() });

    let attached = false;

    if (PLATFORM === 'gemini') {
      try {
        attached = await geminiDropFile(file);
      } catch (e) {
        console.warn('[MCP] Skill 注入（拖放）失败:', e);
      }
    }

    if (!attached) {
      const fileInput = await findFileInputWithRetry();
      if (fileInput) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] Skill 注入（fileInput）失败:', e);
        }
      }
    }

    if (!attached) {
      const dropZone = getDropZone();
      if (dropZone) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
          dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
          dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] Skill 注入（dragEvent）失败:', e);
        }
      }
    }

    if (attached) {
      const names = selected.map(s => s.name).join(', ');
      showNotification(`Skill(s) [${names}] 已注入为 .md 文件`);
    } else {
      showNotification('Skill 注入失败，请手动操作');
    }
  }

  // ==================== 侧边栏逻辑 ====================
  let shadowRoot = null;
  let sidebarEventsBound = false;

  function initSidebar() {
    const { shadow, sidebar } = createSidebar();
    shadowRoot = shadow;

    // 等待样式表加载完成后绑定事件
    const linkEl = shadow.querySelector('link');
    linkEl.addEventListener('load', () => bindSidebarEvents());
    // 回退：如果 load 事件不触发（缓存），延迟绑定
    setTimeout(() => bindSidebarEvents(), 200);

    // 加载深色模式偏好
    loadDarkModePreference();

    // 加载自动设置偏好
    loadSettingsPreferences();

    // 加载 Skills
    loadSkills().then(() => renderSkillList());

    // Gemini: 注入拖放监听器到页面主世界（用于文件上传）
    injectGeminiDragDropListener();
  }

  function bindSidebarEvents() {
    if (!shadowRoot || sidebarEventsBound) return;
    sidebarEventsBound = true;
    const $ = (sel) => shadowRoot.querySelector(sel);
    const $$ = (sel) => shadowRoot.querySelectorAll(sel);

    // 标签页切换
    $$('.mcp-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.mcp-tab').forEach((t) => t.classList.remove('active'));
        $$('.mcp-tab-content').forEach((c) => c.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        if (target === 'tools') $('#mcpTabTools').classList.add('active');
        else if (target === 'calls') $('#mcpTabCalls').classList.add('active');
        else if (target === 'skills') $('#mcpTabSkills').classList.add('active');
        else if (target === 'settings') $('#mcpTabSettings').classList.add('active');
      });
    });

    // 提示词操作
    $('#mcpAttachPrompt')?.addEventListener('click', () => attachMCPPromptFile());
    $('#mcpDownloadPrompt')?.addEventListener('click', () => downloadMCPPrompt());
    $('#mcpCopyPrompt')?.addEventListener('click', () => copyMCPPrompt());

    // 刷新工具
    $('#mcpRefreshTools')?.addEventListener('click', () => refreshTools());

    // 全选/清除服务器
    $('#mcpSelectAllServers')?.addEventListener('click', () => {
      const grouped = {};
      for (const t of allTools) {
        const key = t.serverName || t.serverId || 'Default';
        grouped[key] = true;
      }
      selectedServers = new Set(Object.keys(grouped));
      renderToolList();
    });
    $('#mcpClearServers')?.addEventListener('click', () => {
      selectedServers = new Set();
      renderToolList();
    });

    // Skills 事件
    $('#mcpImportSkillFolder')?.addEventListener('click', () => {
      $('#mcpSkillFolderInput')?.click();
    });

    $('#mcpSkillFolderInput')?.addEventListener('change', (e) => {
      const fileList = Array.from(e.target.files || []);
      if (fileList.length === 0) return;

      // 取文件夹名（所有文件的 webkitRelativePath 第一段相同）
      const folderName = fileList[0].webkitRelativePath.split('/')[0] || 'unknown';

      // 读取所有文件内容
      let pending = fileList.length;
      const fileEntries = [];

      fileList.forEach(file => {
        const reader = new FileReader();
        const relativePath = file.webkitRelativePath.split('/').slice(1).join('/') || file.name;
        reader.onload = () => {
          fileEntries.push({ name: relativePath, content: reader.result });
          pending--;
          if (pending === 0) {
            // 按路径名排序
            fileEntries.sort((a, b) => a.name.localeCompare(b.name));
            addSkillFolder(folderName, fileEntries);
            showNotification(`Skill "${folderName}" 已导入（${fileEntries.length} 个文件）`);
          }
        };
        reader.onerror = () => {
          pending--;
          if (pending === 0 && fileEntries.length > 0) {
            fileEntries.sort((a, b) => a.name.localeCompare(b.name));
            addSkillFolder(folderName, fileEntries);
            showNotification(`Skill "${folderName}" 已导入（${fileEntries.length} 个文件，部分读取失败）`);
          }
        };
        reader.readAsText(file);
      });

      e.target.value = '';
    });

    $('#mcpInjectSkills')?.addEventListener('click', () => injectSelectedSkills());

    $('#mcpDeleteSkill')?.addEventListener('click', () => {
      const selectedIds = getSelectedSkillIds();
      if (selectedIds.length === 0) {
        showNotification('请先勾选要删除的 Skill');
        return;
      }
      selectedIds.forEach(id => removeSkillById(id));
      showNotification(`已删除 ${selectedIds.length} 个 Skill`);
    });

    // 自动设置（持久化到 chrome.storage.local）
    $('#mcpAutoExecute')?.addEventListener('change', (e) => {
      autoExecute = e.target.checked;
      chrome.storage?.local?.set({ mcpAutoExecute: autoExecute });
    });
    $('#mcpAutoSubmit')?.addEventListener('change', (e) => {
      autoSubmit = e.target.checked;
      chrome.storage?.local?.set({ mcpAutoSubmit: autoSubmit });
    });
    $('#mcpPasteIntercept')?.addEventListener('change', (e) => {
      pasteIntercept = e.target.checked;
      chrome.storage?.local?.set({ mcpPasteIntercept: pasteIntercept });
    });
    $('#mcpAutoSendDelay')?.addEventListener('change', (e) => {
      autoSendDelay = Math.max(1, Math.min(30, parseInt(e.target.value) || 4));
      e.target.value = autoSendDelay;
      chrome.storage?.local?.set({ mcpAutoSendDelay: autoSendDelay });
    });
    $('#mcpFileParsDelay')?.addEventListener('change', (e) => {
      fileParsDelay = Math.max(1, Math.min(30, parseInt(e.target.value) || 8));
      e.target.value = fileParsDelay;
      chrome.storage?.local?.set({ mcpFileParsDelay: fileParsDelay });
    });

    // 主题切换
    $('#mcpThemeToggle')?.addEventListener('click', () => toggleDarkMode());

    // 初始加载
    refreshTools();
    refreshServers();
  }

  // ==================== 深色模式 ====================
  function loadDarkModePreference() {
    chrome.storage?.local?.get(['mcpDarkMode'], (result) => {
      if (result && result.mcpDarkMode) {
        darkMode = true;
        applyDarkMode();
      }
    });
  }

  // ==================== 设置持久化 ====================
  function loadSettingsPreferences() {
    chrome.storage?.local?.get(['mcpAutoExecute', 'mcpAutoSubmit', 'mcpPasteIntercept', 'mcpAutoSendDelay', 'mcpFileParsDelay'], (result) => {
      if (!result) return;
      if (result.mcpAutoExecute !== undefined) {
        autoExecute = result.mcpAutoExecute;
        const el = shadowRoot?.querySelector('#mcpAutoExecute');
        if (el) el.checked = autoExecute;
      }
      if (result.mcpAutoSubmit !== undefined) {
        autoSubmit = result.mcpAutoSubmit;
        const el = shadowRoot?.querySelector('#mcpAutoSubmit');
        if (el) el.checked = autoSubmit;
      }
      if (result.mcpPasteIntercept !== undefined) {
        pasteIntercept = result.mcpPasteIntercept;
        const el = shadowRoot?.querySelector('#mcpPasteIntercept');
        if (el) el.checked = pasteIntercept;
      }
      if (result.mcpAutoSendDelay !== undefined) {
        autoSendDelay = result.mcpAutoSendDelay;
        const el = shadowRoot?.querySelector('#mcpAutoSendDelay');
        if (el) el.value = autoSendDelay;
      }
      if (result.mcpFileParsDelay !== undefined) {
        fileParsDelay = result.mcpFileParsDelay;
        const el = shadowRoot?.querySelector('#mcpFileParsDelay');
        if (el) el.value = fileParsDelay;
      }
    });
  }

  function toggleDarkMode() {
    darkMode = !darkMode;
    applyDarkMode();
    chrome.storage?.local?.set({ mcpDarkMode: darkMode });
  }

  function applyDarkMode() {
    if (!shadowRoot) return;
    const sidebar = shadowRoot.querySelector('.mcp-sidebar');
    const btn = shadowRoot.querySelector('#mcpThemeToggle');
    if (sidebar) {
      sidebar.classList.toggle('dark', darkMode);
    }
    if (btn) {
      btn.textContent = darkMode ? '浅色' : '深色';
      btn.title = darkMode ? '切换到浅色模式' : '切换到深色模式';
    }
  }

  // ==================== 刷新数据 ====================
  async function refreshTools() {
    try {
      allTools = await send({ type: 'getTools' });
    } catch (e) {
      allTools = [];
      console.warn('[MCP] 获取工具失败:', e.message);
    }
    // 刷新工具后默认全选所有服务器
    selectedServers = new Set();
    for (const t of allTools) {
      const key = t.serverName || t.serverId || 'Default';
      selectedServers.add(key);
    }
    renderToolList();
  }

  async function refreshServers() {
    try {
      const servers = await send({ type: 'getServers' });
      renderServerList(servers);
      const connected = servers.filter((s) => s.status === 'connected').length;
      const total = servers.length;
      const countEl = shadowRoot?.querySelector('#mcpServerCount');
      if (countEl) countEl.textContent = `${connected}/${total} 已连接`;
    } catch (e) {
      console.warn('[MCP] 获取服务器信息失败:', e.message);
    }
  }

  // ==================== 渲染辅助 ====================
  function renderToolList() {
    const container = shadowRoot?.querySelector('#mcpToolList');
    if (!container) return;
    if (allTools.length === 0) {
      container.innerHTML = '<div class="mcp-empty">暂无可用工具。请通过扩展弹窗添加 MCP 服务器。</div>';
      return;
    }

    // 按服务器分组
    const grouped = {};
    for (const t of allTools) {
      const key = t.serverName || t.serverId || 'Default';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(t);
    }

    let html = '';
    for (const [serverName, tools] of Object.entries(grouped)) {
      const checked = selectedServers.has(serverName) ? 'checked' : '';
      html += `
        <div class="mcp-server-group">
          <div class="mcp-server-group-header">
            <label class="mcp-server-check-label">
              <input type="checkbox" class="mcp-server-checkbox" data-server="${esc(serverName)}" ${checked} />
              <span class="mcp-server-group-name">${esc(serverName)}</span>
            </label>
            <span class="mcp-server-group-meta">${tools.length} 个工具</span>
            <button class="mcp-group-toggle" data-server="${esc(serverName)}" title="展开/收起">▶</button>
          </div>
          <div class="mcp-server-group-tools" data-server="${esc(serverName)}" style="display:none">`;
      for (const t of tools) {
        html += `<div class="mcp-tool-item" title="${esc(t.description || '')}">
          <span class="mcp-tool-name">${esc(t.name)}</span>
          <span class="mcp-tool-desc">${esc(truncate(t.description || '', 60))}</span>
        </div>`;
      }
      html += `</div></div>`;
    }
    container.innerHTML = html;

    // 绑定展开/收起
    container.querySelectorAll('.mcp-group-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const server = btn.dataset.server;
        const toolsEl = container.querySelector(`.mcp-server-group-tools[data-server="${server}"]`);
        if (!toolsEl) return;
        const isOpen = toolsEl.style.display !== 'none';
        toolsEl.style.display = isOpen ? 'none' : 'block';
        btn.textContent = isOpen ? '▶' : '▼';
      });
    });

    // 绑定 checkbox 选中
    container.querySelectorAll('.mcp-server-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) {
          selectedServers.add(cb.dataset.server);
        } else {
          selectedServers.delete(cb.dataset.server);
        }
      });
    });
  }

  function renderServerList(servers) {
    const container = shadowRoot?.querySelector('#mcpServerList');
    if (!container) return;
    if (servers.length === 0) {
      container.innerHTML = '<div class="mcp-empty">暂无已配置的服务器。</div>';
      return;
    }
    let html = '';
    for (const s of servers) {
      const dot = s.status === 'connected' ? 'connected' : 'disconnected';
      html += `<div class="mcp-server-row">
        <span class="mcp-status-dot ${dot}"></span>
        <span class="mcp-server-name">${esc(s.name)}</span>
        <span class="mcp-server-tools">${s.toolCount || 0} 个工具</span>
      </div>`;
    }
    container.innerHTML = html;
  }

  // ==================== 工具调用检测 ====================
  function startDetection() {
    let scanTimer = null;
    const debouncedScan = () => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => scanForToolCalls(), 300);
    };

    const observer = new MutationObserver((mutations) => {
      // 在已有的 MutationObserver 中顺便检测 URL 变化（零额外开销）
      // SPA 切换会话：pushState 改 URL → 框架更新 DOM → 此回调触发
      checkUrlChange();

      let shouldScan = false;
      for (const m of mutations) {
        if (m.type === 'childList' && m.addedNodes.length > 0) shouldScan = true;
        if (m.type === 'characterData') shouldScan = true;
      }
      if (shouldScan) debouncedScan();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // popstate 监听浏览器前进/后退导航
    window.addEventListener('popstate', () => checkUrlChange());

    // 定时扫描作为备用
    setInterval(() => scanForToolCalls(), 2000);
  }

  function scanForToolCalls() {
    // 去重逻辑：优先选 <pre> 内的 <code>，避免 <pre> 和 <code> 同时匹配导致重复检测
    const allBlocks = document.querySelectorAll('pre code, pre, code');
    const deduped = [];
    const seen = new Set();
    for (const block of allBlocks) {
      // 如果这个元素已经被处理过（作为另一个元素的子/父），跳过
      if (seen.has(block)) continue;
      // 如果是 <pre> 且内部有 <code>，跳过 <pre>（让内部的 <code> 处理）
      if (block.tagName === 'PRE' && block.querySelector('code')) {
        seen.add(block);
        continue;
      }
      // 如果是 <code> 且在 <pre> 内，标记父 <pre> 为已见
      if (block.tagName === 'CODE' && block.parentElement?.tagName === 'PRE') {
        seen.add(block.parentElement);
      }
      seen.add(block);
      deduped.push(block);
    }

    for (const block of deduped) {
      const text = block.textContent || '';
      if (!text.includes('function_call_start') || !text.includes('function_call_end')) continue;

      const calls = parseToolCalls(text);
      const alreadyProcessed = processedBlocks.get(block) || 0;

      if (calls.length > alreadyProcessed) {
        // 有新的调用（流式增量：只处理新增的部分）
        const newCalls = calls.slice(alreadyProcessed);
        processedBlocks.set(block, calls.length);
        for (const call of newCalls) {
          // 基于内容签名的去重（Gemini + ChatGPT）
          // Gemini 流式输出时会销毁并重建 <code> DOM 元素，导致 WeakMap 丢失引用；
          // ChatGPT 辅助扫描可能与代码块扫描重复检测同一个调用。
          // 通过 name+callId+params 生成唯一签名来避免重复检测。
          if (PLATFORM === 'gemini' || PLATFORM === 'chatgpt') {
            const sig = `${call.name}|${call.callId}|${JSON.stringify(call.params)}`;
            if (processedCallSignatures.has(sig)) continue;
            processedCallSignatures.add(sig);
          }
          addToolCallCard(call, block);
        }
      }
    }

    // ChatGPT 辅助扫描：扫描助手消息容器元素
    // 当 ChatGPT 不使用标准 <pre><code> 渲染代码块时（如新版 DOM 结构），
    // 或当 LLM 将 JSON 输出为纯文本时，代码块扫描可能遗漏工具调用。
    // 此辅助扫描直接检查助手消息的完整文本内容。
    if (PLATFORM === 'chatgpt') {
      const messageEls = document.querySelectorAll(
        '[data-message-author-role="assistant"]'
      );
      // 仅扫描最近的几条消息，避免性能问题
      const recent = Array.from(messageEls).slice(-5);
      for (const el of recent) {
        const text = el.textContent || '';
        if (!text.includes('function_call_start') || !text.includes('function_call_end')) continue;

        // 如果该消息内的代码块已被主扫描检测到，跳过（避免重复）
        const childCodeBlocks = el.querySelectorAll('pre code, pre, code');
        let childAlreadyDetected = false;
        for (const cb of childCodeBlocks) {
          if (processedBlocks.has(cb) && processedBlocks.get(cb) > 0) {
            childAlreadyDetected = true;
            break;
          }
        }
        if (childAlreadyDetected) continue;

        const calls = parseToolCalls(text);
        const alreadyProcessed = processedBlocks.get(el) || 0;

        if (calls.length > alreadyProcessed) {
          const newCalls = calls.slice(alreadyProcessed);
          processedBlocks.set(el, calls.length);
          for (const call of newCalls) {
            // 签名去重（与代码块扫描共享同一个签名集合）
            const sig = `${call.name}|${call.callId}|${JSON.stringify(call.params)}`;
            if (processedCallSignatures.has(sig)) continue;
            processedCallSignatures.add(sig);
            addToolCallCard(call, el);
          }
        }
      }
    }
  }

  function parseToolCalls(text) {
    const calls = [];
    const lines = text.split('\n');
    let current = null;

    // 策略 1: JSONL 格式（每行一个 JSON 对象）— 原始方式
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type === 'function_call_start') {
          current = {
            name: obj.name,
            callId: obj.call_id,
            description: '',
            params: {},
          };
        } else if (obj.type === 'description' && current) {
          current.description = obj.text || '';
        } else if (obj.type === 'parameter' && current) {
          let val = obj.value;
          if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch (_) { }
          }
          current.params[obj.key] = val;
        } else if (obj.type === 'function_call_end' && current) {
          calls.push(current);
          current = null;
        }
      } catch (_) {
        // 非 JSON，跳过
      }
    }

    // 策略 2: 多行 JSON 格式（ChatGPT 等 LLM 可能将 JSON 美化输出）
    // 如果策略 1 未找到任何调用，尝试提取多行 JSON 对象
    if (calls.length === 0 && text.includes('function_call_start')) {
      const jsonObjects = extractJsonObjects(text);
      current = null;
      for (const obj of jsonObjects) {
        if (obj.type === 'function_call_start') {
          current = {
            name: obj.name,
            callId: obj.call_id,
            description: '',
            params: {},
          };
        } else if (obj.type === 'description' && current) {
          current.description = obj.text || '';
        } else if (obj.type === 'parameter' && current) {
          let val = obj.value;
          if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch (_) { }
          }
          current.params[obj.key] = val;
        } else if (obj.type === 'function_call_end' && current) {
          calls.push(current);
          current = null;
        }
      }
    }

    return calls;
  }

  // 从文本中提取所有 JSON 对象，支持多行美化格式
  // 使用状态机正确处理字符串内的花括号
  function extractJsonObjects(text) {
    const objects = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          const jsonStr = text.substring(start, i + 1);
          try {
            const obj = JSON.parse(jsonStr);
            if (obj && typeof obj === 'object' && obj.type) {
              objects.push(obj);
            }
          } catch (_) { /* 忽略无效 JSON */ }
          start = -1;
        }
      }
    }

    return objects;
  }

  // ==================== 工具调用卡片 ====================
  let callIdCounter = 0;

  function addToolCallCard(call, codeBlock) {
    const cardId = `mcp-call-${++callIdCounter}`;

    const callList = shadowRoot?.querySelector('#mcpCallList');
    if (callList) {
      const empty = callList.querySelector('.mcp-empty');
      if (empty) empty.remove();

      const card = document.createElement('div');
      card.className = 'mcp-call-card';
      card.id = cardId;
      card.innerHTML = `
        <div class="mcp-call-header">
          <span class="mcp-call-name">${esc(call.name)}</span>
          <span class="mcp-call-id">#${call.callId}</span>
        </div>
        ${call.description ? `<div class="mcp-call-desc">${esc(call.description)}</div>` : ''}
        <div class="mcp-call-params">
          ${Object.entries(call.params).map(([k, v]) =>
        `<div class="mcp-param"><span class="mcp-param-key">${esc(k)}:</span> <span class="mcp-param-val">${esc(stringify(v))}</span></div>`
      ).join('')}
        </div>
        <div class="mcp-call-actions">
          <button class="mcp-btn mcp-btn-run" data-card="${cardId}">执行</button>
          <button class="mcp-btn mcp-btn-copy-result" data-card="${cardId}" style="display:none;">复制结果</button>
          <span class="mcp-call-status">等待中</span>
        </div>
        <div class="mcp-call-result" style="display:none;"></div>
      `;
      callList.prepend(card);

      card.querySelector('.mcp-btn-run').addEventListener('click', () => {
        executeToolCall(call, card, false);
      });

      if (autoExecute && Date.now() > suppressAutoExecuteUntil) {
        executeToolCall(call, card, true);
      }
    }

    injectInlineIndicator(call, codeBlock);
    switchTab('calls');
  }

  function injectInlineIndicator(call, codeBlock) {
    const indicator = document.createElement('div');
    indicator.className = 'mcp-inline-indicator';
    indicator.innerHTML = `
      <span style="font-weight:600;color:#4f46e5;">MCP 工具调用:</span>
      <span>${esc(call.name)}</span>
      <button class="mcp-inline-run" data-tool="${esc(call.name)}" data-call-id="${call.callId}">执行</button>
    `;

    const pre = codeBlock.closest('pre') || codeBlock;
    pre.parentNode?.insertBefore(indicator, pre.nextSibling);

    indicator.querySelector('.mcp-inline-run')?.addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = '执行中...';
      try {
        const result = await sendWithRetry(
          { type: 'callTool', toolName: call.name, arguments: call.params },
          (attempt, max) => { btn.textContent = `重试中 (${attempt}/${max})...`; }
        );
        btn.textContent = '完成';
        btn.classList.add('done');
        await injectResult(call, result);
        if (autoSubmit) {
          clickSendButtonWithRetry();
        }
      } catch (err) {
        btn.textContent = '失败';
        btn.classList.add('error');
        btn.disabled = false;
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = '执行中...';
          try {
            const result = await sendWithRetry(
              { type: 'callTool', toolName: call.name, arguments: call.params },
              (attempt, max) => { btn.textContent = `重试中 (${attempt}/${max})...`; }
            );
            btn.textContent = '完成';
            btn.classList.add('done');
            btn.classList.remove('error');
            await injectResult(call, result);
            if (autoSubmit) {
              clickSendButtonWithRetry();
            }
          } catch (err2) {
            btn.textContent = '失败';
            btn.disabled = false;
          }
        }, { once: true });
        console.error('[MCP] 工具调用错误:', err);
      }
    });
  }

  async function executeToolCall(call, card, isBatch = false) {
    const statusEl = card.querySelector('.mcp-call-status');
    const resultEl = card.querySelector('.mcp-call-result');
    const btn = card.querySelector('.mcp-btn-run');

    statusEl.textContent = '执行中...';
    statusEl.className = 'mcp-call-status running';
    btn.disabled = true;

    if (isBatch) {
      pendingExecutions++;
      console.log(`[MCP][auto-send] executeToolCall START: ${call.name}#${call.callId}, pendingExecutions=${pendingExecutions}`);
      // 新的调用开始 → 取消已有的 8s 定时器和 1s 发送定时器
      // 确保在所有调用完成前不会提前发送
      clearTimeout(autoSendTimer);
      autoSendTimer = null;
      clearTimeout(sendRetryTimer);
      sendRetryTimer = null;
    }

    try {
      const result = await sendWithRetry(
        { type: 'callTool', toolName: call.name, arguments: call.params },
        (attempt, max, err) => {
          statusEl.textContent = `重试中 (${attempt}/${max}): ${err.message}`;
        }
      );

      statusEl.textContent = '已完成';
      statusEl.className = 'mcp-call-status completed';
      btn.textContent = '完成';

      const resultText = formatResult(result);
      resultEl.style.display = 'block';
      resultEl.textContent = truncate(resultText, 500);

      // 显示"复制结果"按钮
      showCopyResultButton(card, call, result);

      if (isBatch) {
        collectedResults.push({ call, result, error: null });
      } else {
        // 单次手动执行：直接注入（不自动发送，由 inline indicator 或手动触发）
        await injectResult(call, result);
      }
    } catch (e) {
      statusEl.textContent = `失败 (已重试${MAX_RETRIES}次): ${e.message}`;
      statusEl.className = 'mcp-call-status error';
      btn.textContent = '重试';
      btn.disabled = false;

      if (isBatch) {
        collectedResults.push({ call, result: null, error: e });
      }
    } finally {
      if (isBatch) {
        pendingExecutions--;
        console.log(`[MCP][auto-send] executeToolCall END: ${call.name}#${call.callId}, pendingExecutions=${pendingExecutions}, collectedResults=${collectedResults.length}`);
        onBatchExecutionComplete();
      }
    }
  }

  function showCopyResultButton(card, call, result) {
    const copyBtn = card.querySelector('.mcp-btn-copy-result');
    if (!copyBtn) return;
    copyBtn.style.display = 'inline-block';
    copyBtn.addEventListener('click', async () => {
      const resultText = formatResult(result);
      const block = [
        '```jsonl',
        JSON.stringify({ type: 'function_result_start', call_id: call.callId }),
        JSON.stringify({ type: 'content', text: resultText }),
        JSON.stringify({ type: 'function_result_end', call_id: call.callId }),
        '```',
      ].join('\n');
      const fullContent = `Here is the result of the MCP tool call "${call.name}":\n\n${block}`;

      try {
        await navigator.clipboard.writeText(fullContent);
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制结果'; }, 2000);
      } catch (e) {
        // 回退：使用 textarea + execCommand
        const ta = document.createElement('textarea');
        ta.value = fullContent;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制结果'; }, 2000);
      }
    }, { once: false });
  }

  function onBatchExecutionComplete() {
    console.log(`[MCP][auto-send] onBatchExecutionComplete: pendingExecutions=${pendingExecutions}, collectedResults=${collectedResults.length}`);
    if (pendingExecutions > 0) return;

    // 所有批量执行完成，收集成功结果 → 累积到 accumulatedResults
    const successes = collectedResults.filter((r) => r.result !== null);
    const failures = collectedResults.filter((r) => r.error !== null);

    if (successes.length > 0) {
      accumulatedResults.push(...successes);
      console.log(`[MCP] 累积结果: +${successes.length}，总计 ${accumulatedResults.length} 个`);
    }

    if (failures.length > 0) {
      accumulatedResults.push(...failures);
      console.log(`[MCP] 累积错误: +${failures.length}，将错误报告发送给AI自我纠错`);
    }

    // 清空本轮收集的结果（已转移到 accumulatedResults）
    collectedResults = [];

    // 取消之前的 8s 定时器，重新开始计时
    // 这样如果后续还有新的工具调用完成，会再次重置定时器
    // 最终效果：最后一个 MCP 返回后 8s 才发送
    clearTimeout(autoSendTimer);
    autoSendTimer = null;

    if (accumulatedResults.length > 0) {
      autoSendTimer = setTimeout(() => {
        autoSendTimer = null;
        // 安全检查：如果此时仍有调用在执行，不注入，等调用完成后重新计时
        if (pendingExecutions > 0) {
          console.log('[MCP] 定时器到期但仍有调用在执行，跳过注入，等待完成后重新计时');
          return;
        }
        console.log(`[MCP] ${autoSendDelay}s 定时器到期，统一注入 ${accumulatedResults.length} 个结果`);
        const resultsToInject = accumulatedResults.slice(); // 复制一份
        accumulatedResults = [];
        injectBatchResults(resultsToInject);
      }, autoSendDelay * 1000);
      console.log(`[MCP] 已启动/重置 ${autoSendDelay}s 自动发送定时器`);
    }
  }

  async function injectBatchResults(results) {
    console.log(`[MCP][auto-send] injectBatchResults: ${results.length} results, autoSubmit=${autoSubmit}`);
    // 区分成功和失败
    const hasErrors = results.some((r) => r.error !== null);
    const hasSuccesses = results.some((r) => r.result !== null);
    const toolNames = results.map((r) => r.call.name).join(', ');

    // 粘贴拦截关闭时，直接以纯文本注入，不创建 .md 文件
    if (!pasteIntercept) {
      console.log('[MCP] pasteIntercept=OFF, 批量结果以纯文本注入');
      const combinedBlocks = results.map(({ call, result, error }) => {
        const contentText = error
          ? `ERROR: ${error.message}\n\nParameters used:\n${JSON.stringify(call.params, null, 2)}\n\nPlease analyze the error, fix the parameters, and retry this tool call.`
          : formatResult(result);
        return [
          '```jsonl',
          JSON.stringify({ type: 'function_result_start', call_id: call.callId }),
          JSON.stringify({ type: 'content', text: contentText }),
          JSON.stringify({ type: 'function_result_end', call_id: call.callId }),
          '```',
        ].join('\n');
      }).join('\n\n');

      if (hasErrors) {
        setInputValue(`MCP tool calls [${toolNames}] encountered errors. Please analyze and retry:\n\n${combinedBlocks}`);
      } else {
        setInputValue(`Here are the results of the MCP tool calls [${toolNames}]:\n\n${combinedBlocks}`);
      }

      if (autoSubmit) {
        console.log('[MCP][auto-send] autoSubmit=true, calling clickSendButtonWithRetry()');
        clickSendButtonWithRetry();
      }
      return;
    }

    // 构建合并的 .md 内容（同时支持成功结果和错误报告）
    const blocks = results.map(({ call, result, error }) => {
      if (error) {
        // 错误结果：包含错误信息和使用的参数，让 AI 可以分析并纠错
        const paramsText = JSON.stringify(call.params, null, 2);
        const errorContent = `ERROR: ${error.message}\n\nParameters used:\n${paramsText}\n\nPlease analyze the error, fix the parameters, and retry this tool call.`;
        return [
          `## Tool Error: ${call.name} (call_id: ${call.callId})`,
          '',
          '```jsonl',
          JSON.stringify({ type: 'function_result_start', call_id: call.callId }),
          JSON.stringify({ type: 'content', text: errorContent }),
          JSON.stringify({ type: 'function_result_end', call_id: call.callId }),
          '```',
        ].join('\n');
      } else {
        // 成功结果
        const resultText = formatResult(result);
        return [
          `## Tool: ${call.name} (call_id: ${call.callId})`,
          '',
          '```jsonl',
          JSON.stringify({ type: 'function_result_start', call_id: call.callId }),
          JSON.stringify({ type: 'content', text: resultText }),
          JSON.stringify({ type: 'function_result_end', call_id: call.callId }),
          '```',
        ].join('\n');
      }
    });

    const mdTitle = hasErrors ? '# MCP Tool Results (with errors)' : '# MCP Tool Results';
    const fullMdContent = `${mdTitle}\n\n${blocks.join('\n\n')}`;
    // Gemini 仅接受 text/plain，其他平台用 text/markdown
    const fileMimeType = PLATFORM === 'gemini' ? 'text/plain' : 'text/markdown';
    const file = new File([fullMdContent], `mcp-results-batch.md`, {
      type: fileMimeType,
      lastModified: Date.now(),
    });

    let attached = false;

    // Gemini 专用路径：直接走 dragDropListener.js postMessage 机制（Gemini 不支持 fileInput）
    if (!attached && PLATFORM === 'gemini') {
      try {
        attached = await geminiDropFile(file);
        if (attached) console.log('[MCP] 批量结果通过拖放注入成功');
      } catch (e) {
        console.warn('[MCP] 批量结果拖放注入失败:', e);
      }
    }

    // 策略 1: 文件输入框（非 Gemini 平台）
    if (!attached && PLATFORM !== 'gemini') {
      const fileInput = await findFileInputWithRetry();
      if (fileInput) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] 批量结果文件输入注入失败:', e);
        }
      }
    }

    // 策略 2: 通用拖放（非 Gemini 平台的后备方案）
    if (!attached) {
      const dropZone = getDropZone();
      if (dropZone) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
          dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
          dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] 批量结果拖放注入失败:', e);
        }
      }
    }

    // 策略 3: 粘贴事件
    if (!attached) {
      const inputEl = getInputElement();
      if (inputEl) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          inputEl.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] 批量结果粘贴注入失败:', e);
        }
      }
    }

    if (attached) {
      if (hasErrors && hasSuccesses) {
        setInputValue(`The results of MCP tools [${toolNames}] are attached as a .md file. Some tools returned errors. Please read the attachment, analyze the errors, fix the parameters, and retry the failed tools.`);
      } else if (hasErrors) {
        setInputValue(`MCP tool calls [${toolNames}] returned errors. The error details are attached as a .md file. Please read the attachment, analyze the errors, fix the parameters, and retry.`);
      } else {
        setInputValue(`The results of MCP tools [${toolNames}] are attached as a .md file. Please read the attachment and continue.`);
      }
    } else {
      // 回退：合并文本直接粘贴
      const combinedBlocks = results.map(({ call, result, error }) => {
        const contentText = error
          ? `ERROR: ${error.message}\n\nParameters used:\n${JSON.stringify(call.params, null, 2)}\n\nPlease analyze the error, fix the parameters, and retry this tool call.`
          : formatResult(result);
        return [
          '```jsonl',
          JSON.stringify({ type: 'function_result_start', call_id: call.callId }),
          JSON.stringify({ type: 'content', text: contentText }),
          JSON.stringify({ type: 'function_result_end', call_id: call.callId }),
          '```',
        ].join('\n');
      }).join('\n\n');

      if (hasErrors) {
        setInputValue(`MCP tool calls [${toolNames}] encountered errors. Please analyze and retry:\n\n${combinedBlocks}`);
      } else {
        setInputValue(`Here are the results of the MCP tool calls [${toolNames}]:\n\n${combinedBlocks}`);
      }
    }

    if (autoSubmit) {
      console.log('[MCP][auto-send] autoSubmit=true, calling clickSendButtonWithRetry()');
      clickSendButtonWithRetry();
    } else {
      console.log('[MCP][auto-send] autoSubmit=false, skipping auto-send');
    }
  }

  // ==================== 结果格式化与注入 ====================
  function formatResult(result) {
    if (!result) return 'null';
    if (result.content && Array.isArray(result.content)) {
      return result.content.map((c) => c.text || JSON.stringify(c)).join('\n');
    }
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }

  function createResultFile(call, resultMdContent) {
    // Gemini 仅接受 text/plain，其他平台用 text/markdown
    const fileMimeType = PLATFORM === 'gemini' ? 'text/plain' : 'text/markdown';
    return new File([resultMdContent], `mcp-result-${call.name}-${call.callId}.md`, {
      type: fileMimeType,
      lastModified: Date.now(),
    });
  }

  async function injectResult(call, result) {
    const resultText = formatResult(result);

    const block = [
      '```jsonl',
      JSON.stringify({ type: 'function_result_start', call_id: call.callId }),
      JSON.stringify({ type: 'content', text: resultText }),
      JSON.stringify({ type: 'function_result_end', call_id: call.callId }),
      '```',
    ].join('\n');

    // 粘贴拦截关闭时，直接以纯文本注入，不创建 .md 文件
    if (!pasteIntercept) {
      console.log('[MCP] pasteIntercept=OFF, 直接以纯文本注入结果');
      const fullText = `Here is the result of the MCP tool call "${call.name}":\n\n${block}`;
      setInputValue(fullText);
      return;
    }

    const fullMdContent = `# MCP Tool Result: ${call.name}\n\n${block}`;
    const file = createResultFile(call, fullMdContent);

    let attached = false;

    // Gemini 专用路径：直接走 dragDropListener.js postMessage 机制（Gemini 不支持 fileInput）
    if (!attached && PLATFORM === 'gemini') {
      try {
        attached = await geminiDropFile(file);
        if (attached) console.log('[MCP] 结果通过拖放注入成功');
      } catch (e) {
        console.warn('[MCP] 结果拖放注入失败:', e);
      }
    }

    // 策略 1: 通过文件输入框注入（非 Gemini 平台）
    if (!attached && PLATFORM !== 'gemini') {
      const fileInput = await findFileInputWithRetry();
      if (fileInput) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] 结果文件输入注入失败:', e);
        }
      }
    }

    // 策略 2: 通用拖放（非 Gemini 平台的后备方案）
    if (!attached) {
      const dropZone = getDropZone();
      if (dropZone) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
          dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
          dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] 结果拖放注入失败:', e);
        }
      }
    }

    // 策略 3: 通过粘贴事件注入
    if (!attached) {
      const inputEl = getInputElement();
      if (inputEl) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          inputEl.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
          attached = true;
        } catch (e) {
          console.warn('[MCP] 结果粘贴注入失败:', e);
        }
      }
    }

    if (attached) {
      // 在输入框留一条简短提示（AI 可读）
      setInputValue(`The result of MCP tool "${call.name}" is attached as a .md file. Please read the attachment and continue.`);
    } else {
      // 回退：直接粘贴完整结果
      const fullText = `Here is the result of the MCP tool call "${call.name}":\n\n${block}`;
      setInputValue(fullText);
    }
    // 注意: autoSubmit 逻辑已移至 injectBatchResults() 和 inline indicator 处理
  }

  // ==================== MCP 提示词生成 ====================
  function generateMCPPrompt() {
    // 只处理已选服务器的工具
    const selectedTools = allTools.filter(t => {
      const key = t.serverName || 'Default';
      return selectedServers.has(key);
    });

    if (selectedTools.length === 0) {
      return '(No MCP tools selected. Please select servers in the Tools tab.)';
    }

    // 按服务器分组
    const grouped = {};
    for (const t of selectedTools) {
      const key = t.serverName || 'Default';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(t);
    }

    // 生成工具列表部分
    let toolSection = '';
    for (const [server, tools] of Object.entries(grouped)) {
      toolSection += `### Server: ${server}\n\n`;
      for (const t of tools) {
        toolSection += `- **${t.name}**`;
        if (t.description) toolSection += ` — ${t.description}`;
        toolSection += '\n';
        if (t.inputSchema && t.inputSchema.properties) {
          const props = t.inputSchema.properties;
          const required = t.inputSchema.required || [];
          toolSection += '  Parameters:\n';
          for (const [pName, pSchema] of Object.entries(props)) {
            const req = required.includes(pName) ? ' (required)' : ' (optional)';
            const type = pSchema.type || 'any';
            const desc = pSchema.description || '';
            toolSection += `    - \`${pName}\` (${type}${req}): ${desc}\n`;
          }
        }
        toolSection += '\n';
      }
    }

    const prompt = `[MCP Bridge Operational Instructions][IMPORTANT]

<system>

You are an AI assistant with access to external MCP (Model Context Protocol) tools. You MUST actively use these tools to help the user accomplish tasks. When a user's request can be fulfilled or enhanced by using available tools, you SHOULD proactively invoke the appropriate tool rather than attempting to answer from memory alone.

Your job is to analyze the user's request, determine which tool(s) to use, output the function call in the exact format specified below, and then WAIT for the execution result before continuing.

## Function Call Format

All function calls MUST be wrapped in a \`\`\`jsonl\`\`\` code block on a NEW LINE. This is a strict requirement.

<example_function_call>

\`\`\`jsonl
{"type": "function_call_start", "name": "function_name", "call_id": 1}
{"type": "description", "text": "Brief description of what this function call does"}
{"type": "parameter", "key": "param_1", "value": "value_1"}
{"type": "parameter", "key": "param_2", "value": "value_2"}
{"type": "function_call_end", "call_id": 1}
\`\`\`

</example_function_call>

<example_multi_call>

When tasks are independent and parallelizable, you can make multiple calls at once. IMPORTANT: Each call MUST be in its OWN SEPARATE \`\`\`jsonl\`\`\` code block. Do NOT put multiple calls in the same code block.

\`\`\`jsonl
{"type": "function_call_start", "name": "tool_a", "call_id": 1}
{"type": "description", "text": "First independent task"}
{"type": "parameter", "key": "param_1", "value": "value_1"}
{"type": "function_call_end", "call_id": 1}
\`\`\`

\`\`\`jsonl
{"type": "function_call_start", "name": "tool_b", "call_id": 2}
{"type": "description", "text": "Second independent task"}
{"type": "parameter", "key": "param_1", "value": "value_2"}
{"type": "function_call_end", "call_id": 2}
\`\`\`

</example_multi_call>

## Rules for Function Calls

1. ALWAYS analyze what function calls would be appropriate for the user's task.
2. ALWAYS format your function call EXACTLY as specified above — JSON Lines inside a \`\`\`jsonl\`\`\` code block.
3. Each function call MUST have a unique \`call_id\` (integer, starting from 1, incrementing by 1).
4. Include ALL required parameters. Do NOT make up values for optional parameters — only include them when needed.
5. Parameter values MUST be valid JSON values (strings in quotes, numbers without quotes, booleans as true/false, arrays as [...], objects as {...}).
6. You MAY invoke multiple function calls in a single response when the calls are independent and can be executed in parallel. Each call must have a unique \`call_id\`. **CRITICAL: Each call MUST be in its own SEPARATE \`\`\`jsonl\`\`\` code block.** Do NOT combine multiple calls into one code block — the detection system processes each code block independently, so merging them will cause calls to be missed. If the calls depend on each other (e.g., the second call needs the result of the first), make them in separate responses.
7. After outputting a function call, STOP immediately. Do NOT continue writing. Wait for the execution result.
8. NEVER fabricate, simulate, or guess function results. You MUST wait for the actual execution result provided by the user.
9. Do NOT refer to tool names when speaking to the user — focus on what you are doing, not which tool you are using.
10. When you receive a function result, analyze it and either provide the final answer or make the next function call as needed.

## Function Result Format

After a function is executed, the result will be provided in this format:

\`\`\`jsonl
{"type": "function_result_start", "call_id": 1}
{"type": "content", "text": "result content here"}
{"type": "function_result_end", "call_id": 1}
\`\`\`

## Response Format

When you need to use a tool, structure your response like this:

1. First, briefly explain your reasoning — what the user is asking, and why you are choosing this tool.
2. Then output the function call in the exact \`\`\`jsonl\`\`\` format.
3. STOP. Do not write anything after the function call code block.

## Agent Mode

You support an **Agent Mode** that can be activated by the user. When the user says phrases like "enter agent mode", "agent mode", "进入agent模式", "自主模式", "agentic mode", or similar instructions, you MUST switch to Agent Mode and follow these rules:

### Agent Mode Behavior

In Agent Mode, you act as an **autonomous agent** that proactively and iteratively uses tools to accomplish the user's goal. You do NOT stop after a single tool call — instead, you operate in a continuous loop:

1. **Analyze** the user's request and break it down into steps.
2. **Call** the appropriate tool(s) to begin working on the task.
3. **Receive** the tool result and **evaluate** whether the result is satisfactory and whether the task is complete.
4. **If NOT complete**: explain what you learned, what is still missing or unsatisfactory, and immediately make the next tool call. Do NOT ask the user for permission to continue — just keep going.
5. **If complete**: provide a comprehensive summary of everything you did, the results obtained, and any conclusions or recommendations.

### Agent Mode Rules

1. **Be proactive**: Do not wait for the user to tell you the next step. Decide on your own what tool to call next based on the results you have received so far.
2. **Be persistent**: If a tool call returns an error or unsatisfactory result, try a different approach, adjust parameters, or use a different tool. Do not give up after one failure.
3. **Be iterative**: Keep calling tools in a loop until the task is fully accomplished. Each response should contain either a tool call (to continue working) or a final summary (when done).
4. **Explain your reasoning**: Before each tool call, briefly explain what you learned from the previous result and why you are making the next call.
5. **Respect the format**: All tool calls must still follow the exact \`\`\`jsonl\`\`\` format specified above — each call in its own separate code block. After each tool call, STOP and wait for the result.
6. **Know when to stop**: Stop the loop when: (a) the user's goal is fully achieved, (b) you have exhausted all reasonable approaches, or (c) the user explicitly asks you to stop. When stopping, always provide a detailed summary.
7. **Multi-step planning**: At the start of Agent Mode, outline your plan (the steps you intend to take). Update the plan as you learn more from tool results.
8. **Cross-verify search results**: For search-related tasks, NEVER rely on a single search. Always perform multiple searches with different keywords, phrasings, or angles to cross-verify the information. If the first search result seems incomplete, inaccurate, or lacks detail, immediately try alternative search queries. Compare results from different searches to identify the most accurate and reliable information. Only include information in your final summary that has been confirmed by multiple sources or searches.
9. **Quality over speed**: Do not rush to conclusions. If the results you have gathered are insufficient, ambiguous, or conflicting, keep searching and investigating until you have high-confidence answers. It is better to make 5 thorough tool calls than to deliver a shallow answer based on 1 call.

### Example Agent Mode Flow

User: "Enter agent mode. Research the latest benchmark scores of GPT-5 and Claude 4."

Response 1: "I'll enter Agent Mode. My plan: 1) Search for GPT-5 benchmarks, 2) Search for Claude 4 benchmarks, 3) Cross-verify with additional searches, 4) Compare and summarize. Let me start with two parallel searches."

\`\`\`jsonl
{"type": "function_call_start", "name": "web_search", "call_id": 1}
{"type": "description", "text": "Search for GPT-5 benchmark scores"}
{"type": "parameter", "key": "query", "value": "GPT-5 benchmark scores MMLU HumanEval"}
{"type": "function_call_end", "call_id": 1}
\`\`\`

\`\`\`jsonl
{"type": "function_call_start", "name": "web_search", "call_id": 2}
{"type": "description", "text": "Search for Claude 4 benchmark scores"}
{"type": "parameter", "key": "query", "value": "Claude 4 benchmark scores MMLU HumanEval"}
{"type": "function_call_end", "call_id": 2}
\`\`\`

Response 2: "Got initial results but the MMLU scores seem inconsistent across sources. Let me cross-verify with a more specific search."

\`\`\`jsonl
{"type": "function_call_start", "name": "web_search", "call_id": 3}
{"type": "description", "text": "Cross-verify GPT-5 MMLU score from official source"}
{"type": "parameter", "key": "query", "value": "GPT-5 official technical report MMLU score"}
{"type": "function_call_end", "call_id": 3}
\`\`\`

Response 3 (final): "Agent Mode complete. After cross-verification across 3 searches, here are the confirmed benchmark scores: [comprehensive comparison table with verified data and source references]"

### Exiting Agent Mode

Agent Mode remains active until: the user says "exit agent mode", "退出agent模式", "stop agent mode", or similar, OR until you have fully completed the task and delivered the final summary. After exiting, return to normal response mode.

## Available Tools

${toolSection}
</system>

IMPORTANT: Function calls must be placed in a proper \`\`\`jsonl\`\`\` code block exactly as shown above. After outputting a function call, STOP and wait for the result.`;

    return prompt;
  }

  // ==================== .md 文件附加 ====================
  function createMCPPromptFile() {
    const prompt = generateMCPPrompt();
    // Gemini 仅接受 text/plain，其他平台用 text/markdown
    const fileMimeType = PLATFORM === 'gemini' ? 'text/plain' : 'text/markdown';
    return new File([prompt], 'mcp-tools.md', { type: fileMimeType, lastModified: Date.now() });
  }

  async function attachMCPPromptFile() {
    if (selectedServers.size === 0) {
      showNotification('请先在工具栏勾选至少一个 MCP 服务器。');
      return;
    }

    const file = createMCPPromptFile();

    // Gemini 专用路径：直接走 dragDropListener.js postMessage 机制（Gemini 不支持 fileInput）
    if (PLATFORM === 'gemini') {
      try {
        const success = await geminiDropFile(file);
        if (success) {
          showNotification('MCP 提示词文件已通过拖放附加。');
          return;
        }
      } catch (e) {
        console.warn('[MCP] 提示词文件拖放注入失败:', e);
      }
    }

    // 策略 1: 文件输入框（非 Gemini 平台）
    if (PLATFORM !== 'gemini') {
      const fileInput = await findFileInputWithRetry();
      if (fileInput) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          showNotification('MCP 提示词文件已通过文件输入附加。');
          return;
        } catch (e) {
          console.warn('[MCP] 文件输入注入失败:', e);
        }
      }
    }

    // 策略 2: 通用拖放
    const dropZone = getDropZone();
    if (dropZone) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        showNotification('MCP 提示词文件已拖放到输入区域。');
        return;
      } catch (e) {
        console.warn('[MCP] 拖放注入失败:', e);
      }
    }

    // 策略 3: 粘贴事件
    const inputEl = getInputElement();
    if (inputEl) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        inputEl.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        showNotification('MCP 提示词文件已粘贴到输入区域。');
        return;
      } catch (e) {
        console.warn('[MCP] 粘贴注入失败:', e);
      }
    }

    // 回退：下载文件
    downloadMCPPrompt();
    showNotification('无法自动附加文件，已下载到本地，请手动附加。');
  }

  function downloadMCPPrompt() {
    if (selectedServers.size === 0) {
      showNotification('请先在工具栏勾选至少一个 MCP 服务器。');
      return;
    }

    const file = createMCPPromptFile();
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mcp-tools.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showNotification('MCP 提示词文件已下载。');
  }

  async function copyMCPPrompt() {
    if (selectedServers.size === 0) {
      showNotification('请先在工具栏勾选至少一个 MCP 服务器。');
      return;
    }

    const prompt = generateMCPPrompt();
    try {
      await navigator.clipboard.writeText(prompt);
      showNotification('MCP 提示词已复制到剪贴板。');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = prompt;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showNotification('MCP 提示词已复制到剪贴板。');
    }
  }

  // ==================== 平台文件输入 / 拖放区域辅助 ====================

   // Gemini-specific: click the upload button to trigger file input creation, then find it
  async function findFileInputWithRetry(maxWait = 3000) {
    // Try existing file input first
    let input = findFileInput();
    if (input) return input;

    // For Gemini, try clicking the upload/attachment button to create the file input
    if (PLATFORM === 'gemini') {
      const uploadBtn = document.querySelector('button[aria-label*="upload" i]') ||
        document.querySelector('button[aria-label*="attach" i]') ||
        document.querySelector('button[aria-label*="file" i]') ||
        document.querySelector('button[data-tooltip*="upload" i]') ||
        document.querySelector('button[data-tooltip*="attach" i]') ||
        document.querySelector('[class*="upload" i] button') ||
        document.querySelector('[class*="attach" i] button');
      if (uploadBtn) {
        uploadBtn.click();
        // Wait for the file input to appear in DOM
        const start = Date.now();
        while (Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, 200));
          input = document.querySelector('input[type="file"]');
          if (input) return input;
        }
      }
    }

    // For ChatGPT, try clicking the upload/attachment button to create the file input
    if (PLATFORM === 'chatgpt') {
      const uploadBtn = document.querySelector('button[data-testid="composer-action-file-upload"]') ||
        document.querySelector('#upload-file-btn') ||
        document.querySelector('button[aria-label*="Attach" i]') ||
        document.querySelector('button[aria-label*="Add photos" i]') ||
        document.querySelector('button[aria-label*="upload" i]') ||
        document.querySelector('button[aria-label*="file" i]');
      if (uploadBtn) {
        uploadBtn.click();
        // Wait for the file input to appear in DOM
        const start = Date.now();
        while (Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, 200));
          input = document.querySelector('input[type="file"][multiple]') ||
            document.querySelector('input[type="file"]');
          if (input) return input;
        }
      }
    }

    return null;
  }

  function findFileInput() {
    switch (PLATFORM) {
      case 'chatgpt':
        return document.querySelector('input[type="file"][multiple]') ||
          document.querySelector('input[type="file"][accept*="*"]') ||
          document.querySelector('input[type="file"]');
      case 'gemini':
        return document.querySelector('input[type="file"]');
      case 'deepseek':
        return document.querySelector('input[type="file"]');
      case 'grok':
        return document.querySelector('input[type="file"]');
      case 'perplexity':
        return document.querySelector('input[type="file"]');
      case 'aistudio':
        return document.querySelector('input[type="file"]');
      case 'mistral':
        return document.querySelector('input[type="file"]');
      case 'kimi':
        return document.querySelector('input[type="file"]');
      case 'qwen':
        return document.querySelector('input[type="file"]');
      case 'chatglm':
        return document.querySelector('input[type="file"]');
      case 't3':
        return document.querySelector('input[type="file"]');
      case 'copilot':
        return document.querySelector('input[type="file"]');
      case 'doubao':
        return document.querySelector('input[type="file"]');
      default:
        return document.querySelector('input[type="file"]');
    }
  }

  function getDropZone() {
    switch (PLATFORM) {
      case 'chatgpt':
        return document.querySelector('#prompt-textarea') ||
          document.querySelector('.ProseMirror') ||
          document.querySelector('[data-testid="composer-text-input"]') ||
          document.querySelector('.composer-parent') ||
          document.querySelector('div[contenteditable="true"]')?.closest('form') ||
          document.querySelector('main');
      case 'gemini':
        return document.querySelector('div[xapfileselectordropzone]') ||
          document.querySelector('.text-input-field') ||
          document.querySelector('.input-area') ||
          document.querySelector('.ql-editor') ||
          document.querySelector('.input-area-container') ||
          document.querySelector('div[contenteditable="true"]')?.parentElement;
      case 'deepseek':
        return document.querySelector('textarea#chat-input')?.closest('div[class*="input"]') ||
          document.querySelector('textarea')?.parentElement;
      case 'grok':
        return document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 'perplexity':
        return document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 'aistudio':
        return document.querySelector('textarea')?.closest('div') ||
          document.querySelector('textarea')?.parentElement;
      case 'mistral':
        return document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 'kimi':
        return document.querySelector('div[contenteditable="true"]')?.parentElement;
      case 'qwen':
        return document.querySelector('textarea#chat-input')?.closest('form') ||
          document.querySelector('textarea#chat-input')?.parentElement ||
          document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 'chatglm':
        return document.querySelector('div[contenteditable="true"]')?.parentElement ||
          document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 't3':
        return document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 'copilot':
        return document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      case 'doubao':
        return document.querySelector('div[contenteditable="true"]')?.parentElement ||
          document.querySelector('textarea')?.closest('form') ||
          document.querySelector('textarea')?.parentElement;
      default:
        return document.querySelector('textarea')?.parentElement ||
          document.querySelector('div[contenteditable="true"]')?.parentElement;
    }
  }

  // ==================== 平台适配器 ====================
  function getInputElement() {
    switch (PLATFORM) {
      case 'chatgpt':
        return document.querySelector('#prompt-textarea') ||
          document.querySelector('.ProseMirror[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"][data-id*="prompt"]') ||
          document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('textarea');
      case 'deepseek':
        return document.querySelector('textarea#chat-input') ||
          document.querySelector('textarea');
      case 'gemini':
        return document.querySelector('div.ql-editor.textarea p') ||
          document.querySelector('div.ql-editor.textarea') ||
          document.querySelector('.ql-editor p') ||
          document.querySelector('.ql-editor') ||
          document.querySelector('div[contenteditable="true"]');
      case 'grok':
        return document.querySelector('textarea') ||
          document.querySelector('div[contenteditable="true"]');
      case 'perplexity':
        return document.querySelector('textarea') ||
          document.querySelector('div[contenteditable="true"]');
      case 'aistudio':
        return document.querySelector('textarea') ||
          document.querySelector('div[contenteditable="true"]');
      case 'mistral':
        return document.querySelector('textarea') ||
          document.querySelector('div[contenteditable="true"]');
      case 'kimi':
        return document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('textarea');
      case 'qwen':
        return document.querySelector('textarea#chat-input') ||
          document.querySelector('textarea') ||
          document.querySelector('div[contenteditable="true"]');
      case 'chatglm':
        return document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('textarea');
      case 'doubao':
        return document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('textarea');
      default:
        return document.querySelector('textarea') ||
          document.querySelector('div[contenteditable="true"]');
    }
  }

  function setInputValue(text) {
    const el = getInputElement();
    if (!el) {
      console.warn('[MCP] 找不到输入框元素');
      navigator.clipboard?.writeText(text).then(() => {
        showNotification('结果已复制到剪贴板（未找到输入框）');
      });
      return;
    }

    el.focus();

    if (PLATFORM === 'chatgpt') {
      // ChatGPT ProseMirror 专用：需要创建 <p> 元素结构
      const placeholder = el.querySelector('[data-placeholder]');
      if (placeholder) placeholder.remove();
      el.innerHTML = '';
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      el.appendChild(paragraph);
      // 将光标移到末尾
      const range = document.createRange();
      const selection = window.getSelection();
      if (selection && paragraph.firstChild) {
        range.setStartAfter(paragraph.lastChild || paragraph);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    } else if (PLATFORM === 'gemini') {
      // Gemini Quill 编辑器专用：直接设置 textContent
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    } else if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      // 标准 textarea/input（DeepSeek 等）
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      if (setter) {
        setter.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // 其他 contenteditable 平台（execCommand 方式）
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  function clickSendButtonWithRetry() {
    // 取消之前的发送定时器（防止重复发送）
    clearTimeout(sendRetryTimer);
    console.log(`[MCP][auto-send] clickSendButtonWithRetry: scheduling ${fileParsDelay}s delay send (等待平台解析文件)`);
    // 等待平台解析上传的文件（大模型解析文件一般需要数秒，用户可在设置中调整）
    sendRetryTimer = setTimeout(() => {
      sendRetryTimer = null;
      // 最终安全检查：如果此时有新的调用正在执行，中止发送
      if (pendingExecutions > 0) {
        console.log('[MCP][auto-send] 发送前检测到有调用正在执行，中止自动发送, pendingExecutions=' + pendingExecutions);
        return;
      }

      let sent = false;

      // 策略 1：尝试点击平台的发送按钮（最可靠）
      const sendBtn = findSendButton();
      if (sendBtn) {
        console.log('[MCP][auto-send] 找到发送按钮，点击发送');
        sendBtn.click();
        sent = true;
      }

      // 策略 2：模拟 Enter 键
      if (!sent) {
        const input = getInputElement();
        console.log('[MCP][auto-send] Sending via Enter key, input found:', !!input, 'platform:', PLATFORM);
        if (input) {
          input.focus();
          const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
          input.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
          input.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
          input.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
        }
        // 策略 3：尝试表单提交
        const form = input?.closest('form');
        if (form) {
          try { form.requestSubmit(); } catch (e) { /* ignore */ }
        }
      }

      console.log('[MCP][auto-send] 自动发送完成');
    }, fileParsDelay * 1000);
  }

  function findSendButton() {
    switch (PLATFORM) {
      case 'chatgpt':
        return document.querySelector('[data-testid="send-button"]')
          || document.querySelector('button[data-testid="fruitjuice-send-button"]')
          || document.querySelector('button[aria-label*="Send"]')
          || document.querySelector('form button[class*="send" i]');
      case 'claude':
        return document.querySelector('button[aria-label="Send Message"]')
          || document.querySelector('div.flex button:last-child');
      case 'gemini':
        return document.querySelector('button.mat-mdc-icon-button.send-button')
          || document.querySelector('button.send-button')
          || document.querySelector('button[aria-label*="Send"]')
          || document.querySelector('button[data-testid="send-button"]')
          || document.querySelector('mat-icon[data-mat-icon-name="send"]')?.closest('button');
      case 'deepseek':
        return document.querySelector('div[class*="chat-input"] button:not([disabled])')
          || document.querySelector('textarea + button')
          || document.querySelector('div[role="presentation"] button[class*="send" i]');
      case 'qianwen':
        return document.querySelector('button[class*="send" i]')
          || document.querySelector('div[class*="chat-input"] button');
      case 'doubao':
        return document.querySelector('div[class*="send-btn"]')
          || document.querySelector('button[class*="send" i]')
          || document.querySelector('div[class*="chat-input"] button');
      case 'kimi':
        return document.querySelector('button[class*="send" i]')
          || document.querySelector('div[class*="editor"] ~ button');
      case 'zhipu':
        return document.querySelector('button[class*="send" i]');
      case 'yuanbao':
        return document.querySelector('button[class*="send" i]')
          || document.querySelector('div[class*="input"] button');
      default: {
        // 通用回退：查找输入框附近的按钮
        const candidates = document.querySelectorAll('button');
        for (const btn of candidates) {
          const text = (btn.textContent || '').trim().toLowerCase();
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (text === '发送' || text === 'send' || ariaLabel.includes('send') || ariaLabel.includes('发送')) {
            return btn;
          }
        }
        // 查找 SVG 发送图标按钮（很多平台用 SVG 箭头图标）
        const svgBtns = document.querySelectorAll('button svg');
        for (const svg of svgBtns) {
          const btn = svg.closest('button');
          if (btn && !btn.disabled && btn.offsetParent !== null) {
            // 检查是否在输入区域附近
            const form = btn.closest('form');
            if (form) return btn;
          }
        }
        return null;
      }
    }
  }

  // ==================== 标签页切换 ====================
  function switchTab(name) {
    if (!shadowRoot) return;
    shadowRoot.querySelectorAll('.mcp-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    shadowRoot.querySelectorAll('.mcp-tab-content').forEach((c) => c.classList.remove('active'));
    const map = { tools: 'mcpTabTools', calls: 'mcpTabCalls', skills: 'mcpTabSkills', settings: 'mcpTabSettings' };
    shadowRoot.querySelector(`#${map[name]}`)?.classList.add('active');
  }

  // ==================== 通知 ====================
  function showNotification(msg) {
    if (!shadowRoot) return;
    const existing = shadowRoot.querySelector('.mcp-notification');
    if (existing) existing.remove();

    const notif = document.createElement('div');
    notif.className = 'mcp-notification';
    notif.textContent = msg;
    shadowRoot.querySelector('.mcp-sidebar')?.appendChild(notif);
    setTimeout(() => notif.remove(), 3000);
  }

  // ==================== 监听后台广播 ====================
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'serverStatus') {
      refreshTools();
      refreshServers();
    }
  });

  // ==================== 工具函数 ====================
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function truncate(s, max) {
    return s.length > max ? s.slice(0, max) + '...' : s;
  }

  function stringify(v) {
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  }

  // ==================== 粘贴拦截：MCP 结果文本 → 文件附件 ====================
  function isMCPResultContent(text) {
    // 判定条件：同时包含 jsonl 代码块标记和 MCP 结果标记
    return text.includes('```jsonl') && text.includes('function_result_start');
  }

  async function handleMCPPaste(e) {
    // 开关未启用 → 放行
    if (!pasteIntercept) return;

    // 仅在支持的 AI 平台上拦截
    if (!PLATFORM || PLATFORM === 'unknown') return;

    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;

    // 非 MCP 结果内容 → 放行正常粘贴
    if (!isMCPResultContent(text)) return;

    // 拦截粘贴
    e.preventDefault();
    e.stopImmediatePropagation();

    console.log('[MCP] 检测到 MCP 结果粘贴，转换为文件附件');

    const fileMimeType = PLATFORM === 'gemini' ? 'text/plain' : 'text/markdown';
    const file = new File([text], `mcp-result-paste-${Date.now()}.md`, {
      type: fileMimeType,
      lastModified: Date.now(),
    });

    // Gemini 专用路径：直接走 dragDropListener.js（Gemini 不支持 fileInput）
    if (PLATFORM === 'gemini') {
      try {
        const success = await geminiDropFile(file);
        if (success) {
          showNotification('MCP 结果已作为文件附件注入。');
          return;
        }
      } catch (err) {
        console.warn('[MCP] 粘贴拦截：拖放注入失败:', err);
      }
    }

    // 尝试通过文件输入注入（非 Gemini 平台）
    if (PLATFORM !== 'gemini') {
      const fileInput = findFileInput();
      if (fileInput) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          showNotification('MCP 结果已作为文件附件注入。');
          return;
        } catch (err) {
          console.warn('[MCP] 粘贴拦截：文件输入注入失败:', err);
        }
      }
    }

    // 尝试拖放注入
    const dropZone = getDropZone();
    if (dropZone) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        showNotification('MCP 结果已作为文件附件拖放注入。');
        return;
      } catch (err) {
        console.warn('[MCP] 粘贴拦截：拖放注入失败:', err);
      }
    }

    // 回退：直接粘贴为文本
    const inputEl = getInputElement();
    if (inputEl) {
      setInputValue(text);
      showNotification('文件注入失败，已回退为文字粘贴。');
    }
  }

  // ==================== 初始化 ====================
  function init() {
    console.log(`[MCP Multi Bridge] 已加载，平台: ${PLATFORM}`);
    initSidebar();
    startDetection();

    // 注册粘贴拦截（capturing 阶段，优先于页面自身处理）
    document.addEventListener('paste', handleMCPPaste, true);

    // 初始加载时也设置抑制窗口，防止页面刷新时自动执行历史工具调用
    suppressAutoExecuteUntil = Date.now() + 3000;

    // 延迟自动刷新工具列表，等待服务器连接完成
    // bindSidebarEvents 中会立即调用一次 refreshTools()，
    // 但服务器可能还未连接。这里在 3 秒和 8 秒后再次尝试。
    setTimeout(() => {
      refreshTools();
      refreshServers();
    }, 3000);
    setTimeout(() => {
      refreshTools();
      refreshServers();
    }, 8000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
