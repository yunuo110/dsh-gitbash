# dsh-gitbash

[English](./README.en.md) · 中文

DeepSeek Harness（DSH）bundle 插件：**不新增模式、不新增工具**，在 Windows 上把 DSH 现有的 `bash` 工具直接指向 Git for Windows Bash，并隐藏/禁用 `pwsh`，让模型自然使用 Git Bash。

参考了 Reasonix 的做法。

## 设计目标

- **不是 preset 模式**：不需要选择新模式，原有模式名不变。
- **不是额外工具**：不注册 `gitbash` 工具，模型看到的还是 DSH 原生的 `bash` 工具。
- **默认 Git Bash**：Windows 上 `bash` 工具通过 `Git\bin\bash.exe -lc <command>` 执行。
- **隐藏 PowerShell**：Windows 上 `pwsh` 从 prompt 中隐藏，并且即使旧缓存尝试调用也会被 guard 拒绝。
- **动态描述**：`bash` 工具描述被改写为 Git Bash/MSYS2 规则，模型按 bash 语法写命令。
- **Windows 专用**：非 Windows 上插件 no-op，不影响原生 bash。

## 目录结构

```text
dsh-gitbash/
├── package.json
├── cordis.patch.yml        # 插入 dsh-gitbash，禁用 pwsh，启用 bash
├── lib/
│   ├── index.js            # shell provider + prompt 改写 + guard
│   └── gitbash-core.mjs    # 纯函数：路径探测/argv/渲染/校验
└── test/
    └── gitbash-core.test.mjs
```

## 安装（web profile）

在插件仓库根目录执行。如果你是从 GitHub clone 的，先进入 clone 出来的目录：

```powershell
cd dsh-gitbash
```

> 新版 DSH 的 `dsh plugin` 命令会把参数转发给 `pnpm`。安装前请先确认本机已有 `pnpm`（例如执行 `pnpm --version`）；没有的话先运行 `npm install -g pnpm`。

### 方式 A：`dsh` 已经在 PATH 里

直接执行：

```powershell
dsh plugin --profile web add .
```

### 方式 B：平时用 `npx @deepseek-ai/dsh web` 启动 DSH

很多人的 DSH 不是全局安装的，`dsh` 命令并不在 PATH 里。如果你平时是这样启动的：

```powershell
npx @deepseek-ai/dsh web
```

那么安装插件也要通过 `npx` 调用：

```powershell
npx @deepseek-ai/dsh plugin --profile web add .
```

注意：这条命令要在插件仓库根目录下执行，因为 `add .` 的 `.` 指向当前目录。

如果你希望以后能直接使用 `dsh` 命令，可以先把 DSH 装到全局：

```powershell
npm install -g @deepseek-ai/dsh
```

之后就能直接：

```powershell
dsh plugin --profile web add .
```

### 安装后

安装会：

1. 把 `dsh-gitbash` 作为 bundle 加入 `~/.dsh/profiles/web`；
2. 在 Windows 上提供一个 Git Bash `shell` executor；
3. 重新启用 host 层 `tool-bash`；
4. 禁用 `pwsh-sandbox` / `tool-pwsh`。

然后**完整重启 DSH**。之后新建会话和旧对话都会使用同一个 `bash` 工具，但它实际执行 Git Bash。

### GitHub 安装（推荐）

如果你不想依赖本地源码目录，可以直接从 GitHub 安装：

```powershell
dsh plugin --profile web add github:yunuo110/dsh-gitbash
```

如果你之前装过本地版本，先移除再安装：

```powershell
dsh plugin --profile web remove dsh-gitbash
dsh plugin --profile web add github:yunuo110/dsh-gitbash
```

建议锁定版本，避免以后仓库变更悄悄影响你（当前最新 tag：`v0.1.1`）：

```powershell
dsh plugin --profile web add github:yunuo110/dsh-gitbash#v0.1.1
```

这样 profile 里保存的是 GitHub 依赖，而不是本地 `link` 依赖，DSH 更新不会把它刷掉。

## 使用

- 新会话或旧对话里让模型执行 shell/git 命令，例如“查看 git 状态”“运行 npm test”。
- 模型看到的是 `bash` 工具，描述会说明它运行 Git Bash。
- Windows 上模型看不到 `pwsh`，即使旧缓存尝试 `pwsh` 也会被拒绝并提示改用 `bash`。
- 如果当前会话沙箱不是完全访问，第一次调用可能失败并提示升级。按提示让模型用：
  ```json
  {
    "command": "git status",
    "description": "查看 git 状态",
    "sandbox_permissions": "danger-full-access",
    "justification": "Git Bash 无法在受限沙箱中启动，需要完全访问以执行 git 状态检查。"
  }
  ```
  或直接在设置里把会话权限切到**完全访问**。

