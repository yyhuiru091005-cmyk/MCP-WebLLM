// sidepanel.js — MCP Multi Bridge 侧边栏主 UI
// 职责：全部 UI（服务器管理 / 工具 / Skills / 设置 / 对话编排发起 + 状态时间线）。
// 绝不直接操作 AI 网页 DOM —— 一切网页操作通过消息发给 content script 执行。

'use strict';

// ==================== 基础通信 ====================

/** 发消息给 background（MCP 层） */
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

/** 发消息给当前 AI 标签页的 content script */
function sendToContent(msg) {
  return new Promise((resolve, reject) => {
    if (!currentTab.id) return reject(new Error('当前没有受支持的 AI 页面'));
    chrome.tabs.sendMessage(currentTab.id, msg, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('页面无响应（请刷新 AI 页面后重试）'));
      if (!resp.ok) return reject(new Error(resp.error || '未知错误'));
      resolve(resp.data);
    });
  });
}

// ==================== 当前标签页感知 ====================
const MATCH_PATTERNS = (chrome.runtime.getManifest().content_scripts?.[0]?.matches) || [];
const MATCH_REGEXES = MATCH_PATTERNS.map((p) => {
  const re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + re + '$');
});

function isSupportedUrl(url) {
  return !!url && MATCH_REGEXES.some((re) => re.test(url));
}

const currentTab = { id: null, url: '', supported: false, platform: '', caps: [] };

async function refreshCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return updatePageStatus(null);
    currentTab.id = tab.id;
    currentTab.url = tab.url || '';
    currentTab.supported = isSupportedUrl(currentTab.url);
    currentTab.platform = '';
    currentTab.caps = [];
    if (currentTab.supported) {
      try {
        const info = await sendToContent({ type: 'ping' });
        currentTab.platform = info.platform || '';
        currentTab.caps = info.caps || [];
      } catch (_) {
        // content script 未加载（页面早于扩展打开）
        currentTab.supported = false;
        updatePageStatus('stale');
        return;
      }
    }
    updatePageStatus(null);
  } catch (e) {
    console.warn('[MCP] refreshCurrentTab:', e);
  }
}

function updatePageStatus(special) {
  const dot = document.getElementById('pageStatusDot');
  const text = document.getElementById('pageStatusText');
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const hint = document.getElementById('composerHint');

  const canCompose = currentTab.supported && currentTab.caps.includes('compose');

  if (special === 'stale') {
    dot.className = 'dot bad';
    text.textContent = '检测到 AI 页面，但内容脚本未就绪 —— 请刷新该页面';
  } else if (currentTab.supported) {
    dot.className = 'dot ok';
    text.textContent = `已连接：${currentTab.platform || new URL(currentTab.url).hostname}`;
  } else {
    dot.className = 'dot';
    text.textContent = '当前标签页不是受支持的 AI 页面';
  }

  input.disabled = !canCompose;
  sendBtn.disabled = !canCompose;
  hint.textContent = canCompose ? '' : (currentTab.supported ? '' : '打开 ChatGPT 等受支持页面后可用');
}

chrome.tabs.onActivated.addListener(() => refreshCurrentTab());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === currentTab.id && (info.url || info.status === 'complete')) refreshCurrentTab();
});

