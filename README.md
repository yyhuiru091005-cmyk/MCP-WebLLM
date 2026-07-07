# MCP Multi Bridge

> **Fork 说明**：本项目基于 [luskB/MCP-WebLLM](https://github.com/luskB/MCP-WebLLM) 修改，原作者 **Jiabao Shang**，遵循 [MIT 许可](./LICENSE)（原 LICENSE 与版权声明保留不变）。感谢原作者的出色工作。
>
> 本 fork 的主要改动：
> - **嵌入式 sidePanel 重构**：悬浮注入框改为 Chrome 官方 `sidePanel` 侧边栏，UI 全部迁入；content script 瘦身为只负责网页操作的"手"（注入、检测、执行、回注）
> - **一步式工具调用**：侧边栏内置输入框，自动完成"附加工具定义 + 提问 + 发送"，不再需要每个对话手动附加 .md（对话级注入标记，同一对话不重复注入）
> - **调用状态可视化**：侧边栏实时时间线 + 网页内低调行内状态标（检测到 → 调用中 → 已完成）
> - **结果消息中文化**：自动回注的结果消息改为简短中文，不再是突兀英文
> - **蓝色融合风 UI**：低饱和蓝、圆角面板、留白与轻投影，跟随系统明暗
> - 更新扩展图标
>
> MCP 连接层（SSE / Streamable HTTP / stdio native host）、检测→执行→注入核心管线均保留原实现。

<div align="center">
  <h3>将本地 MCP 服务器无缝接入各大网页版 AI 助手的浏览器扩展</h3>
  <p>
    <img src="https://img.shields.io/badge/Manifest-V3-blue" alt="Manifest V3" />
    <img src="https://img.shields.io/badge/技术栈-Vanilla%20JS-yellow" alt="Vanilla JS" />
    <img src="https://img.shields.io/badge/依赖-零-green" alt="零依赖" />
    <img src="https://img.shields.io/badge/License-MIT-lightgrey" alt="MIT License" />
  </p>
  <p><b>本项目由 OPENCODE + Claude Opus 4.6 完成</b></p>
  <p><b>本 fork 的改造由 Claude Fable 5（Cowork）+ Claude Opus 4.8 协作完成</b></p>
</div>

---

## 目录

- [项目简介](#项目简介)
- [核心特性](#核心特性)
- [支持的平台](#支持的平台)
- [项目结构](#项目结构)
- [安装指南](#安装指南)
  - [基础安装](#安装步骤)
  - [Stdio 传输安装（Native Messaging）](#stdio-传输安装native-messaging)
- [快速开始](#快速开始)
  - [方式一：SSE / Streamable HTTP](#方式一sse--streamable-http-传输)
  - [方式二：Stdio 直连本地服务器](#方式二stdio-直连本地服务器推荐)
- [详细使用说明](#详细使用说明)
  - [管理 MCP 服务器](#管理-mcp-服务器)
  - [侧边栏功能详解](#侧边栏功能详解)
  - [工具调用流程](#工具调用流程)
  - [提示词系统](#提示词系统)
- [Agent 模式](#agent-模式)
- [高级功能](#高级功能)
  - [自动执行与自动发送](#自动执行与自动发送)
  - [多服务器并发](#多服务器并发)
  - [粘贴拦截](#粘贴拦截)
  - [深色模式](#深色模式)
  - [服务器配置在线编辑](#服务器配置在线编辑)
- [MCP 协议传输方式](#mcp-协议传输方式)
- [技术架构](#技术架构)
- [使用场景示例](#使用场景示例)
- [常见问题](#常见问题)
- [灵感来源与版权说明](#灵感来源与版权说明)
- [许可证](#许可证)

---

## 项目简介

**MCP Multi Bridge** 是一个基于纯原生 JavaScript（Vanilla JS）开发的 Chrome/Edge 浏览器扩展（Manifest V3）。它的核心使命是：**打破网页端 AI 与本地计算机之间的壁垒**。

通过本扩展，你可以直接在 ChatGPT、Gemini、DeepSeek、Kimi 等十余个网页版 AI 助手的对话界面中，无缝调用本地运行的 MCP（Model Context Protocol）工具——例如读取本地文件、查询本地数据库、执行本地脚本、联网搜索等，而不需要使用任何原生客户端。

与社区中流行的基于 React/TypeScript 的前端工程方案不同，本项目主打**极简、透明、无负担**——没有框架、没有打包工具、没有编译步骤，代码所见即所得，克隆即可加载使用。

---

## 核心特性

| 特性 | 说明 |
|------|------|
| **零依赖** | 100% 纯 Vanilla JavaScript + 原生 CSS，无框架、无打包工具 |
| **多平台支持** | 自动识别并注入到 14+ 个主流 AI 网页平台 |
| **多服务器并发** | 同时连接多个 MCP 服务器，工具跨服务器自动调度 |
| **三协议支持** | 原生实现 SSE、Streamable HTTP 和 **Stdio（Native Messaging）** 三种 MCP 传输协议 |
| **Stdio 直连** | 🆕 通过 Chrome Native Messaging 直接启动和管理本地 MCP 进程，无需额外代理 |
| **在线编辑配置** | 🆕 服务器卡片中的 URL / Command / Args 字段支持直接编辑，快速切换目录或参数 |
| **Agent 模式** | 内置完整的 Agent 模式提示词系统，支持 AI 自主迭代调用工具 |
| **自动执行** | 检测到 AI 输出的工具调用后可自动执行并回填结果 |
| **批量处理** | 多个并行工具调用完成后统一注入，防止重复发送 |
| **文件注入** | 将 MCP 结果以 `.md` 文件形式附加，适合大体量输出 |
| **隐私优先** | 数据仅流转于浏览器与本地服务器之间，不经过任何第三方 |
| **设置持久化** | 所有用户偏好（深色模式、自动执行等）持久存储于 `chrome.storage` |

---

## 支持的平台

扩展会自动检测当前访问的网站，并在以下平台中注入 MCP 工具侧边栏：

### 国际主流平台
| 平台 | 域名 |
|------|------|
| **ChatGPT** | `chatgpt.com` / `chat.openai.com` |
| **Google Gemini** | `gemini.google.com` |
| **Google AI Studio** | `aistudio.google.com` |
| **Grok (xAI)** | `grok.com` |
| **Perplexity** | `perplexity.ai` |
| **GitHub Copilot** | `github.com/copilot` |

### 开源 / 聚合模型平台
| 平台 | 域名 |
|------|------|
| **DeepSeek** | `chat.deepseek.com` |
| **OpenRouter** | `openrouter.ai` |
| **Mistral** | `chat.mistral.ai` |
| **T3 Chat** | `t3.chat` |

### 国产大模型平台
| 平台 | 域名 |
|------|------|
| **Kimi（月之暗面）** | `kimi.com` / `kimi.moonshot.cn` |
| **通义千问（Qwen）** | `chat.qwen.ai` / `qianwen.com` |
| **智谱清言（ChatGLM）** | `chatglm.cn` / `chat.z.ai` |
| **豆包（Doubao）** | `doubao.com` |

> 每个平台均有针对性的输入框定位、拖放区域识别和发送按钮适配逻辑，确保文件注入和消息发送在各平台均可正常工作。

---

## 项目结构

```
mcp-multi-bridge/
├── manifest.json          # 扩展清单（Manifest V3）
├── background.js          # Service Worker：管理 MCP 服务器连接与消息路由
├── content.js             # 内容脚本：注入 AI 页面，提供侧边栏 UI 与工具调用检测
├── popup.html             # 弹窗 HTML：服务器管理界面
├── popup.js               # 弹窗逻辑：增删改查 MCP 服务器，支持在线编辑配置
├── popup.css              # 弹窗样式
├── sidebar.css            # 侧边栏样式（通过 Shadow DOM 隔离）
├── content.css            # 内容脚本全局样式（切换按钮等）
├── dragDropListener.js    # Gemini 专用拖放监听器（注入到页面主世界）
├── native-host.js         # 🆕 Native Messaging Host：桥接 Chrome 与本地 stdio MCP 进程
├── install-host.bat       # 🆕 Windows 一键安装脚本：注册 Native Messaging Host
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

**架构说明**：

- **`background.js`**（Service Worker）：负责维护到各 MCP 服务器的长连接，实现 `SSEParser`、`MCPConnection`、`ServerManager` 三层架构，处理 JSON-RPC 请求/响应的转发。**新增 Stdio 传输支持**，通过 `chrome.runtime.connectNative()` 与本地 Native Messaging Host 通信。
- **`content.js`**（内容脚本）：注入每个受支持的 AI 页面，创建侧边栏 UI（基于 Shadow DOM 隔离样式），监听页面 DOM 变化以检测 AI 输出的工具调用格式，并将结果注入回页面。
- **`native-host.js`**（Native Messaging Host）：🆕 Node.js 程序，作为 Chrome 与本地 MCP 服务器进程之间的桥梁。接收来自扩展的指令，启动/管理 MCP 服务器子进程，双向转发 JSON-RPC 消息。
- **`dragDropListener.js`**：针对 Google Gemini 框架的特殊处理，运行在页面主世界（非扩展沙盒），通过 `postMessage` 通道接收文件，并以精准构造的拖放事件模拟文件上传。

---

## 安装指南

> 由于本项目无需任何构建步骤，可直接将源码加载为"未打包扩展"。

### 支持的浏览器

- **Google Chrome**（推荐，版本 ≥ 109）
- **Microsoft Edge**（版本 ≥ 109，基于 Chromium）
- 其他基于 Chromium 的浏览器（Brave、Arc 等）

### 安装步骤

1. **获取代码**

   ```bash
   git clone https://github.com/你的用户名/mcp-multi-bridge.git
   ```
   
   或直接下载 ZIP 压缩包并解压到本地文件夹。

2. **打开扩展管理页面**

   在浏览器地址栏输入并回车：
   ```
   chrome://extensions/
   ```

3. **开启开发者模式**

   点击页面右上角的 **"开发者模式（Developer mode）"** 开关，将其打开。

4. **加载扩展**

   点击左上角的 **"加载已解压的扩展程序（Load unpacked）"**，在弹出的文件选择器中选择项目根目录（即包含 `manifest.json` 的文件夹）。

5. **固定到工具栏（推荐）**

   点击浏览器右上角的拼图图标（扩展管理），找到 **MCP Multi Bridge**，点击图钉图标将其固定到工具栏，方便快速访问。

安装完成后，扩展图标会出现在浏览器右上角。访问任意受支持的 AI 平台时，页面右侧会自动出现 **MCP** 悬浮切换按钮。

### Stdio 传输安装（Native Messaging）

如果你希望使用 **Stdio (Local)** 传输方式直接连接本地 MCP 服务器（如 Filesystem MCP Server），还需要完成以下一次性安装：

> **前置要求**：已安装 [Node.js](https://nodejs.org/)（版本 ≥ 16）

1. **获取扩展 ID**

   打开 `chrome://extensions/`，确保开发者模式已开启，找到 **MCP Multi Bridge** 扩展，复制其 **ID**（一串字母数字）。

2. **运行安装脚本**

   在项目根目录下，双击运行 `install-host.bat`，或在终端中执行：

   ```bash
   install-host.bat YOUR_EXTENSION_ID
   ```

   将 `YOUR_EXTENSION_ID` 替换为上一步复制的扩展 ID。

3. **重启浏览器**

   脚本会自动完成以下操作：
   - 生成 Native Messaging Host 清单文件（`com.mcp.bridge.json`）
   - 创建 Node.js 启动包装脚本（`native-host-wrapper.bat`）
   - 注册到 Chrome 和 Edge 的注册表中

   **重启浏览器后，Stdio 传输即可使用。**

> ⚠️ 安装脚本仅需运行一次。之后每次使用 Stdio 传输时，扩展会自动通过 Native Messaging 启动和管理本地 MCP 进程。

---

## 快速开始

### 方式一：SSE / Streamable HTTP 传输

以下是使用 HTTP 传输方式连接 MCP 服务器的流程（以本地文件系统 MCP 服务器 + DeepSeek 为例）：

#### 第一步：启动本地 MCP 服务器

本扩展需要一个在本地运行、支持 SSE 或 Streamable HTTP 传输的 MCP Server。你可以使用任意支持 MCP 协议的服务器，例如：

```bash
# 示例：使用 supergateway 将 stdio 服务器桥接为 SSE
npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem /你的/工作目录" --port 3006

# 服务器默认在 http://localhost:3006/sse 上监听
```

#### 第二步：在扩展弹窗中添加服务器

1. 点击浏览器工具栏中的 **MCP Multi Bridge** 图标，打开弹窗。
2. 填写服务器信息：
   - **Name（名称）**：`My Filesystem`（任意名称）
   - **URL**：`http://localhost:3006/sse`
   - **Transport（传输协议）**：`SSE`（或 `Streamable HTTP`，取决于服务器）
3. 点击 **Add Server**，扩展会自动尝试连接。
4. 连接成功后，服务器卡片左侧的状态点会变为**绿色**，并显示该服务器提供的工具数量。

### 方式二：Stdio 直连本地服务器（推荐）

🆕 **无需手动启动代理**，扩展通过 Native Messaging 自动管理本地 MCP 进程。

> 前提：已完成 [Stdio 传输安装](#stdio-传输安装native-messaging)。

#### 第一步：在扩展弹窗中添加 Stdio 服务器

1. 点击浏览器工具栏中的 **MCP Multi Bridge** 图标，打开弹窗。
2. 填写服务器信息：
   - **Name（名称）**：`Filesystem`（任意名称）
   - **Transport（传输协议）**：选择 `Stdio (Local)`
   - **Command（命令）**：`npx`
   - **Args（参数）**：`-y @modelcontextprotocol/server-filesystem C:\Users\你的用户名\Desktop`
3. 点击 **Add Server**，扩展会自动启动本地进程并连接。
4. 连接成功后，状态点变为**绿色**，工具列表会自动加载。

> ⚠️ **Args 字段不需要包含命令本身**。例如 Command 填 `npx`，则 Args 应填 `-y @modelcontextprotocol/server-filesystem C:\path`，而**不是** `npx -y ...`。

#### 快速切换目录

添加 Stdio 服务器后，可以直接在服务器卡片中**编辑 Args 字段**来修改目标目录路径，修改后点击 **Save** 按钮，扩展会自动断开当前连接并以新参数重新启动服务器。

### 继续使用

无论使用哪种传输方式，后续步骤相同：

1. 打开 `https://chat.deepseek.com`（或其他受支持的 AI 平台）。
2. 点击页面右侧的 **MCP** 悬浮按钮，展开侧边栏。
3. 在 **工具** 标签页中，点击 **附加 .md** 按钮，将包含所有可用工具定义的系统提示词以 `.md` 文件形式附加到输入框。
4. 发送该文件给 AI，AI 会读取工具列表并了解如何调用它们。
5. 现在你可以直接向 AI 提问，AI 会按照特定格式输出工具调用指令，扩展会自动检测并执行。

---

## 详细使用说明

### 管理 MCP 服务器

点击浏览器工具栏的扩展图标，弹窗提供完整的服务器管理功能：

| 操作 | 说明 |
|------|------|
| **添加服务器** | 填写名称、URL / Command+Args、传输协议后点击 Add Server |
| **在线编辑** | 🆕 直接在服务器卡片中修改 URL（SSE/HTTP）或 Command/Args（Stdio），修改后点击 Save 保存并自动重连 |
| **启用/禁用** | 通过每个服务器卡片上的 Enabled 开关切换 |
| **手动连接** | 点击 Connect 按钮手动重新连接已断开的服务器 |
| **断开连接** | 点击 Disconnect 按钮断开已连接的服务器 |
| **删除服务器** | 点击 Remove 按钮，确认后永久删除 |
| **刷新状态** | 点击页面顶部的 Refresh 按钮更新所有服务器的连接状态 |

扩展启动时会自动连接所有已启用的服务器，连接状态实时同步到所有已打开的 AI 页面侧边栏。

### 侧边栏功能详解

点击 AI 页面右侧的 **MCP** 按钮展开侧边栏，侧边栏分为三个标签页：

#### 工具标签页

- **工具列表**：展示所有已连接服务器提供的工具，按服务器分组，显示工具名称和简要描述。
- **附加 .md**：将包含所有工具定义和调用规范的系统提示词以 Markdown 文件形式附加到当前 AI 对话框，这是初始化 MCP 连接的关键步骤。
- **下载 .md**：将提示词文件下载到本地，适用于自动附加失败时手动上传。
- **复制**：将提示词文本复制到剪贴板，可手动粘贴到对话框。
- **刷新工具列表**：重新从所有服务器获取最新工具列表。

#### 调用标签页

每当检测到 AI 输出工具调用指令时，此处会自动创建调用卡片，显示：

- 工具名称与调用 ID
- 工具描述
- 调用参数（键值对）
- 执行状态（等待中 / 执行中 / 已完成 / 失败）
- 执行结果预览（截取前 500 字符）
- **执行**按钮：手动触发工具调用
- **复制结果**按钮：将执行结果复制为标准 MCP 格式

同时，AI 输出中工具调用代码块的正下方会注入一个 **内联执行按钮**，点击即可就地执行对应工具。

#### 设置标签页

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| **自动执行工具调用** | 检测到工具调用后无需手动点击，自动触发执行 | 关闭 |
| **注入结果后自动发送** | 将结果注入输入框后自动点击发送按钮 | 关闭 |
| **粘贴拦截** | 粘贴 MCP 格式结果时自动转换为文件附件 | 开启 |
| **等待注入延迟** | 最后一个工具调用完成后，等待多少秒再统一注入（用于等待可能的后续调用）| 4 秒 |
| **发送前延迟** | 文件注入后等待多少秒再发送（给平台解析文件留出时间）| 8 秒 |

所有设置通过 `chrome.storage.local` 持久化，刷新页面后自动恢复。

### 工具调用流程

MCP Multi Bridge 通过检测 AI 输出中的特定 `jsonl` 格式代码块来识别工具调用意图：

```jsonl
{"type": "function_call_start", "name": "read_file", "call_id": 1}
{"type": "description", "text": "读取指定路径的文件内容"}
{"type": "parameter", "key": "path", "value": "/home/user/project/main.py"}
{"type": "function_call_end", "call_id": 1}
```

检测到该格式后，扩展的完整处理流程如下：

```
AI 输出工具调用代码块
        ↓
MutationObserver 检测到 DOM 变化
        ↓
parseToolCalls() 解析 jsonl 内容
        ↓
创建调用卡片 + 注入内联执行按钮
        ↓
（自动执行模式）executeToolCall()
        ↓
background.js → MCPConnection.callTool()
        ↓
通过 SSE / HTTP / Stdio 发送到 MCP 服务器
        ↓
接收执行结果
        ↓
（批量聚合）injectBatchResults()
        ↓
结果以 .md 文件形式注入对话框
        ↓
（自动发送模式）点击发送按钮
```

### 提示词系统

扩展会根据当前连接的所有服务器和工具，动态生成一份完整的系统提示词（`mcp-tools.md`），内容包括：

1. **工具调用格式规范**：精确的 `jsonl` 代码块格式要求
2. **多调用并行格式**：如何在一次响应中发起多个独立工具调用
3. **调用规则说明**：10 条强制执行规则（不伪造结果、调用后立即停止等）
4. **结果回传格式**：AI 接收工具结果的标准格式
5. **Agent 模式指令**：完整的自主 Agent 行为规范
6. **工具列表**：所有可用工具的名称、描述和参数定义（含必选/可选标注）

---

## Agent 模式

Agent 模式是本扩展的核心高级功能，可让 AI 在无需用户干预的情况下**自主、连续、迭代**地使用工具完成复杂任务。

### 激活方式

在对话中向 AI 发送以下任意指令均可激活 Agent 模式：

```
enter agent mode
agent mode
进入 agent 模式
自主模式
agentic mode
```

### Agent 模式行为规范

激活后，AI 会遵循以下循环工作流：

1. **分析**：拆解用户目标，制定执行计划（在首次响应中列出计划步骤）
2. **调用**：输出工具调用代码块，然后立即停止，等待结果
3. **评估**：收到结果后判断任务是否完成，以及下一步应做什么
4. **迭代**：若未完成，直接发起下一个工具调用，无需请求用户许可
5. **总结**：任务完成后输出完整的执行摘要

### Agent 模式核心规则

| 规则 | 说明 |
|------|------|
| **主动性** | 不等待用户指示下一步，根据已有结果自主决策 |
| **持续性** | 单次工具调用失败时，尝试不同参数或备用工具，不轻易放弃 |
| **迭代性** | 持续调用工具直至任务完全完成 |
| **交叉验证** | 搜索类任务必须用不同关键词进行多轮搜索，交叉验证信息 |
| **质量优先** | 宁可多调用几次也不基于不充分的数据给出浅层答案 |
| **格式一致** | Agent 模式下仍然严格遵守 `jsonl` 代码块格式规范 |

### 退出 Agent 模式

发送以下指令可退出 Agent 模式：

```
exit agent mode
退出 agent 模式
stop agent mode
```

### Agent 模式示例

**用户**：进入 agent 模式，帮我分析一下我本地 `/project/src` 目录下的所有 Python 文件，找出其中可能存在内存泄漏的代码。

**AI（Agent 响应 1）**：我已进入 Agent 模式。我的计划：1) 列出 `/project/src` 目录结构，2) 逐个读取 `.py` 文件，3) 分析每个文件的内存使用模式，4) 汇总报告。

```jsonl
{"type": "function_call_start", "name": "list_directory", "call_id": 1}
{"type": "description", "text": "列出项目源码目录结构"}
{"type": "parameter", "key": "path", "value": "/project/src"}
{"type": "function_call_end", "call_id": 1}
```

*（扩展自动执行，返回目录列表 → AI 读取每个文件 → 完成分析）*

---

## 高级功能

### 自动执行与自动发送

开启 **自动执行工具调用** 后，扩展会在检测到 AI 输出的工具调用时立即执行，无需手动点击。

开启 **注入结果后自动发送** 后，结果注入输入框后会自动触发发送操作，实现完全自动的 MCP 循环。

**批量收集机制**：当 AI 在同一次响应中发出多个工具调用（并行调用）时，扩展会：
1. 并发执行所有工具调用
2. 等待所有调用完成
3. 在最后一个调用完成后，等待「等待注入延迟」秒（默认 4 秒），以确认没有更多新的调用产生
4. 将所有结果合并为一个 `.md` 文件统一注入
5. 等待「发送前延迟」秒（默认 8 秒）后自动发送

这套机制确保了即使 AI 发出大量并行调用，也不会出现重复发送或结果丢失的问题。

**会话切换保护**：当用户在 SPA 应用（如 ChatGPT）中切换到不同对话时，扩展会检测 URL 变化，并在 3 秒内抑制自动执行，防止将旧会话的历史工具调用在新会话中重复执行。

### 多服务器并发

扩展支持同时连接任意数量的 MCP 服务器（包括混合使用不同传输协议），所有服务器的工具会被聚合到统一的工具列表中，并带有所属服务器的标注。

当 AI 发出工具调用时，扩展会根据工具名称自动找到提供该工具的服务器并路由请求，整个过程对 AI 完全透明。

**示例场景**：同时连接 Stdio 方式的"本地文件系统服务器"和 SSE 方式的"GitHub API 服务器"，让 AI 能够读取本地代码文件并对比 GitHub 上的版本。

### 粘贴拦截

当 **粘贴拦截** 功能开启时，如果你在 AI 对话框中粘贴包含 MCP 工具结果格式（`jsonl` 代码块 + `function_result_start`）的文本，扩展会自动：

1. 拦截粘贴事件
2. 将文本内容转换为 `.md` 文件
3. 通过文件上传机制附加到对话框

这避免了大量结果文本直接出现在输入框中导致 token 浪费或格式问题。

### 深色模式

点击侧边栏右上角的 **深色** 按钮可切换深色/浅色主题，偏好自动持久化保存。

### 服务器配置在线编辑

🆕 在服务器列表中，每个服务器卡片的配置字段均支持直接编辑：

| 传输类型 | 可编辑字段 | 典型用途 |
|----------|-----------|---------|
| **SSE / Streamable HTTP** | URL | 切换服务器地址或端口 |
| **Stdio (Local)** | Command、Args | 快速切换目标目录或修改启动参数 |

修改后会出现 **Save** 按钮，点击即可保存配置并自动断开重连，使更改立即生效。

---

## MCP 协议传输方式

扩展原生实现了三种 MCP 传输协议：

### SSE（Server-Sent Events）传输

**适用场景**：通过 HTTP 代理（如 `supergateway`）暴露的 MCP 服务器

**工作原理**：
1. 扩展向 SSE 端点（如 `http://localhost:3006/sse`）发起长连接
2. 服务器通过 `endpoint` 事件返回消息端点 URL
3. 后续请求通过 HTTP POST 发送到该消息端点
4. 响应通过 SSE 流异步推回

**配置示例**：
```
URL: http://localhost:3006/sse
Transport: SSE
```

### Streamable HTTP 传输

**适用场景**：使用新版 MCP SDK（支持 Streamable HTTP）的服务器

**工作原理**：
1. 所有请求直接 POST 到配置的 URL
2. 支持会话 ID（`Mcp-Session-Id` Header）保持状态
3. 响应可以是普通 JSON 或 SSE 流（根据服务器返回的 `Content-Type` 自动判断）

**配置示例**：
```
URL: http://localhost:3006/mcp
Transport: Streamable HTTP
```

### Stdio 传输（Native Messaging）

🆕 **适用场景**：所有基于 stdio 的 MCP 服务器（如 `@modelcontextprotocol/server-filesystem`、`@modelcontextprotocol/server-github` 等），无需额外代理

**工作原理**：
1. 扩展通过 `chrome.runtime.connectNative()` 连接本地 Native Messaging Host
2. Native Host 根据配置的 Command 和 Args 启动 MCP 服务器子进程
3. JSON-RPC 消息通过 `stdin/stdout` 在扩展与 MCP 服务器之间双向转发
4. 扩展自动管理进程的生命周期（连接时启动，断开时终止）

**配置示例**：
```
Transport: Stdio (Local)
Command:   npx
Args:      -y @modelcontextprotocol/server-filesystem C:\Users\username\Desktop
```

**架构对比**：
```
SSE 方式:
  扩展 ──fetch()──→ supergateway ──stdio──→ MCP 服务器

Stdio 方式（推荐）:
  扩展 ──connectNative()──→ native-host.js ──stdio──→ MCP 服务器
```

Stdio 方式省去了手动启动代理的步骤，由扩展自动管理进程生命周期，使用更简洁。

### 失败重试机制

工具调用失败时，扩展会自动重试最多 **5 次**，采用线性退避策略（第 n 次重试等待 n 秒），超时限制为 **30 秒**。重试过程中，UI 会实时更新状态提示。

---

## 技术架构

### 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 持久化服务器配置和用户设置 |
| `nativeMessaging` | 🆕 通过 Native Messaging 协议与本地 Host 程序通信，实现 stdio 传输 |
| `host_permissions: <all_urls>` | 向本地 MCP 服务器发送 fetch 请求（跨域） |

> 扩展**不需要**也不申请读取浏览器历史、Cookie、书签等敏感权限。

### Shadow DOM 隔离

侧边栏 UI 完全运行在 Shadow DOM 内部，与宿主页面的样式完全隔离，确保不会与各 AI 平台的页面样式发生冲突。

### 服务工作线程保活

内容脚本通过 `chrome.runtime.connect()` 建立持久化端口连接，防止 Chrome 在空闲时挂起 Service Worker，维持 MCP 服务器的长连接稳定性。

### Native Messaging 架构

🆕 Stdio 传输通过 Chrome 的 [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) 机制实现：

```
┌──────────────────┐     Chrome Native      ┌──────────────────┐     stdin/stdout     ┌──────────────────┐
│   background.js  │ ←── Messaging协议 ───→ │  native-host.js  │ ←── JSON-RPC ──────→ │  MCP Server进程  │
│  (Service Worker)│     (4字节长度+JSON)    │   (Node.js)      │     (行分隔JSON)     │  (子进程)        │
└──────────────────┘                        └──────────────────┘                      └──────────────────┘
```

每个 Stdio 类型的 MCP 连接都会创建一个独立的 Native Host 实例，实例内管理一个子进程。断开连接时，子进程自动终止。

---

## 使用场景示例

### 场景一：本地代码审查

利用文件系统 MCP 服务器暴露本地项目目录，在任意 AI 平台中：

> "请帮我读取 `src/utils/memory.js` 文件并分析其中潜在的内存泄漏问题，然后给出修复建议。"

AI 会自动调用 `read_file` 工具获取代码，分析后给出具体的修复方案，**省去了手动复制粘贴多个文件的繁琐操作**。

### 场景二：本地数据库自然语言查询

将本地 MySQL 或 PostgreSQL 数据库包装为 MCP 工具后：

> "帮我查询昨天新注册且今天有登录记录的活跃用户数量，并生成一份 Markdown 格式的日报。"

AI 会自动调用数据库查询工具，生成结构化报告，整个过程无需编写任何 SQL。

### 场景三：多步骤研究任务（Agent 模式）

结合网络搜索 MCP 服务器，使用 Agent 模式：

> "进入 agent 模式。研究一下 Claude 4 和 GPT-5 在代码生成基准测试上的最新得分，用表格对比，并给出你对两者优劣的分析。"

AI 会自主进行多轮搜索、交叉验证、汇总分析，直到获得可靠数据后输出完整报告。

### 场景四：多服务器跨域自动化

同时连接"本地文件系统服务器"和"GitHub 搜索服务器"：

> "我本地的 `utils/parser.js` 实现了一个 JSON 解析器，帮我在 GitHub 上找几个类似的开源实现，对比一下性能和设计思路。"

AI 会先读取本地文件，再搜索 GitHub，最后给出对比分析，两个服务器的工具被无缝调度。

### 场景五：Stdio 快速目录切换

🆕 使用 Stdio 传输连接 Filesystem MCP Server，随时在插件弹窗中修改 Args 参数切换目标目录：

> 先分析 `D:\project-a` 的代码结构 → 修改 Args 为 `-y @modelcontextprotocol/server-filesystem D:\project-b` → 点击 Save → 无缝切换到另一个项目。

无需重新启动任何服务，扩展自动处理进程的重启和重连。

---

## 常见问题

**Q：服务器状态显示红色（连接失败）怎么办？**

A：请确认：
1. 本地 MCP 服务器已启动并正在监听（SSE/HTTP 模式）
2. URL 和传输协议类型填写正确（SSE 服务器的 URL 通常以 `/sse` 结尾）
3. 没有防火墙或安全软件阻断 `localhost` 连接

**Q：Stdio 模式显示"连接失败"或"Native host disconnected"？**

🆕 A：请检查：
1. 已运行 `install-host.bat` 并传入了正确的扩展 ID
2. 已安装 Node.js 且 `node` 命令在系统 PATH 中可用
3. 安装后已重启浏览器
4. Args 字段格式正确（不要在 Args 中重复填写 Command 的内容）

**Q：Stdio 模式连接成功但工具数量为 0？**

🆕 A：请检查：
1. Args 字段是否包含了必需的目录路径参数（如 `-y @modelcontextprotocol/server-filesystem C:\your\path`）
2. Args 字段是否意外地以命令名开头（如 `npx -y ...`），这会导致命令重复

**Q：工具列表显示为空？**

A：点击侧边栏中的 **刷新工具列表** 按钮。如果服务器刚刚连接，可能需要等待几秒钟。

**Q：AI 没有按照 jsonl 格式输出工具调用？**

A：请确保已将提示词文件附加给 AI（点击侧边栏工具标签页中的 **附加 .md** 按钮），AI 必须先读取提示词才能了解工具调用格式。

**Q：结果注入后文件没有出现在对话框？**

A：不同平台的文件上传机制存在差异。扩展会依次尝试文件输入框注入、拖放注入、粘贴事件注入三种策略。如果全部失败，会回退为直接文本粘贴。Gemini 使用了特殊的拖放处理机制（`dragDropListener.js`）。

**Q：自动发送是否安全？**

A：自动发送前有多重安全检查，包括等待所有工具调用完成、等待平台解析文件等。如果需要对每次发送进行人工审核，请关闭 **注入结果后自动发送** 开关。

---

## 灵感来源与版权说明

本项目在产品概念和 UI 交互思路上受到优秀开源项目 [MCP-SuperAssistant](https://github.com/srbhptl39/MCP-SuperAssistant) 的启发。

---

## 致谢

> *本项目由 **OPENCODE + Claude Opus 4.6** 协助完成开发。*

---

## 许可证

本项目采用 [MIT License](LICENSE) 开源许可。你可以自由使用、修改和分发，但请保留原始版权声明。

