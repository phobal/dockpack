# dockpack 命令行工具

dockpack 用于在可联网的机器上准备基于 Docker 的开发与部署离线包，再将离线包导入无网络环境运行。开发包包含当前支持的 Python 或 Node.js 依赖缓存和运行时镜像；生产包包含部署项目所需的 Linux amd64 镜像和 Compose 配置。

dockpack 负责打包和环境生命周期管理，不负责在机器之间同步项目源代码。请另行将项目代码复制或检出到目标机器。

项目进展与后续方向请参阅 [Roadmap](./ROADMAP.md)，覆盖前端与 Python 后端的离线开发、离线生产环境，以及 Skills 辅助配置与搭建。

## 环境要求

- 通过 npm 安装或从源码开发命令行工具需要 Node.js 20 或更高版本。离线运行包自带 Node.js，无需预装 Node.js 或 npm。
- 创建、导入或运行离线包需要 Docker CLI 和正在运行的 Docker 后台服务（daemon）。
- 使用 Compose 的项目，以及开发和部署生命周期命令，需要 Docker Compose v2（`docker compose`）或旧版 Compose（`docker-compose`）。
- 生产打包所用的 Docker daemon 必须能够构建 Linux 容器。当前生产包目标平台为 `linux/amd64`。

## 安装与构建

在代码仓库中执行：

```sh
npm install
npm run build
node dist/cli.js --help
```

将软件发布到 npm 后，可全局安装 `dockpack` 命令：

```sh
npm install --global dockpack-cli
dockpack --help
```

### 无网络、未安装 Node.js 的机器

先在联网机器上取得对应主机平台的离线运行包和旁边的 `.sha256` 校验文件，再与项目离线包一起传入离线环境。运行包需要完整解压，不能只复制启动脚本。项目源码也需要另行传输。

| 离线主机 | 运行包名称 |
| --- | --- |
| Linux x64 | `dockpack-cli-<版本>-linux-x64.tar.gz` |
| Linux ARM64/aarch64 | `dockpack-cli-<版本>-linux-arm64.tar.gz` |
| Windows x64 | `dockpack-cli-<版本>-win32-x64.zip` |
| macOS Intel | `dockpack-cli-<版本>-darwin-x64.tar.gz` |
| macOS Apple Silicon | `dockpack-cli-<版本>-darwin-arm64.tar.gz` |

这些是同一版本的五个发行附件，npm 包仍只发布一次。选择的是运行 dockpack 的主机平台，不是 Docker 容器平台。例如在 Apple Silicon Mac 上操作 Linux 容器，应选择 `darwin-arm64`。

Linux ARM64 运行包适用于 ARM64/aarch64 主机。项目生产包当前以 `linux/amd64` 为目标，部署时要求 Docker daemon 的平台与项目包匹配；ARM64 生产镜像尚未支持。

Linux/macOS 示例（将版本和平台替换为实际值）：

```sh
# macOS 使用 shasum；Linux 也可以使用 sha256sum -c
shasum -a 256 -c dockpack-cli-0.1.0-darwin-arm64.tar.gz.sha256
tar -xzf dockpack-cli-0.1.0-darwin-arm64.tar.gz
./dockpack-cli-0.1.0-darwin-arm64/dockpack --version
./dockpack-cli-0.1.0-darwin-arm64/dockpack dev init ./my-project --bundle ./my-project-dev.tar.gz
```

Windows PowerShell 示例：

```powershell
Get-FileHash .\dockpack-cli-0.1.0-win32-x64.zip -Algorithm SHA256
# 将输出与同名 .zip.sha256 文件内的值核对后解压
Expand-Archive .\dockpack-cli-0.1.0-win32-x64.zip -DestinationPath .\tools
.\tools\dockpack-cli-0.1.0-win32-x64\dockpack.cmd --version
.\tools\dockpack-cli-0.1.0-win32-x64\dockpack.cmd dev init .\my-project --bundle .\my-project-dev.tar.gz
```

运行包内有启动器、`runtime/` 下的 Node.js、`app/` 下的 CLI、许可证、平台元数据 `runtime.json` 和文件校验清单。可以将解压后的运行包根目录加入 PATH，之后直接使用 `dockpack`。启动器会调用内置 Node.js，不访问 npm，也不会自动下载依赖。Docker CLI、daemon 和 Compose 仍需预先准备。

