# 离线生产构建与部署

本页介绍已有生产命令的使用方式和限制。各方向的完善进度见 [Roadmap](../ROADMAP.md)；首次离线开发搭建请先阅读 [README](../README.md)。

## 1. 在联网环境准备构建资源

先按 README 配置项目并执行 `dockpack pack dev`。除开发依赖外，生产 Dockerfile 所需的基础镜像、系统库和其他构建资源也必须提前准备。

生产目标支持 `linux/amd64` 和 `linux/arm64`，通过 `target.production_platform` 选择，默认仍为 `linux/amd64`。普通应用的 `target.dev_platform` 须与生产目标一致，确保运行时镜像和依赖缓存匹配。例如向 ARM64 Linux 服务器交付：

```yaml
target:
  dev_platform: linux/arm64
  production_platform: linux/arm64
```

修改架构后需重新在联网环境执行 `dockpack pack dev`。构建机器可以使用其他架构，但 Docker 必须具备运行和构建目标架构容器的能力。静态前端可在已有资源支持的构建架构编译，最终 Nginx 镜像按生产目标架构生成。

`pack dev` 会收集项目根目录 Dockerfile 引用的生产基础镜像；默认复用本地匹配架构的镜像，缺失时拉取。使用 `--pull always` 强制更新，`--pull never` 禁止镜像拉取。其他 Dockerfile 的基础镜像和额外镜像引用需要另行准备。若开发与生产平台不同且复用同一镜像标签，打包会保留开发平台镜像并输出提示，生产平台基础镜像需要另外准备。

## 2. 在离线构建机器初始化并构建

进入已传输源码、配置、依赖文件及开发包的项目目录：

```sh
cd my-project
dockpack build prod -o ./my-project-prod.tar.gz
dockpack prod inspect ./my-project-prod.tar.gz
```

生产构建会自动校验、解包并导入开发资源包，无需先执行 `dev init`；也可用 `build prod --bundle <path>` 指定资源包。构建机器需要可构建 Linux 容器的 Docker daemon，不能靠生产构建过程临时下载缺失资源。

### 使用已有 Compose / Dockerfile

生产打包解析 `compose.files` 和 `compose.profiles`，纳入未被 `compose.exclude_services` 排除的服务。带 `build` 的服务在禁用构建网络的情况下构建为配置的 `target.production_platform`；没有 `build` 的服务镜像必须已在本机且平台匹配，生产构建不会拉取镜像。

根据项目的生产启动方式配置 Compose 和 Dockerfile。`application.build_command` 与 `application.command` 的生效场景见[配置指南](./configuration.md)。Dockerfile 中的安装操作需要能从本地准备的资源完成，远程 `ADD`、需要在线下载的构建前端等也需要处理。

### 没有 Compose

工具会生成单应用镜像和 Compose 配置，要求只检测到一种运行时，使用当前支持的依赖输入，且设置 `application.command`。Node.js 自动生成流程根据 `package.json` 的 `scripts.build` 判断是否执行 `npm run build`。

静态前端的生产服务方式应按项目配置，例如使用已有静态资源服务 Dockerfile；开发服务器命令不能直接当作完整的生产方案。

### 静态前端、自定义 Nginx 与项目环境变量

识别为 Vite 静态前端时，没有 Compose 文件也能自动构建静态资源、Nginx 镜像和部署 Compose。`application.command` 留空；默认执行 `npm run build`，也可通过 `application.build_command` 指定 npm 构建脚本。默认映射 `80:80`；`application.port` 可改变主机端口。

优先使用项目根目录的 `nginx.conf`，保留项目自己的代理路径、SSE、WebSocket 等配置。没有该文件时，生成纯静态 SPA 配置，不添加 API 代理，不要求 `BACKEND_URL`。也可在 `.dockpack.yaml` 显式配置：

```yaml
frontend:
  nginx_config: deploy/nginx.conf
  nginx_config_type: auto # auto、server 或 main
  environment:
    DOCUMENT_API_URL: "${DOCUMENT_API_URL:-http://api:8000}"
    APP_NAME: "${APP_NAME:-documents}"
  required_env: [] # 仅显式列出的变量必填
```

`server` 配置片段渲染至 `/etc/nginx/conf.d/default.conf`，`main` 完整配置渲染至 `/etc/nginx/nginx.conf`；`auto` 根据 `events`、`http` 或 `worker_processes` 指令识别。自定义配置须使用镜像内的静态资源路径 `/usr/share/nginx/html` 和容器监听端口 80；相关 include 文件需自行通过 Dockerfile 提供。