// ==================== 标签页切换 ====================
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`)?.classList.add('active');
  });
});

// ==================== Toast ====================
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ==================== 服务器管理（原 popup） ====================
const addForm = document.getElementById('addForm');
const transportSel = document.getElementById('serverTransport');

function updateFormFields() {
  const isStdio = transportSel.value === 'stdio';
  document.getElementById('urlRow').style.display = isStdio ? 'none' : '';
  document.getElementById('commandRow').style.display = isStdio ? '' : 'none';
  document.getElementById('argsRow').style.display = isStdio ? '' : 'none';
}
transportSel.addEventListener('change', updateFormFields);
updateFormFields();

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('serverName').value.trim();
  const transport = transportSel.value;
  if (!name) return;

  const btn = addForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = '添加中…';
  try {
    const payload = { type: 'addServer', name, transport };
    if (transport === 'stdio') {
      payload.command = document.getElementById('serverCommand').value.trim() || 'npx';
      payload.args = document.getElementById('serverArgs').value.trim();
    } else {
      payload.url = document.getElementById('serverUrl').value.trim();
      if (!payload.url) { toast('URL 不能为空'); return; }
    }
    await send(payload);
    addForm.reset();
    updateFormFields();
    loadServers();
    refreshTools();
  } catch (err) {
    toast('添加失败：' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '添加服务器';
  }
});

async function loadServers() {
  const listEl = document.getElementById('serverList');
  try {
    const servers = await send({ type: 'getServers' });
    renderServers(servers);
    const connected = servers.filter((s) => s.status === 'connected').length;
    document.getElementById('serverCount').textContent = `${connected}/${servers.length} 已连接`;
  } catch (err) {
    listEl.innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`;
  }
}

