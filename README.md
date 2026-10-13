# SourceCompass

[GitHub 仓库](https://github.com/Andrewuetyang/source-compass) · [问题反馈](https://github.com/Andrewuetyang/source-compass/issues)

为 AI agent 查找本机已有源码的 CLI + skill。输入 npm 包名、仓库名或 Git remote URL，得到包目录、所属仓库和 worktree 信息。

**源码罗盘：为 AI 找到本地源码。** npm 包名和主命令均为 `source-compass`，原命令 `workspace-resolver` 作为兼容别名保留。AI skill 使用 `$source-compass`，已有索引使用同一存储位置。

V0.1 实现目录发现、索引查询和人工映射管理。TypeScript + Node.js，运行时无第三方依赖，使用 JSON 保存索引及修改记录。MCP、自动 clone、worktree 创建、GitLab 远程发现留给后续版本。

## 快速开始

需要 Node.js 22+ 和 Git。npm 包安装及使用方式：

```bash
npm install -g source-compass

# 换成你实际存放项目源码的目录，可同时指定多个。
source-compass init ~/code ~/work --json
source-compass resolve '@company/shared' --json
source-compass skill install --json
```

也可以使用 npx 调用：

```bash
npx source-compass init ~/code --json
npx source-compass skill install --json
```

从本地源码构建时，先使用 Node.js 22 或以上版本，依赖由 Yarn 管理：

项目的 `.yarnrc`、`.npmrc` 和发布配置使用 npm 官方 registry（`https://registry.npmjs.org/`），锁文件中的下载地址也指向官方源。

```bash
yarn install --frozen-lockfile
yarn build

# 换成你实际存放项目源码的目录，可同时指定多个。
node dist/cli.js init ~/code ~/work --json
node dist/cli.js resolve '@company/shared' --json
```

如需在终端使用本地构建的短命令，可以在本仓库执行 `yarn link`，之后调用 `source-compass`。也可以始终使用 `node /absolute/path/workspace-resolver/dist/cli.js`，无需全局安装。

## 让 AI 使用

先初始化索引，再安装随仓库提供的 skill：

```bash
# 默认安装到 ${CODEX_HOME:-~/.codex}/skills/source-compass。
source-compass skill install --json

# 也可显式指定其他支持 SKILL.md 的 agent 的 skill 目录。
source-compass skill install --target ~/.claude/skills/source-compass --json
```

安装包包含 `SKILL.md`、启动脚本、编译后的 CLI 和 MIT 许可证，移动本仓库不影响已安装的 skill。目标目录已存在时会报 `SKILL_EXISTS`，不会覆盖已有 skill。更新时可以先安装到新目录检查，再替换旧目录。

让 agent 在能够发现该 skill 的会话中执行这样的任务：

> 使用 $source-compass 找到 @company/shared 的本地源码，检查它的实现，再修改当前项目中相关调用。

或者：

> 使用 $source-compass 初始化 ~/code-personal 下的源码索引；如果同名包有多个候选，列出来供我选择。

skill 会先查询索引，缺少索引时根据用户提供的代码根目录初始化。出现多个候选时，它会根据任务上下文定位，必要时向用户确认。用户要求固定源码映射时，使用 `map set` 记录。

找到依赖源码后，如果需要修改，skill 会检查**实时分支、未提交修改和 Git 操作状态**。索引中的 `branch` 只是上次扫描时的记录，不代表应当从它开始修改。任务或项目规则已经明确分支策略时沿用该策略；否则，在修改之前让用户确认：沿用当前分支，还是从指定远端基线新建任务分支。只读查看源码无需确认分支策略。

例如，AI 会先说明：“源码在 `/code/shared`，当前为 `feature/old-task`，工作区干净。本次沿用当前分支，还是 fetch `origin/main` 后新建 `codex/fix-shared`？”其中远端和基线需要根据项目确定，不固定为 `origin` 或 `master`。用户选择新分支后，通过普通 Git 命令 fetch 指定基线并创建分支；未提交修改、冲突或分支已被其他操作切换时，先确定如何保留已有工作。

这项选择只属于本次任务，不会写成永久的包映射。CLI 仍负责发现和查询源码；分支策略的确认和执行由 skill 引导 AI 完成。

skill 的实际调用命令：

```bash
node ~/.codex/skills/source-compass/scripts/source-compass.mjs resolve '@company/shared' --json
```

自动选择取决于所用 agent 的 skill 发现机制；本项目验证了安装后的命令调用链，不包含 Claude Code 应用内的接入验证。skill 是普通的 `SKILL.md` 目录，不依赖 MCP 服务。

## CLI

所有命令支持 `--json`、`--store <directory>`，查询不写索引。

| 命令 | 行为 |
| --- | --- |
| `init <root...>` | 添加根目录并扫描；重复执行保留人工映射 |
| `scan` | 重新扫描所有配置的根目录 |
| `roots list` | 查看扫描配置 |
| `roots add <root...>` | 添加根目录并重新扫描 |
| `roots remove <root...>` | 移除根目录并重新扫描，至少保留一个 |
| `list packages` | 列出 npm 包，`list` 默认同此命令 |
| `list repos` | 列出 Git 仓库及 worktree |
| `search <text>` | 按名称、路径、remote URL 搜索 |
| `resolve <name\|url\|path>` | 精确解析源码位置 |
| `map list` | 查看人工映射 |
| `map set <name> <path> --note <text>` | 设置或更新人工映射 |
| `map unset <name>` | 删除人工映射，恢复自动匹配 |
| `history` | 查看初始化、扫描、根目录和映射修改记录 |
| `status` | 查看索引时间、数量、同名包和扫描问题 |
| `skill install --target <folder>` | 安装包含运行文件的 skill；target 可省略 |

```bash
node dist/cli.js init ~/code --max-depth 16 --exclude generated --exclude archives --json
node dist/cli.js search shared --json
node dist/cli.js resolve 'git@gitlab.example.com:team/shared.git' --json
node dist/cli.js map set '@company/shared' ~/code/shared-next --note '当前任务使用新版源码' --json
node dist/cli.js scan --json
node dist/cli.js history --json
```

`--max-depth` 和 `--exclude` 用于 `init` 或 `scan`，会持久化。最大深度默认 12（根目录深度为 0），允许 0–100。排除项是目录名称，逐层匹配，支持重复传入；不支持 glob 或相对路径。额外排除项累加，要删除它们可在没有写操作运行时编辑 `state.json` 的 `config.excludes`。内置排除项始终生效。

源码定位优先级：**精确人工映射 → 精确 npm 包名/包路径 → 仓库名/仓库路径/remote URL**。同一个包在主仓库和 worktree 中分别作为候选；不会自动选取第一个。`search` 提供模糊查找，`resolve` 不模糊匹配。npm 包名区分大小写。

成功的命令输出 `{ "ok": true, "data": ... }`，命令错误输出 `{ "ok": false, "error": { "code", "message" } }`。`--json` 每次输出一个紧凑 JSON 对象；默认输出缩进 JSON，保留相同字段。

`resolve` 的 `data.status` 和退出码：

| status | 退出码 | 含义 |
| --- | --- | --- |
| `resolved` | 0 | 唯一候选且目录存在 |
| `not_found` | 2 | 没有匹配；可以先 search，再刷新索引 |
| `ambiguous` | 3 | 有多个候选，需要明确选择 |
| `stale` | 4 | 唯一候选的目录已缺失或不可访问 |

这些状态均属于查询结果，`ok` 仍为 `true`。其他命令错误退出码为 1。人工映射路径丢失时会返回 `stale`，避免悄悄改用另一个同名目录。

## 扫描规则

- 广度优先遍历，扫描包目录后继续向下寻找嵌套仓库和其他包。
- 通过 Git 本地命令校验 `.git` 目录或文件，识别普通仓库、linked worktree 和 submodule 的 Git 元数据；不访问远端。
- npm 包必须有可解析的 `package.json` 和非空 `name`。保留版本、private 标记及 workspaces 声明；不执行包脚本。
- monorepo 的子包分开索引，关联最近的上级 Git 仓库。workspaces 声明作为元数据保存；本版不计算 glob 成员关系或完整依赖图。
- 跳过 `node_modules`、`.git`、`.hg`、`.svn`、`dist`、`build`、`coverage`、`.next`、`.nuxt`、`.cache`、`.turbo`、`vendor` 和 `.workspace-resolver`。扫描状态目录也会跳过。
- 不跟随目录软链接，避免循环和越界；显式指定的根目录软链接会规范化成真实路径。隐藏目录若未被排除，仍会扫描。
- 重叠根目录会合并成上级根目录，不重复索引。扫描 package 子目录时，也会关联该目录外层的 Git 仓库。
- 缺失根目录会让本次扫描失败并保留原索引。目录不可读、Git 元数据异常、manifest 无效会产生 `issues` 并尽可能保留此前条目；达到深度限制时也会报告。
- 索引描述上次扫描时的元数据。`resolve` 只额外检查候选目录是否存在；修改前仍需读取当前文件和检查 Git 状态。
- 每次扫描超过 100,000 个目录会中止且不提交。建议只配置真实代码目录。
- remote URL 中的用户名、密码、query 和 fragment 会被移除，不将这类凭据写入索引。

无需 `.git` 的 npm 包也会发现，`repositoryPath` 为 `null`。本版不自动发现 bare repository，也不自动纳入根目录之外的 worktree；将这些 worktree 的父目录或自身目录添加为扫描根目录。

## JSON 存储

存储路径优先级：`--store` > `WORKSPACE_RESOLVER_HOME` > `~/.workspace-resolver`。

```text
~/.workspace-resolver/
  state.json       # config / snapshot / mappings / history
  state.json.bak   # 上一次成功写入之前的完整状态
  .lock/           # 仅写操作执行期间存在，含 owner.json
```

单文件状态带 `schemaVersion: 1` 和递增的 `revision`。写操作获取目录锁，写入临时文件并 flush 后原子 rename；失败不会提交内存中的修改。读操作读取完整的旧版或新版文件。JSON 损坏或结构无效会明确报错，不自动重建覆盖。历史记录随每次写操作追加，没有自动截断。

崩溃后可能留下 `.lock`。确认 `owner.json` 的进程已停止后再手动删除锁目录；工具不会因超时自动抢占仍在运行的写操作。需要恢复时，在没有写操作运行的情况下将 `state.json.bak` 复制回 `state.json`。

状态文件可以人工修改，但推荐用 CLI 修正映射，保留修改记录。状态是个人机器上的本地索引，含绝对路径，不建议提交到业务仓库。原子写入和锁面向本地文件系统；本版不支持多机共享状态或数据库迁移。

## 开发与验证

```bash
yarn typecheck
yarn test
yarn pack --filename source-compass-0.1.0.tgz
```

测试在临时目录创建真实 Git 仓库和 worktree，覆盖 monorepo、嵌套仓库、排除目录、路径空格、Unicode、重复包、人工映射、过期路径、扫描失败回滚、损坏 JSON、并发写入和已安装 skill 的启动链。

源码结构：`scanner.ts` 发现项目，`git.ts` 查询元数据，`store.ts` 管理 JSON 事务，`resolver.ts` 定位源码，`cli.ts` 提供命令，`skill.ts` 打包安装 skill。查询逻辑同时由 `dist/index.js` 导出，可供后续 MCP 层复用。

实现参考：[Git rev-parse](https://git-scm.com/docs/git-rev-parse)、[Node.js 文件系统 API](https://nodejs.org/docs/latest-v22.x/api/fs.html)、[TypeScript NodeNext 模块配置](https://www.typescriptlang.org/tsconfig/module.html)。

## 许可证

本项目使用 [MIT License](LICENSE)。版权署名为当前项目 Git 用户 `yangfeng1`。
