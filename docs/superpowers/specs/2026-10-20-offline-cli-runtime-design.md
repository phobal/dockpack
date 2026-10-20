# 离线 CLI 运行包设计

## 背景

dockpack 的开发包和生产包用于网络隔离环境，但当前这些归档不包含 dockpack 自身。离线端在执行 `dev init`、`deploy up` 等命令前，需要另外安装 dockpack。npm 安装无法用于没有网络的机器；仅复制当前 npm tarball 也不够，因为命令需要 Node.js 和 `commander`、`tar`、`yaml`、`zod` 等运行依赖。

目标用户不能保证预装 Node.js。已确认需支持的 dockpack 主机平台为 Linux x64、Windows x64、macOS x64 和 macOS arm64。生产容器当前固定为 `linux/amd64`，但这不决定运行 dockpack 的主机平台。

## 目标

- 提供不需要网络、不需要预装 Node.js、可直接运行的 dockpack 离线运行包。
- 覆盖 Linux x64、Windows x64、macOS x64、macOS arm64。
- 让用户能在联网环境获取并转运运行包，在离线主机解压后使用现有 dockpack 命令。
- 保持项目开发包和生产包聚焦于项目数据，不重复携带所有平台的 Node.js 运行时。
- 正确报告工具版本、包格式版本和不兼容情况。

## 非目标

- 不替代目标主机上的 Docker CLI、Docker daemon 或 Docker Compose。离线部署仍需这些工具。
- 不改变 npm 上面向联网 Node.js 用户的常规安装方式。
- 不把 CLI 和 Node.js 运行时嵌入每个项目包。
- 不要求离线主机访问 npm、GitHub 或其他网络服务。

## 方案

发布独立的、按主机平台区分的离线运行包。每个包包含：

- 使用当前 CLI 源码构建的单文件 JavaScript 命令入口，所有 npm 生产依赖打包在其中。
- 与目标平台和架构匹配的 Node.js 可执行文件。
- POSIX shell 启动器（Linux/macOS）或 Windows 命令启动器。
- dockpack 的 MIT 许可证、Node.js 运行时许可证信息和 SHA-256 校验文件。

离线运行包不包含 npm 缓存，也不要求在目标机运行 npm。启动器从包内路径调用内置 Node.js 和捆绑的 CLI，不依赖安装目录、不含空格等路径假设，并将退出码和信号传回调用者。

建议发布文件名：

| 平台 | 文件名 | 归档格式 |
| --- | --- | --- |
| Linux x64 | `dockpack-cli-<version>-linux-x64.tar.gz` | tar.gz |
| Windows x64 | `dockpack-cli-<version>-win32-x64.zip` | zip |
| macOS x64 | `dockpack-cli-<version>-darwin-x64.tar.gz` | tar.gz |
| macOS arm64 | `dockpack-cli-<version>-darwin-arm64.tar.gz` | tar.gz |

运行包由联网的发布构建流程生成，并与相同版本的 npm 发布物一起提供给联网机器下载。用户根据离线主机的平台选择一个运行包，使用可移动介质或企业既有文件传输方式带入离线环境。传输渠道不由 dockpack 限定。运行包解压到用户指定目录后，可直接调用其中的 `dockpack` 启动器；是否将目录加入 PATH 由用户决定。

## 版本与包格式兼容

- CLI 和离线运行包版本从 `package.json` 读取，移除源码中写死的版本号，确保 `dockpack --version`、离线运行包名称、npm 包版本和项目包的 `dockpack_version` 一致。
- 项目包的 `schema_version` 表示清单格式版本；`dockpack_version` 表示创建该包的工具版本。兼容性以清单格式及其功能为准，不要求 CLI 与项目包的工具版本完全相等。
- CLI 在读取清单时检查 `schema_version`。遇到不支持的格式时，错误信息应指出包格式版本和所需的 dockpack 更新方向；遇到受支持的格式时，允许新 CLI 读取旧版本生成的包。
- `target_platform` 继续表示 Docker 镜像/daemon 的目标平台，不用于选择 CLI 运行包。CLI 运行包平台由其文件名和运行包内部元数据标识。

## 用户流程

联网环境：

1. 安装或构建 dockpack，并照常创建开发包和生产包。
2. 获取适用于离线目标主机的 `dockpack-cli-<version>-<platform>` 运行包及其校验文件。
3. 一并传输 CLI 运行包和项目包。多个同平台主机可复用同一份 CLI 运行包。

离线环境：

1. 用系统归档工具解压对应平台的 CLI 运行包。
2. 运行该目录下的 `dockpack --version` 确认 CLI 可用。
3. 使用该命令执行现有流程，例如 `dockpack dev init ... --bundle ...`、`dockpack dev start ...` 或 `dockpack deploy up ...`。

CLI 启动器不尝试联网，也不自动访问 npm。Docker/Compose 缺失、daemon 不可用、主机平台与运行包不匹配时，输出明确的本地修复提示。

## 构建与验证

发布流程生成四个平台的运行包，并检查每个包包含正确平台的 Node.js 文件、捆绑的 CLI、启动器、许可证和校验文件。构建过程应固定 Node.js 运行时版本，并记录版本及其来源，避免同一 dockpack 版本的运行包包含漂移的 Node.js 版本。

每个平台的发布检查至少包括：

- 校验归档文件清单、SHA-256 和可执行权限。
- 在目标系统上运行 `dockpack --version`、`dockpack --help` 和一个不需要 Docker daemon 的参数错误路径。
- 在 Docker/Compose 可用的集成环境验证开发包导入和生产部署命令的 CLI 调用链。
- 验证含空格的安装路径、非零退出码传递和 Ctrl+C 清理行为。
- 检查归档中没有 `.map`、`.d.ts`、TypeScript 源码、npm 缓存或其他平台的 Node.js 文件。

这些验证属于本功能的发布验收要求；是否增加测试脚本或 CI 配置留给后续实施计划确定。

## 影响与风险

- 每个平台运行包都包含 Node.js，因此体积明显大于 npm 包；独立发布运行包可避免每个项目归档重复承担该体积。
- 用户需要在转运项目包时同时提供一次对应平台的 CLI 运行包。README 和打包输出应清楚展示所需工具版本和各平台运行包名称。
- macOS 可能出现系统对转运可执行文件的安全提示；发布流程应评估签名/公证要求并在 macOS 验收中记录实际行为。
- Node.js 运行时许可证和 dockpack 许可证都必须随运行包保留。
- Docker daemon 的容器平台与 CLI 主机平台是不同概念，不能用生产 `linux/amd64` 推断用户应下载 Linux CLI。
- 当前仓库没有发布矩阵的自动化流程。实现计划需明确平台构建来源、运行时版本固定方式、发布校验和产物生成命令。