当前内置 Node.js 24.22.0，其[系统要求](https://github.com/nodejs/node/blob/v24.22.0/BUILDING.md#platform-list)为：Linux x64/arm64 内核 >= 4.18、glibc >= 2.28；Windows x64 >= Windows 10/Server 2016；macOS >= 13.5。Linux 使用官方 glibc 构建，不适用于 Alpine/musl。macOS 包目前没有额外的应用签名/公证，需按企业的可执行文件分发策略部署。生产卷备份和恢复仍只支持本地 Linux Docker 主机。

### 构建离线运行包（维护者）

```sh
npm ci
npm run build:offline
# 或只生成一个平台
npm run build:offline -- --target darwin-arm64
# Linux ARM64
npm run build:offline -- --target linux-arm64
# 指定输出目录
npm run build:offline -- --target linux-x64 --output ./release
```

此命令在联网机器上将 CLI 及其 npm 生产依赖打包为单文件，并下载已固定版本的官方 Node.js 归档。Node.js 版本、下载来源和五个平台的 SHA-256 固定在 `scripts/offline-runtime.json`；每次使用缓存也会校验哈希。更新运行时需同步更新版本、文件名和校验值，官方校验文件位于 `https://nodejs.org/dist/v<版本>/SHASUMS256.txt`。

产物默认写入 `release/`，每个平台生成一个压缩包和一个 `.sha256` 文件。下载缓存位于 `.offline-cache/`，临时构建目录为 `.offline-build/`，这些目录不进入 Git 或 npm 发布包。运行包包含 dockpack、Node.js 和已捆绑第三方依赖的许可证文本。

仓库的 **Build offline runtime packages** GitHub Actions 工作流支持手动执行或通过 `v<版本>` 标签触发，在五种原生主机上构建、核对校验和并检查启动器。完成后，从 Actions 产物中取得五套文件，作为同一个 GitHub Release 的附件或放到企业内部下载站；工作流不会自动发布 npm 包或创建 Release。

CLI 版本和项目包的 `dockpack_version` 都取自 `package.json`。项目归档按 `schema_version` 判断兼容性，支持的旧格式无需与 CLI 版本号完全相等；遇到不支持的格式时，CLI 会提示转运兼容的离线运行包。

## 常见工作流程

### 准备和使用离线开发环境

在有网络、包含项目源代码且 Docker 可用的机器上执行：

```sh
dockpack init ./my-project
# 按需检查并修改 my-project/.dockpack.yaml
dockpack pack dev ./my-project --output ./my-project-dev.tar.gz
```

将开发包和项目源代码分别传到离线机器，然后执行：

```sh
dockpack init ./my-project            # 仅在项目中没有 .dockpack.yaml 时执行
dockpack dev init ./my-project --bundle ./my-project-dev.tar.gz
dockpack dev start ./my-project
```

`dev init` 会校验归档和依赖输入文件，将包内 Docker 镜像导入本机 Docker 后台服务，把开发包缓存存到 `$XDG_CACHE_HOME/dockpack/bundles/`（未设置时使用 `~/.cache/dockpack/bundles/`），并创建本地依赖卷。该命令不会启动应用服务。项目中的依赖文件必须与打包时一致；dockpack 会校验文件哈希，文件变化后需要重新生成开发包。

`dev start` 会在前台运行配置的 Compose 服务和 dockpack 开发运行容器。按 `Ctrl+C` 会停止并移除本次启动的容器；命名依赖卷和其他服务容器会保留。对于 `dev` 脚本中调用 Vite 的 Node.js 项目，dockpack 会推断启动命令、将服务绑定到 `0.0.0.0`、映射端口（默认 `5173`），并显示本地访问地址。其他项目需要在 `.dockpack.yaml` 中配置 `application.dev_command`，并可选填 `application.dev_port`：

```yaml
application:
  dev_command: [npm, run, dev, --, --host, 0.0.0.0]
  dev_port: 5173
```

其他开发命令：

```sh
dockpack dev exec ./my-project -- npm run lint
dockpack dev stop ./my-project
dockpack dev rebuild ./my-project
```

`dev exec` 在第一个已配置的 Python 或 Node.js 开发容器中执行命令；该容器必须正在运行。`dev stop` 停止已配置的开发服务和纳入运行的 Compose 服务。`dev rebuild` 使用导入的离线缓存创建新的依赖卷并安装依赖，不会启动服务。

### 构建和运行离线生产部署包

先在将要构建生产包的机器上导入并初始化开发包，使收集到的依赖缓存和基础镜像可供离线构建使用。然后生成生产归档：

```sh
dockpack dev init ./my-project --bundle ./my-project-dev.tar.gz
dockpack build prod ./my-project --output ./my-project-prod.tar.gz
```

将生产归档传到目标 Linux amd64 Docker 主机后执行部署：

```sh
dockpack deploy import ./my-project-prod.tar.gz
dockpack deploy up ./my-project-prod.tar.gz
dockpack deploy status ./my-project-prod.tar.gz
dockpack deploy logs ./my-project-prod.tar.gz [service]
dockpack deploy down ./my-project-prod.tar.gz
```

部署文件存放在 `$XDG_DATA_HOME/dockpack/deployments/`（未设置时使用 `~/.local/share/dockpack/deployments/`）。需要的镜像尚未导入时，`deploy up` 会从包中导入镜像，然后启动 Compose；此过程不会构建或拉取镜像。如果包声明了生产环境变量，请在部署目录的 `.env` 文件或启动命令的进程环境中提供这些变量。需要配置的变量会写入包内的 `.env.example`。

对于 Compose 项目，生产打包会解析配置的 Compose 文件，纳入未排除的服务并打包其镜像。带有 `build` 配置的服务会在禁用网络的情况下构建为 `linux/amd64` 镜像。没有 `build` 配置的服务所引用的镜像必须已存在于本机，且平台匹配；生产构建过程不会拉取这些镜像。`pack dev` 也会尝试缓存项目根目录 `Dockerfile` 中引用的 `linux/amd64` 基础镜像，供使用该 Dockerfile 的生产构建流程使用。其他构建基础镜像和镜像引用需要预先以所需平台准备好。如果项目没有 Compose 配置，dockpack 会生成单应用镜像和 Compose 文件；此方式要求项目只检测到一种运行时、依赖输入受支持，并且显式配置 `application.command`。

`deploy backup` 会归档内部命名卷，并在备份期间短暂停止再重启服务。`deploy restore` 将备份恢复到同一项目；目标卷非空时必须添加 `--overwrite`。备份和恢复要求本机 Docker 主机运行 Linux。`deploy down` 会保留命名卷。

```sh
dockpack deploy backup ./my-project-prod.tar.gz --output ./my-project-backup.tar.gz
dockpack deploy restore ./my-project-prod.tar.gz --backup ./my-project-backup.tar.gz
dockpack deploy restore ./my-project-prod.tar.gz --backup ./my-project-backup.tar.gz --overwrite
```

## 命令一览

```bash
dockpack init [project-directory]
dockpack pack dev [project-directory] --output <archive>
dockpack pack inspect <archive>
dockpack import <archive>
dockpack dev init [project-directory] --bundle <archive>
dockpack dev start|stop|rebuild [project-directory]
dockpack dev exec [project-directory] -- <command...>
dockpack build prod [project-directory] --output <archive>
dockpack prod inspect <archive>
dockpack deploy import|up|down|status <archive>
dockpack deploy logs <archive> [service]
dockpack deploy backup <archive> [--output <archive>]
dockpack deploy restore <archive> --backup <archive> [--overwrite]
```

`pack inspect` 和 `prod inspect` 会校验归档路径及校验和，然后输出包的元数据。`dockpack import` 是通用的镜像导入命令；开发环境应使用 `dev init`，它还会安装依赖并写入项目状态。生产部署命令则会管理部署目录和 Compose 服务。

## 项目发现与配置

在 `.dockpack.yaml` 中分别设置开发包和生产包的容器目标平台：

```yaml
target:
  dev_platform: linux/arm64
  production_platform: linux/amd64
```

`target.dev_platform` 支持 `linux/amd64`、`linux/arm64` 和 `auto`。默认值为 `auto`，打包时使用当前 Docker daemon 的平台；旧配置没有该字段时也按 `auto` 处理。`dockpack init` 新生成的配置会显式写入 `dev_platform: auto`。

`pack dev` 使用选定的平台拉取运行时与基础服务镜像、运行 Python/npm 依赖收集容器、构建 Compose 服务，并将该平台写入开发包清单。跨架构打包要求联网机器的 Docker 能执行目标架构容器（例如已配置相应的模拟执行支持）。离线端 `dev init` 会核对显式配置、包清单与 Docker daemon 的平台，生成的开发 Compose 配置也会使用包内目标平台。变更开发平台后，需要在联网环境重新打包，并在离线机器重新执行 `dev init --bundle ...`。

如果 Compose 服务已配置 `build.platforms`，dockpack 会将该列表替换为开发目标平台，避免构建其他架构。这种情况需要 [Docker Compose 2.24.4 或更新版本](https://docs.docker.com/reference/compose-file/merge/#replace-value)；旧版本需升级 Compose 或移除该服务的 `build.platforms` 配置。

开发平台与生产平台不同、且根目录 Dockerfile 的生产基础镜像复用了开发镜像标签时，打包会保留开发架构的镜像并输出警告；对应生产基础镜像需要在离线生产构建前另行准备，避免同一标签被其他架构覆盖。`production_platform` 当前仍只支持 `linux/amd64`。这里的 `linux/arm64` 是容器平台名称；CLI 离线运行包中的 `linux-arm64` 则表示运行 dockpack 的主机平台。

`dockpack init` 会分析项目，并且只在 `.dockpack.yaml` 不存在时创建配置文件。它会报告检测到的 Python/Node.js 运行时、Compose 服务和需要关注的问题；如果配置文件已存在，则会保留原文件。Compose 发现逻辑会检查项目根目录中的标准文件名，也会向下检查最多四层目录，寻找唯一且明确的嵌套项目。如果发现多个嵌套项目，请在 `compose.files` 中指定配置文件。

初始化时，dockpack 可从 `.nvmrc`、`.node-version`、`.tool-versions`、`package.json` 的 `engines.node` 字段，以及常见脚本中的显式 `NODE_VERSION` 赋值读取 Node.js 版本提示。它还会尝试从项目元数据推断应用启动和构建命令，并为 Vite 推断开发命令。打包前请检查生成的配置，尤其是 `application.service`、`application.command`、`application.build_command`、Compose 服务选择和依赖文件列表。

当前版本支持收集以下离线依赖：

- Python：通过 pip 收集 `requirements.txt` 或 `requirements-dev.txt`。
- Node.js：通过 npm 收集 `package.json` 和 `package-lock.json` 对应的依赖。

`init` 可能会检测到其他 Python 或 Node.js 包管理器，但当前版本尚不支持用它们创建离线包。Python 项目需要可检测到 Python 主版本和次版本；Node.js 项目需要可检测到 Node.js 版本。`pack dev` 会显示各阶段的进度和耗时，并实时输出较长时间运行的 Docker 和包管理器命令日志。

## 离线包和路径处理

离线包是带有清单和 SHA-256 校验和的 gzip 压缩 tar 归档。导入和检查归档时，dockpack 会先校验归档内容。开发状态保存在项目的 `.dockpack/` 目录下；生成的 `.dockpack/compose.dev.yaml` 使用 `${DOCKPACK_PROJECT_DIR}` 挂载项目源代码，dockpack 在调用 Compose 时会设置此变量。安装依赖期间，临时文件 `.dockpack/compose.install.yaml` 会挂载本机缓存，安装结束后即删除。生成的 overlay 和状态文件不会保存项目目录或缓存目录的绝对路径。

生产 Compose 配置中指向项目内部的绑定挂载（bind mount）会改写为相对于部署目录 `runtime/` 的路径。该目录初始为空，因此主机上的文件和挂载数据不会被复制进离线包。外部卷、外部网络、密钥配置（secrets）、主机网络和设备映射可能需要在目标主机单独配置；请检查打包时的警告和生产包内的说明文档。
