# dockpack

dockpack 帮你在**有网的电脑上准备依赖和 Docker 镜像**，再带到**无网的机器上开发、构建和部署项目**。

第一次使用，按下面的步骤完成一次离线开发环境搭建即可。示例采用「联网电脑 → Linux x64 离线服务器」；其他目标平台的步骤相同，只需选择对应的架构和工具运行包。

## 1. 开始前准备什么？

| 位置 | 需要准备 |
| --- | --- |
| 联网电脑 | 项目源码、Node.js 20 或以上、Docker、Docker Compose v2；能下载项目依赖和 Docker 镜像 |
| 离线机器 | Docker、Docker Compose v2；安装过程见所在环境的 Docker 部署要求 |

两边的 Docker 都需要启动，执行命令的账号需要有 Docker 使用权限。离线机器无需预装 Node.js 或 Python：dockpack 工具运行包自带 Node.js，项目运行时由 Docker 镜像提供。**Docker 和 Compose 本身需要提前安装，dockpack 不会安装它们。**

目前支持的项目依赖：

- **Node.js 项目**：项目根目录有 `package.json` 和 `package-lock.json`，使用 npm。
- **Python 项目**：项目根目录有 `requirements.txt`；缺少时使用 `requirements-dev.txt`，不会自动合并两者，使用 pip。

项目还需能识别运行时版本，例如 Node.js 使用 `.nvmrc` 或 `package.json` 的 `engines.node`，Python 使用 `.python-version`（如 `3.11`）。目前不支持通过修改配置启用 pnpm、Yarn、Poetry 或 uv。

## 2. 在联网电脑上安装 dockpack

```sh
npm install -g dockpack-cli
dockpack --version
```

检查 Docker 和 Compose 是否可用：

```sh
docker version
docker compose version
```

这两个命令应能正常返回版本信息，其中 `docker version` 需要包含服务端信息。

## 3. 在联网电脑上配置项目

进入**你的项目根目录**，不是 dockpack 工具的目录：

```sh
cd my-project
dockpack init
```

命令会生成 `.dockpack.yaml`，其中带有中文注释。已有文件会保留，不会覆盖你的修改。

### 先确认离线机器的架构

打开 `.dockpack.yaml`，修改对应字段，保留其余配置：

```yaml
target:
  dev_platform: linux/amd64
  production_platform: linux/amd64
```

- 离线机器是 **x64 Linux**：`dev_platform` 填 `linux/amd64`。
- 离线机器是 **ARM64 Linux**：填 `linux/arm64`。
- `auto` 使用联网电脑 Docker 的架构；跨机器交付时建议明确填写目标平台。

例如联网电脑是 Apple Silicon Mac，离线服务器是 x64 Linux，这里仍填 `linux/amd64`。联网电脑的 Docker 需要支持运行目标架构容器。

### 再确认开发启动命令和端口

例如 Vite 前端项目：

```yaml
application:
  dev_command: [npm, run, dev, --, --host, 0.0.0.0, --port, "5173"]
  dev_port: 5173
```

将示例替换为项目实际使用的命令和端口。服务需要监听 `0.0.0.0`，端口映射才能访问。