## 配置

默认自动探测 Git Bash：`GIT_BASH` 环境变量 → 注册表 `HKLM\SOFTWARE\GitForWindows\InstallPath` → Program Files / Program Files (x86) / ProgramW6432 / LocalAppData / Scoop → PATH（含 `<...>\cmd` 到 `<...>\bin\bash.exe` 的推导；排除 System32 的 WSL bash）。找不到时直接报错，不会回退到裸 `bash`。

要固定路径，在 profile 自己的 `cordis.patch.yml`（`~/.dsh/profiles/web/cordis.patch.yml`）中覆盖插件行：

```yaml
- id: dsh-gitbash
  config:
    shellPath: 'C:\Program Files\Git\bin\bash.exe'
    timeoutMs: 120000
    maxTimeoutMs: 600000
    maxOutputBytes: 64000
    maxSpillBytes: 67108864
    graceMs: 3000
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `shellPath` | 自动探测 | 固定 Git Bash 路径 |
| `timeoutMs` | 120000 | 单条命令默认超时 |
| `maxTimeoutMs` | 600000 | 超时上限 |
| `maxOutputBytes` | 64000 | stdout 内存保留字节数，溢出写入 spill |
| `maxSpillBytes` | 67108864 | spill 文件上限 |
| `graceMs` | 3000 | SIGTERM → SIGKILL 宽限 |

## 工具行为

- 每次调用都是新的非交互式 `bash.exe -lc`：**不保留 `cd` / `export` / alias 状态**。
- 使用 POSIX/bash 语法：`$VAR`、`export`、`ls`、`grep`、`find`、`sed`、`awk`、管道、`&&`/`||`、命令替换。
- 路径建议：`/d/WorkSpace` 或 `C:/WorkSpace`；避免未加引号的反斜杠。
- 环境变量：`$VAR` / `${VAR}`，不要用 PowerShell 的 `$env:VAR`。
- 支持 DSH 原 `bash` 工具的 `workdir`、`timeoutMs`、`run_in_background`、`sandbox_permissions` + `justification`。

## Token 对比

只对比原版 DSH 配置与本插件的差异：

| 配置 | 可见 shell 工具 | 额外系统提示 | 每轮 token 影响 |
| --- | --- | --- | --- |
| 原版 DSH（Windows） | `pwsh` | 无 | 基准 |
| 本插件 | `bash`（实际执行 Git Bash） | 无 | 基本持平（只是用 `bash` schema 替换 `pwsh` schema，没有新增额外工具） |

## 测试

```powershell
npm run check
```

当前测试覆盖：Git Bash 路径探测、argv 构造、环境变量合并、参数校验、超时钳制、workdir 解析、结果渲染、配置校验、shell 工具过滤。

## 常见问题

### bash 里变量全是空的、`for` 循环打印空行、`uname` 显示 Linux

说明实际跑的是 `C:\Windows\System32\bash.exe`（WSL 转发器），不是 Git Bash。该转发器会重新拼接带引号的参数，导致 `$VAR`、`$(...)`、heredoc 在真正执行前就被展开一次。

旧版探测在 PATH 里只找 `<dir>\bash.exe`，而 Git for Windows 的 PATH 项是 `<GitRoot>\cmd`（`bash.exe` 在 `<GitRoot>\bin`），于是探测失败并回退到裸 `bash`。当前版本已修复：

- 优先读注册表 `HKLM\SOFTWARE\GitForWindows\InstallPath` → `<InstallPath>\bin\bash.exe`；
- PATH 中的 `<...>\cmd` 自动推导 `<...>\bin\bash.exe`；
- **不再回退**到裸 `bash`：找不到就明确报错，避免静默跑成 WSL。

若仍未命中，设置 `GIT_BASH` 或在 profile 的 `cordis.patch.yml` 里固定 `shellPath`。

### `workspace-write` 下报 "the Git-for-Windows bash runtime cannot start"

MSYS 运行时在写入受限令牌下无法创建信号管道，属于 Windows 沙箱限制。把该会话的沙箱切到 `danger-full-access`（或按提示允许一次提权）后即可使用。

### 每次输出开头有 `Active code page: 65001`

来自 `~/.bashrc` 里的 `chcp.com 65001`，其输出走的是 stdout。改成 `chcp.com 65001 >/dev/null 2>&1` 即可消除。

## 兼容性

- DeepSeek Harness `0.1.2-rc.1`（兼容 `0.1.0-rc.6` 起的同一套 shell/工具 seam）
- Windows + Git for Windows（MSYS2）
- Node.js 22.19+

## 说明

本工具完全由 DSH 制作而成。