function renderServers(servers) {
  const listEl = document.getElementById('serverList');
  if (!servers || servers.length === 0) {
    listEl.innerHTML = '<div class="empty">尚未配置服务器。</div>';
    return;
  }

  listEl.innerHTML = servers.map((s) => {
    const isStdio = s.transport === 'stdio';
    const fields = isStdio
      ? `<div class="edit-field"><label>Command</label><input type="text" class="edit-command" value="${esc(s.command || 'npx')}" /></div>
         <div class="edit-field"><label>Args</label><input type="text" class="edit-args" value="${esc(s.args || '')}" /></div>`
      : `<div class="edit-field"><label>URL</label><input type="text" class="edit-url" value="${esc(s.url || '')}" /></div>`;
    return `
    <div class="server-card" data-id="${s.id}" data-transport="${s.transport || 'sse'}">
      <div class="server-card-header">
        <span class="status-dot ${s.status || 'disconnected'}"></span>
        <span class="server-name">${esc(s.name)}</span>
      </div>
      <div class="server-card-meta"><span>[${esc(s.transport || 'sse')}]</span><span>${s.toolCount || 0} 个工具</span></div>
      ${fields}
      <div class="server-card-actions">
        <label class="toggle-label"><input type="checkbox" class="toggle-enabled" ${s.enabled ? 'checked' : ''} /><span>启用</span></label>
        <button class="btn btn-sm save-btn" style="display:none">保存</button>
        ${s.status === 'connected'
        ? `<button class="btn btn-sm btn-danger disconnect-btn">断开</button>`
        : `<button class="btn btn-sm connect-btn">连接</button>`}
        <button class="btn btn-sm btn-danger remove-btn">删除</button>
      </div>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.server-card').forEach((card) => {
    const id = card.dataset.id;
    const transport = card.dataset.transport;
    const saveBtn = card.querySelector('.save-btn');

    const editInputs = card.querySelectorAll('.edit-url, .edit-command, .edit-args');
    editInputs.forEach((input) => {
      input.addEventListener('input', () => {
        const changed = Array.from(editInputs).some((inp) => inp.value !== inp.getAttribute('value'));
        saveBtn.style.display = changed ? '' : 'none';
      });
    });

    saveBtn?.addEventListener('click', async () => {
      const update = { id };
      if (transport === 'stdio') {
        update.command = card.querySelector('.edit-command')?.value.trim() || '';
        update.args = card.querySelector('.edit-args')?.value.trim() || '';
      } else {
        update.url = card.querySelector('.edit-url')?.value.trim() || '';
      }
      try {
        await send({ type: 'updateServer', server: update });
        setTimeout(() => { loadServers(); refreshTools(); }, 500);
      } catch (err) { toast('保存失败：' + err.message); }
    });

    card.querySelector('.toggle-enabled')?.addEventListener('change', async (e) => {
      try {
        await send({ type: 'toggleServer', serverId: id, enabled: e.target.checked });
        setTimeout(() => { loadServers(); refreshTools(); }, 500);
      } catch (err) {
        toast('切换失败：' + err.message);
        e.target.checked = !e.target.checked;
      }
    });

    card.querySelector('.connect-btn')?.addEventListener('click', async () => {
      try { await send({ type: 'connectServer', serverId: id }); }
      catch (err) { toast('连接失败：' + err.message); }
      setTimeout(() => { loadServers(); refreshTools(); }, 500);
    });

    card.querySelector('.disconnect-btn')?.addEventListener('click', async () => {
      try { await send({ type: 'disconnectServer', serverId: id }); }
      catch (err) { toast('断开失败：' + err.message); }
      setTimeout(() => { loadServers(); refreshTools(); }, 500);
    });

    card.querySelector('.remove-btn')?.addEventListener('click', async () => {
      if (!confirm(`删除服务器「${card.querySelector('.server-name').textContent}」？`)) return;
      try {
        await send({ type: 'removeServer', serverId: id });
        loadServers();
        refreshTools();
      } catch (err) { toast('删除失败：' + err.message); }
    });
  });
}

// ==================== 工具列表 ====================
let allTools = [];
let selectedServers = new Set();

async function refreshTools() {
  try {
    allTools = await send({ type: 'getTools' });
  } catch (e) {
    allTools = [];
  }
  // 恢复选择；「新出现」的服务器默认选中，用户手动取消过的保持取消
  const saved = await chrome.storage.local.get(['mcpSelectedServers', 'mcpKnownServers']);
  const savedSel = Array.isArray(saved.mcpSelectedServers) ? saved.mcpSelectedServers : null;
  const known = new Set(Array.isArray(saved.mcpKnownServers) ? saved.mcpKnownServers : []);
  const names = new Set(allTools.map((t) => t.serverName || t.serverId || 'Default'));
  if (savedSel) {
    selectedServers = new Set(savedSel.filter((n) => names.has(n)));
    for (const n of names) if (!known.has(n)) selectedServers.add(n); // 新服务器默认选中
  } else {
    selectedServers = new Set(names);
  }
  persistSelection();
  renderToolList();
}

function persistSelection() {
  const names = new Set(allTools.map((t) => t.serverName || t.serverId || 'Default'));
  chrome.storage.local.set({
    mcpSelectedServers: [...selectedServers],
    mcpKnownServers: [...names],
  });
}

function renderToolList() {
  const container = document.getElementById('toolList');
  if (allTools.length === 0) {
    container.innerHTML = '<div class="empty">暂无可用工具。请在「服务器」页添加 MCP 服务器。</div>';
    return;
  }

  const grouped = {};
  for (const t of allTools) {
    const key = t.serverName || t.serverId || 'Default';
    (grouped[key] = grouped[key] || []).push(t);
  }

  container.innerHTML = Object.entries(grouped).map(([server, tools]) => `
    <div class="server-group">
      <div class="server-group-header">
        <input type="checkbox" class="server-checkbox" data-server="${esc(server)}" ${selectedServers.has(server) ? 'checked' : ''} />
        <span class="server-group-name">${esc(server)}</span>
        <span class="server-group-meta">${tools.length} 个工具</span>
        <span class="group-caret">▶</span>
      </div>
      <div class="server-group-tools">
        ${tools.map((t) => `
          <div class="tool-item">
            <div class="tool-name">${esc(t.name)}</div>
            <div class="tool-desc">${esc(truncate(t.description || '', 80))}</div>
          </div>`).join('')}
      </div>
    </div>`).join('');

  container.querySelectorAll('.server-group-header').forEach((header) => {
    header.addEventListener('click', (e) => {
      if (e.target.classList.contains('server-checkbox')) return;
      header.closest('.server-group').classList.toggle('open');
    });
  });
  container.querySelectorAll('.server-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedServers.add(cb.dataset.server);
      else selectedServers.delete(cb.dataset.server);
      persistSelection();
    });
  });
}

document.getElementById('refreshToolsBtn').addEventListener('click', () => { refreshTools(); loadServers(); });
document.getElementById('selectAllBtn').addEventListener('click', () => {
  for (const t of allTools) selectedServers.add(t.serverName || t.serverId || 'Default');
  persistSelection();
  renderToolList();
});
document.getElementById('clearSelBtn').addEventListener('click', () => {
  selectedServers = new Set();
  persistSelection();
  renderToolList();
});

// 手动附加工具定义（备用入口，正常情况一步式流程会自动带上）
document.getElementById('attachMdBtn').addEventListener('click', async () => {
  if (selectedServers.size === 0) return toast('请先勾选至少一个服务器');
  try {
    await sendToContent({
      type: 'attachFileAndText',
      fileName: 'mcp-tools.md',
      fileContent: generateMCPPrompt(),
    });
    toast('工具定义已附加到当前 AI 页面');
  } catch (e) {
    toast('附加失败：' + e.message);
  }
});

// ==================== Skills ====================
let skills = [];

async function loadSkills() {
  const result = await chrome.storage.local.get('mcp_skills');
  skills = result.mcp_skills || [];
  renderSkillList();
}

function saveSkills() {
  chrome.storage.local.set({ mcp_skills: skills });
}

function renderSkillList() {
  const list = document.getElementById('skillList');
  if (skills.length === 0) {
    list.innerHTML = '<div class="empty">暂无 Skills。点击上方按钮导入文件夹。</div>';
    return;
  }
  list.innerHTML = skills.map((s) => `
    <label class="skill-item">
      <input type="checkbox" class="skill-checkbox" data-id="${s.id}" />
      <span class="skill-name">${esc(s.name)}</span>
      <span class="skill-meta">${s.files.length} 个文件</span>
    </label>`).join('');
}

function getSelectedSkillIds() {
  return [...document.querySelectorAll('.skill-checkbox:checked')].map((cb) => cb.dataset.id);
}

function buildSkillMarkdown(skill) {
  const lines = [`# Skill: ${skill.name}`, ''];
  for (const f of skill.files) {
    lines.push(`## ${f.name}`, '', f.content, '');
  }
  return lines.join('\n');
}

document.getElementById('importSkillBtn').addEventListener('click', () => {
  document.getElementById('skillFolderInput').click();
});

document.getElementById('skillFolderInput').addEventListener('change', (e) => {
  const fileList = Array.from(e.target.files || []);
  if (fileList.length === 0) return;
  const folderName = fileList[0].webkitRelativePath.split('/')[0] || 'unknown';

  let pending = fileList.length;
  const fileEntries = [];
  const finish = () => {
    fileEntries.sort((a, b) => a.name.localeCompare(b.name));
    const skill = { id: Date.now().toString(), name: folderName, files: fileEntries };
    const existing = skills.findIndex((s) => s.name === folderName);
    if (existing >= 0) skills[existing] = skill;
    else skills.push(skill);
    saveSkills();
    renderSkillList();
    toast(`Skill「${folderName}」已导入（${fileEntries.length} 个文件）`);
  };

  fileList.forEach((file) => {
    const reader = new FileReader();
    const relativePath = file.webkitRelativePath.split('/').slice(1).join('/') || file.name;
    reader.onload = () => {
      fileEntries.push({ name: relativePath, content: reader.result });
      if (--pending === 0) finish();
    };
    reader.onerror = () => { if (--pending === 0 && fileEntries.length > 0) finish(); };
    reader.readAsText(file);
  });
  e.target.value = '';
});

document.getElementById('injectSkillsBtn').addEventListener('click', async () => {
  const ids = getSelectedSkillIds();
  if (ids.length === 0) return toast('请先勾选要注入的 Skill');
  const selected = skills.filter((s) => ids.includes(s.id));
  const combined = selected.map(buildSkillMarkdown).join('\n---\n\n');
  const fileName = selected.length === 1
    ? `skill-${selected[0].name}.md`
    : `skills-combined-${Date.now()}.md`;
  try {
    await sendToContent({ type: 'attachFileAndText', fileName, fileContent: combined });
    toast(`Skill [${selected.map((s) => s.name).join(', ')}] 已注入`);
  } catch (e) {
    toast('注入失败：' + e.message);
  }
});

document.getElementById('deleteSkillBtn').addEventListener('click', () => {
  const ids = getSelectedSkillIds();
  if (ids.length === 0) return toast('请先勾选要删除的 Skill');
  skills = skills.filter((s) => !ids.includes(s.id));
  saveSkills();
  renderSkillList();
  toast(`已删除 ${ids.length} 个 Skill`);
});

// ==================== 设置 ====================
// 与 content script 共享同一组 chrome.storage.local 键；content 通过 storage.onChanged 热更新
const SETTING_DEFAULTS = {
  mcpAutoExecute: true,   // 一步式体验默认开启
  mcpAutoSubmit: true,
  mcpPasteIntercept: true,
  mcpAutoSendDelay: 4,
  mcpFileParsDelay: 8,
};

async function loadSettings() {
  const result = await chrome.storage.local.get(Object.keys(SETTING_DEFAULTS));
  const val = (k) => (result[k] !== undefined ? result[k] : SETTING_DEFAULTS[k]);
  document.getElementById('setAutoExecute').checked = val('mcpAutoExecute');
  document.getElementById('setAutoSubmit').checked = val('mcpAutoSubmit');
  document.getElementById('setPasteIntercept').checked = val('mcpPasteIntercept');
  document.getElementById('setAutoSendDelay').value = val('mcpAutoSendDelay');
  document.getElementById('setFileParsDelay').value = val('mcpFileParsDelay');
}

document.getElementById('setAutoExecute').addEventListener('change', (e) => {
  chrome.storage.local.set({ mcpAutoExecute: e.target.checked });
});
document.getElementById('setAutoSubmit').addEventListener('change', (e) => {
  chrome.storage.local.set({ mcpAutoSubmit: e.target.checked });
});
document.getElementById('setPasteIntercept').addEventListener('change', (e) => {
  chrome.storage.local.set({ mcpPasteIntercept: e.target.checked });
});
document.getElementById('setAutoSendDelay').addEventListener('change', (e) => {
  const v = Math.max(1, Math.min(30, parseInt(e.target.value) || 4));
  e.target.value = v;
  chrome.storage.local.set({ mcpAutoSendDelay: v });
});
document.getElementById('setFileParsDelay').addEventListener('change', (e) => {
  const v = Math.max(1, Math.min(30, parseInt(e.target.value) || 8));
  e.target.value = v;
  chrome.storage.local.set({ mcpFileParsDelay: v });
});

// ==================== MCP 提示词生成（原 content.js，纯数据逻辑） ====================
function generateMCPPrompt() {
  const selectedTools = allTools.filter((t) => selectedServers.has(t.serverName || 'Default'));
  if (selectedTools.length === 0) {
    return '(No MCP tools selected. Please select servers in the Tools tab.)';
  }

  const grouped = {};
  for (const t of selectedTools) {
    const key = t.serverName || 'Default';
    (grouped[key] = grouped[key] || []).push(t);
  }

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

// ==================== 对话：一步式编排发起 ====================
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

async function composeAndSend() {
  const question = chatInput.value.trim();
  if (!question) return;
  if (selectedServers.size === 0) return toast('请先在「工具」页勾选至少一个服务器');

  sendBtn.disabled = true;
  sendBtn.textContent = '发送中…';
  try {
    const result = await sendToContent({
      type: 'composeAndSend',
      question,
      toolsMd: generateMCPPrompt(),
    });
    chatInput.value = '';
    addTimelineItem({
      key: `compose-${Date.now()}`,
      icon: '✓',
      cls: 'done',
      title: result?.injectedTools ? '已带工具定义发送提问' : '已发送提问（本对话已有工具定义）',
      detail: truncate(question, 80),
    });
  } catch (e) {
    addTimelineItem({
      key: `compose-err-${Date.now()}`,
      icon: '✕',
      cls: 'error',
      title: '发送失败',
      detail: e.message,
    });
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = '发送';
    updatePageStatus(null);
  }
}

sendBtn.addEventListener('click', composeAndSend);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) composeAndSend();
});