Nginx 配置中的 `${DOCUMENT_API_URL}` 等大写变量占位符会自动加入容器环境，按启动时的值替换；`$uri`、`$host` 等 Nginx 变量保持原样。变量默认为可选；在 `required_env` 声明后会检查非空。已存在的 Compose 环境配置会保留。

生产包只在根目录保留一份 `.env.example`，复用项目自己的 `.env.example` 并追加缺少的变量名。项目真实 `.env` 不会作为部署环境文件进入包内。部署时将自己的 `.env` 放在生产压缩包旁，或使用指定路径：

```sh
dockpack deploy up ./offline-prod-linux-arm64.tar.gz --env-file ./production.env
```

所有 `deploy` 子命令均支持 `--env-file`。选择顺序为显式路径、生产包旁的 `.env`、缓存部署目录的 `.env`。使用显式文件时，后续 `down`、`status`、`logs` 等命令也传入相同参数。更改 Nginx 运行时变量后重新执行 `deploy up`，无需重建镜像。

Vite 的 `VITE_*` 通常在构建时写入浏览器静态资源；项目 `.env` 和 `.env.production` 在生产构建时读取，修改这些值后须重新执行 `build prod`。给 Nginx 容器传变量不会自动修改已编译的前端 JavaScript。后端服务名必须在容器网络中可解析，`localhost` 指向前端容器自身。

## 3. 在离线部署机器启动

将生产包和该主机适用的 dockpack CLI 运行包传给与包内目标架构一致的 Linux Docker 主机，然后执行：

```sh
dockpack deploy import ./my-project-prod.tar.gz
dockpack deploy up ./my-project-prod.tar.gz
dockpack deploy status ./my-project-prod.tar.gz
dockpack deploy logs ./my-project-prod.tar.gz
```

`deploy up` 在镜像未导入时会从包中导入，再启动 Compose，不会构建或拉取镜像。支持 `docker compose` 与独立的 `docker-compose`，优先使用前者。Compose v2 使用 `--pull never`；Compose v1 使用移除 `pull_policy` 的兼容配置，启动前校验所有服务引用的包内本地镜像，并使用 `--no-build`。原包无需重新制作。生产部署机器不需要项目源码或开发依赖缓存，但需要准备运行所需的配置与数据。

若包声明了环境变量，在生产包旁的 `.env`、`--env-file` 指定的文件或进程环境中提供。需要配置的变量写在包根目录唯一的 `.env.example`。部署目录默认为 `~/.local/share/dockpack/deployments/`，设置了 `XDG_DATA_HOME` 时则在其下的 `dockpack/deployments/`。

项目内的 bind mount 会改为部署目录 `runtime/` 下的对应路径，该目录初始为空；源机器上的文件和挂载数据不会随生产包复制。外部卷、外部网络、secrets、主机网络和设备映射需按包内提示在目标主机准备。

停止部署，保留命名卷：

```sh
dockpack deploy down ./my-project-prod.tar.gz
```

## 4. 备份与恢复

仅支持本地 Linux Docker 主机。备份会短暂停止服务，归档内部命名卷后重新启动服务：

```sh
dockpack deploy backup ./my-project-prod.tar.gz -o ./my-project-backup.tar.gz
```

恢复到同一项目：

```sh
dockpack deploy restore ./my-project-prod.tar.gz --backup ./my-project-backup.tar.gz
```

目标卷非空时需要明确覆盖：

```sh
dockpack deploy restore ./my-project-prod.tar.gz --backup ./my-project-backup.tar.gz --overwrite
```

外部卷和其他外部服务的数据需单独管理。镜像离线包不等于业务数据备份。

## uv.lock 项目

支持使用 `pyproject.toml` + `uv.lock` 创建开发资源包。生产构建会校验这两个文件及可选 `uv.toml`，自动生成的 Python Dockerfile 和 `application.build_command` 流程使用开发包中已导出的固定依赖及 wheel，通过 pip 离线安装，不会在离线机器重新运行 uv 解析。已有自定义 Dockerfile 的安装步骤仍由项目维护；如其中使用联网 `uv sync`，需自行调整为离线构建。具体依赖范围与限制见[uv 项目的离线依赖](./configuration.md#uv-项目的离线依赖)。
