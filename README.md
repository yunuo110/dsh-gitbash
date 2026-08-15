# dsh-gitbash

DeepSeek Harness（DSH）bundle 插件：**不新增模式、不新增工具**，在 Windows 上把 DSH 现有的 `bash` 工具直接指向 Git for Windows Bash，并隐藏/禁用 `pwsh`，让模型自然使用 Git Bash。

这个方案参考了 Reasonix 的做法：**只保留一个 `bash` 工具**，省掉额外工具 schema 和额外系统提示，token 更省。

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

在插件仓库根目录执行：

```powershell
dsh plugin --profile web add .
```

这会：

1. 把 `dsh-gitbash` 作为 bundle 加入 `~/.dsh/profiles/web`；
2. 在 Windows 上提供一个 Git Bash `shell` executor；
3. 重新启用 host 层 `tool-bash`；
4. 禁用 `pwsh-sandbox` / `tool-pwsh`。

然后**完整重启 DSH**。之后新建会话和旧对话都会使用同一个 `bash` 工具，但它实际执行 Git Bash。

如果 `dsh` 不在 PATH，使用你的实际路径，例如：

```powershell
& 'F:\code\creative-tools\caches\npm\_npx\1e7f6d9597241db0\node_modules\.bin\dsh.cmd' plugin --profile web add .
```

### GitHub 安装（推荐，避免被 DSH 更新/本地路径变动刷掉）

先把本仓库推到 GitHub：

```bash
git remote add origin https://github.com/<your-name>/dsh-gitbash.git
git branch -M main
git push -u origin main
```

然后安装：

```powershell
dsh plugin --profile web remove dsh-gitbash
dsh plugin --profile web add github:<your-name>/dsh-gitbash
```

建议锁定 commit，避免以后仓库变更悄悄影响你：

```powershell
dsh plugin --profile web add github:<your-name>/dsh-gitbash#<commit-sha>
```

这样 profile 里保存的是 GitHub 依赖，而不是本地 `link:F:/code/...`，DSH 更新不会把它刷掉。

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

默认自动探测 Git Bash：`GIT_BASH` 环境变量 → Program Files / Program Files (x86) / ProgramW6432 / LocalAppData / Scoop → PATH（排除 System32 的 WSL bash）。

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

| 方案 | 工具数量 | 额外系统提示 | 每轮 token |
| --- | --- | --- | --- |
| 之前：新增 `gitbash` 工具 | 2（pwsh + gitbash 或 bash + gitbash） | 有 | 较高 |
| 现在：Reasonix 式单一 `bash` 工具 | 1（bash） | 无 | 更低 |

## 测试

```powershell
npm run check
```

当前测试覆盖：Git Bash 路径探测、argv 构造、环境变量合并、参数校验、超时钳制、workdir 解析、结果渲染、配置校验、shell 工具过滤。

## 兼容性

- DeepSeek Harness `0.1.0-rc.6`
- Windows + Git for Windows（MSYS2）
- Node.js 22.19+

## 致谢

实现参考了 Reasonix 的 `internal/sandbox/shell.go` 设计（单 bash 工具 + 运行时解析 Git Bash），以及 [MAXeaglet/dsh-bash-terminal](https://github.com/MAXeaglet/dsh-bash-terminal) 与 [liceses/dsh-gitbash-preset](https://github.com/liceses/dsh-gitbash-preset) 的 DSH 工具接缝经验。本项目 MIT License。