// ==================== 状态时间线 ====================
const timelineEl = document.getElementById('timeline');
const tlItems = new Map(); // key → element

function clearTimelineEmpty() {
  timelineEl.querySelector('.empty')?.remove();
}

function addTimelineItem({ key, icon, cls, title, detail, actions }) {
  clearTimelineEmpty();
  let el = tlItems.get(key);
  if (!el) {
    el = document.createElement('div');
    tlItems.set(key, el);
    timelineEl.appendChild(el);
  }
  el.className = `tl-item ${cls || ''}`;
  el.innerHTML = `
    <span class="tl-icon">${icon || '·'}</span>
    <div class="tl-body">
      <div class="tl-title">${esc(title)}</div>
      ${detail ? `<div class="tl-detail">${esc(detail)}</div>` : ''}
      <div class="tl-actions"></div>
    </div>
    <span class="tl-time">${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</span>`;
  if (actions) {
    const actionsEl = el.querySelector('.tl-actions');
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.textContent = a.label;
      btn.addEventListener('click', a.onClick);
      actionsEl.appendChild(btn);
    }
  }
  timelineEl.parentElement.scrollTop = timelineEl.parentElement.scrollHeight;
}

// content script 状态广播 → 时间线
function handleStatusEvent(msg) {
  const key = msg.callKey ? `call-${msg.callKey}` : `${msg.event}-${Date.now()}`;
  switch (msg.event) {
    case 'compose_attached':
      addTimelineItem({ key, icon: '📎', cls: 'done', title: '工具定义已附加', detail: msg.detail });
      break;
    case 'question_sent':
      addTimelineItem({ key, icon: '↑', cls: 'done', title: '提问已发送' });
      break;
    case 'call_detected': {
      const actions = msg.needsManualRun
        ? [{
          label: '执行',
          onClick: () => sendToContent({ type: 'executeCall', callKey: msg.callKey })
            .catch((e) => toast('执行失败：' + e.message)),
        }]
        : undefined;
      addTimelineItem({
        key, icon: '⚙', cls: '',
        title: `检测到调用：${msg.name}`,
        detail: msg.detail,
        actions,
      });
      break;
    }
    case 'call_running':
      addTimelineItem({ key, icon: '⚙', cls: 'running', title: `正在调用 ${msg.name}…`, detail: msg.detail });
      break;
    case 'call_done':
      addTimelineItem({ key, icon: '✓', cls: 'done', title: `已调用 ${msg.name}`, detail: msg.detail });
      break;
    case 'call_error':
      addTimelineItem({ key, icon: '✕', cls: 'error', title: `调用失败：${msg.name}`, detail: msg.detail });
      break;
    case 'results_injected':
      addTimelineItem({ key, icon: '📎', cls: 'done', title: '结果已回注到对话', detail: msg.detail });
      break;
    case 'auto_sent':
      addTimelineItem({ key, icon: '↑', cls: 'done', title: '结果已自动发送，等待 AI 继续' });
      break;
    case 'conversation_switch':
      tlItems.clear();
      timelineEl.innerHTML = '<div class="empty">已切换到新对话。</div>';
      break;
  }
}

// ==================== 后台广播监听 ====================
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'serverStatus') {
    loadServers();
    refreshTools();
  } else if (msg.type === 'mcpStatus') {
    handleStatusEvent(msg);
  }
});

// ==================== 工具函数 ====================
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}
function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ==================== 初始化 ====================
loadServers();
refreshTools();
loadSkills();
loadSettings();
refreshCurrentTab();
// 服务器连接需要时间，延迟再刷两次
setTimeout(() => { loadServers(); refreshTools(); }, 3000);
setTimeout(() => { loadServers(); refreshTools(); }, 8000);