如果项目是 Python 后端，或依赖 MySQL、Redis、MinIO 等服务，请先查看[配置指南中的场景示例](./docs/configuration.md#常见场景)。重点确认：

- `compose.files` 指向项目实际的 Compose 文件。
- `compose.include_services` 包含开发时需要启动的配套服务。
- `compose.dev_networks` 与这些服务使用同一个 Compose 网络；新建配置时会自动检测。
- 后端在容器内通过服务名连接配套服务，例如 `mysql`、`redis`，不能继续使用表示容器自身的 `localhost`。希望本地和离线共用 `.env` 时，可参考[环境变量覆盖示例](./docs/configuration.md#本地与-dockpack-共用一份-env)。

所有字段的作用、默认值及限制见[完整配置指南](./docs/configuration.md)。

## 4. 在联网电脑上打包

仍在项目根目录执行：

```sh
dockpack pack dev
```

dockpack 会准备目标平台的运行时镜像、项目依赖缓存和 Compose 配套服务镜像。命令成功后，开发包默认保存在：

```text
my-project/.dockpack/offline-dev-linux-amd64.tar.gz
```

ARM64 对应文件名为 `offline-dev-linux-arm64.tar.gz`。可以查看包里的目标平台：

```sh
dockpack pack inspect .dockpack/offline-dev-linux-amd64.tar.gz
```

确认输出的 `Target` 与离线机器一致。**如果打包报错，先解决错误再继续，不要使用此前留下的旧包。**

## 5. 准备离线工具，并传输文件

在联网电脑打开 [GitHub Releases](https://github.com/phobal/dockpack/releases)，从 **Assets** 下载适用于离线机器的 CLI 运行包和同名 `.sha256` 文件。

Linux x64 选择 `dockpack-cli-<版本>-linux-x64.tar.gz`。注意下载的是 **dockpack CLI 运行包**，不是 GitHub 自动提供的 Source code；其他系统的选包方式见[离线工具安装说明](./docs/offline-runtime.md)。

需要带走的文件分为两部分：

1. **项目目录**：源码、`.dockpack.yaml`、依赖文件及锁文件、Compose 文件，以及 `.dockpack/` 下刚生成的开发包。项目运行需要的本地配置也要在目标机器准备好。
2. **dockpack CLI 运行包及其校验文件**：供离线机器直接执行工具，无需访问 npm。

建议在离线机器上按下面的结构存放。以下工具版本以 `0.5.0` 为例，请替换为实际下载的版本：

```text
offline-delivery/
├── dockpack-cli-0.5.0-linux-x64.tar.gz
└── my-project/
    ├── .dockpack.yaml
    ├── 项目源码、依赖文件、锁文件及 Compose 文件
    └── .dockpack/
        └── offline-dev-linux-amd64.tar.gz
```

复制时要包含以 `.` 开头的隐藏文件和目录。dockpack 不会自动传输源码，开发包也不包含项目源码或数据库数据。**不要把联网电脑的 `.dockpack/state.json` 当作离线端初始化结果**，在目标机器重新执行下一步的 `dev init`。

## 6. 在离线机器上安装工具并初始化项目

### 解压工具

进入上面的交付目录：

```sh
cd offline-delivery
sha256sum -c dockpack-cli-0.5.0-linux-x64.tar.gz.sha256
tar -xzf dockpack-cli-0.5.0-linux-x64.tar.gz
export PATH="$PWD/dockpack-cli-0.5.0-linux-x64:$PATH"
dockpack --version
```

`export PATH` 只对当前终端生效。新开终端后重新设置，或将解压目录加入账号的 PATH。工具目录中的 `runtime/` 和 `app/` 要完整保留，不能只复制 `dockpack` 启动文件。

### 初始化开发环境

```sh
cd my-project
dockpack dev init
```

该命令默认从项目的 `.dockpack/` 中查找目标平台的开发包，校验后导入镜像、安装依赖、创建本机开发状态。它**不会启动应用**。

不要在离线端执行 `npm install -g dockpack-cli` 或重新运行 `pack dev`。工具和项目依赖已经在联网阶段准备，离线端使用带过来的包。

## 7. 在离线机器上启动并开发

仍在项目根目录执行：

```sh
dockpack dev start
```

应用和选定的配套服务会启动，当前终端显示日志。按前面 Vite 示例配置时，可在浏览器访问 `http://<离线机器地址>:5173`；在服务器本机访问则用 `http://localhost:5173`。远程访问还需允许相应端口通过服务器防火墙。

项目源码挂载到开发容器中，修改源码后由项目自己的开发服务处理热更新。按 `Ctrl+C` 停止本次启动的开发容器，依赖卷和配套服务数据卷会保留。

在另一个已配置好 dockpack PATH 的终端中，也可以执行：

```sh
cd my-project
dockpack dev exec . -- npm run lint  # Node.js 项目示例，需项目有 lint 脚本
dockpack dev stop                  # 停止开发服务
dockpack dev rebuild               # 使用已有离线缓存重新安装依赖
```

## 8. 后续更新怎么做？

| 变化 | 操作 |
| --- | --- |
| 只修改源码 | 直接开发，是否热更新取决于项目自己的开发服务 |
| 修改开发启动命令、端口或开发网络 | 修改配置，停止后重新 `dockpack dev start` |
| 新增或升级依赖、修改运行时版本或目标平台、加入新的配套镜像 | 回到联网电脑重新打包，将新配置、依赖文件、源码和开发包传入离线环境，再执行 `dockpack dev init` |

离线端不能凭空下载新依赖，`dev rebuild` 只使用已经导入的缓存。配置或锁文件变化后，旧开发包不会自动更新。

## 常见问题

| 现象 | 先检查什么 |
| --- | --- |
| 提示找不到默认开发包 | 包是否在项目的 `.dockpack/` 中，文件名与 `dev_platform` 是否匹配；自定义路径使用 `--bundle` |
| 提示包是 ARM64，但服务器需要 AMD64 | 在联网电脑设置正确的 `dev_platform` 后重新打包，传输新包；只修改离线端配置不够 |
| npm 报 `ENOTCACHED` | 缓存不完整或依赖文件与打包时不同；联网端确认收集成功后重新打包 |
| npm 报 `Exit handler never called!` | 查看下载失败详情，确认容器能访问锁文件里固定的 registry 地址 |
| Python 后端连接 `localhost` 的 MySQL 失败 | 容器内改用数据库服务名，并确认开发容器与数据库在同一网络 |
| 服务启动了但浏览器打不开 | 检查监听地址是否为 `0.0.0.0`、实际端口与 `dev_port` 是否一致，以及主机端口访问规则 |

## 其他用法

所有项目目录参数均可省略，默认使用当前命令执行目录。原有全参数形式仍然支持：

```sh
dockpack pack dev ./my-project -o ./custom-dev.tar.gz
dockpack dev init ./my-project --bundle ./custom-dev.tar.gz
dockpack dev start ./my-project
```

- [配置指南：字段、默认值与场景示例](./docs/configuration.md)
- [离线工具：其他平台安装、系统要求与维护者构建](./docs/offline-runtime.md)
- [生产部署：离线构建、部署、备份与恢复](./docs/production.md)
- [命令参考与文件存储位置](./docs/commands.md)
- [Roadmap：各方向进展](./ROADMAP.md)
