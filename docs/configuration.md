# `.dockpack.yaml` 配置指南

配置文件放在项目根目录。执行 `dockpack init <项目目录>` 会分析项目并生成带中文注释的配置；已有文件会保留，再次初始化不会补写新字段或更新旧注释。

## 先配置这几项

对于没有 Compose 的 npm 前端项目，未声明 Node.js 版本时会默认使用 Node.js 22。可以通过以下 `runtime.node_version` 显式设置项目需要的版本：

```yaml
schema_version: 1
project:
  name: my-frontend
  ecosystems: [node]
runtime:
  node_version: "22"
application:
  dev_command: [npm, run, dev, --, --host, 0.0.0.0, --port, "5173"]
  dev_port: 5173
target:
  dev_platform: linux/amd64
```

该示例适用于 Vite 的 `dev` 脚本和 x64 Linux 离线服务器。请根据项目脚本和服务器架构调整命令、端口及平台。其他字段可以省略，程序会使用默认值。

1. `project.ecosystems`：前端通常填 `[node]`，Python 后端填 `[python]`。开发初始化会按此列表安装依赖并创建运行容器。
2. `target.dev_platform`：填写离线服务器的 Docker 容器平台。x64 Linux 为 `linux/amd64`，ARM64 Linux 为 `linux/arm64`。Apple Silicon Mac 向 x64 服务器交付时也应填 `linux/amd64`。
3. `application.dev_command`：程序实际的开发启动命令，按参数拆为数组。
4. `application.dev_port`：与程序监听端口一致。Web 服务需监听 `0.0.0.0`，否则主机可能无法访问。
5. 使用数据库等 Compose 服务时，再配置 `compose.files`、`compose.include_services` 和 `compose.dev_networks`。

在联网机器修改并打包，将配置、项目源码、锁文件和离线包一起传给目标机器：

```sh
# 联网机器
cd ./my-frontend
dockpack pack dev
dockpack pack inspect ./.dockpack/offline-dev-linux-amd64.tar.gz

# 离线机器：先传输源码、配置、锁文件及 .dockpack/ 下的包
cd ./my-frontend
dockpack dev init
dockpack dev start
```

上例的 `dev_platform` 为 `linux/amd64`。默认开发包路径为 `<项目>/.dockpack/offline-dev-<平台>.tar.gz`，平台中的 `/` 换成 `-`；`auto` 使用执行命令时 Docker daemon 的实际平台。项目目录默认取当前工作目录，`dev init` 按相同规则查找包。跨架构交付时请显式设置目标平台，避免在联网和离线机器上解析出不同的默认文件名。

原有全参数形式仍可使用，例如 `dockpack pack dev ./my-frontend -o ./custom-dev.tar.gz` 和 `dockpack dev init ./my-frontend --bundle ./custom-dev.tar.gz`。显式 `-o` / `--bundle` 路径相对于命令执行目录解析；默认路径则位于指定项目内部。旧包或自定义名称的包可以继续通过 `--bundle` 导入。

## 配置规则

- 字段名区分大小写；未知字段会报错。
- 下表默认值是省略字段时的值。`dockpack init` 会根据项目写入检测结果，因此生成值可能不同。
- 省略与空值不同：列表用 `[]`，可空端口用 `null`；不要用 YAML 空值代替必需的字符串或数组。
- 命令必须是字符串数组，例如 `[npm, run, dev]`，不能写成字符串 `"npm run dev"`。端口参数等数字要加引号，例如 `"5173"`。
- 命令不自动经 shell 执行。需要 `&&`、管道或变量展开时，显式使用 `[sh, -c, "命令"]`，并确认运行镜像内有对应 shell。
- `compose.files` 相对于项目根目录解析，与调用命令时的工作目录无关。
- 运行时版本使用嵌套字段 `runtime.node_version` 和 `runtime.python_version`，不能写成顶层 `node_version` 或 `python_version`。此配置没有 `registry`、`environment`、`volumes` 等字段；服务环境变量和挂载等使用 Compose/Dockerfile 配置。npm registry 还可能被锁文件中的下载地址固定，修改本机 registry 不一定能改变收集来源。

## 完整字段参考

### 格式与项目

| 字段 | 类型 / 可选值 | 默认值 | 作用与注意事项 |
| --- | --- | --- | --- |
| `schema_version` | 整数 `1` | `1` | 配置格式版本，不是 dockpack 软件版本。 |
| `project.name` | 非空字符串 | 必填 | 写入包清单，并参与生成生产镜像等名称。初始化时使用项目目录名。 |
| `project.ecosystems` | 字符串数组，元素为 `node` 或 `python` | `[]` | 决定开发环境安装哪些依赖、创建哪些运行容器；自动生成生产镜像时要求项目只检测到一种运行时。`pack dev` 仍会检测实际依赖文件，修改此列表不会让不受支持的包管理器变得可用。 |

### `runtime`：Node.js 与 Python 运行时版本

| 字段 | 类型 / 可选值 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `runtime.node_version` | `auto` 或版本号，如 `"22"`、`"22.14.0"` | `auto` | 控制开发打包、原生前端构建资源及自动生产构建使用的 Node.js 镜像。显式版本优先于项目声明；指定完整版本时保留补丁号。主版本也可写为数字，如 `22`。 |
| `runtime.python_version` | 字符串 `auto` 或版本号，如 `"3.12"`、`"3.12.7"` | `auto` | 控制开发打包和自动生产构建使用的 Python 镜像。必须加引号；显式版本优先于项目声明，并保留补丁号。 |

```yaml
runtime:
  node_version: "22" # 使用 node:22-bookworm-slim
  python_version: "3.12" # 使用 python:3.12-slim
```

设置为 `auto` 或省略此字段时，按 `.nvmrc` → `.node-version` → `package.json` 的 `engines.node` → `.tool-versions` → 项目脚本中的 `NODE_VERSION` 顺序检测。沿用已有行为，从检测到的声明中取主版本；需要固定次版本或补丁号时，请显式设置 `runtime.node_version: "22.14.0"`。

也可在项目根目录创建 `.nvmrc`，内容为 `22`，或在 `package.json` 中添加：

```json
{
  "engines": { "node": ">=22" }
}
```

完全没有版本声明时使用 Node.js 22，控制台会打印默认镜像和配置示例。已声明但无法解析的版本不会被默认值覆盖，会报错并提示修改 `runtime.node_version`、`.nvmrc` 或 `engines.node`。配置字段仅接受 `auto` 或具体版本，不接受 `latest`、`lts/*`、`>=22` 等别名或范围。

Python 的选择顺序为 `runtime.python_version` 显式版本 → `.python-version` → `pyproject.toml` 的 `[project].requires-python` → 默认 **3.12**。`auto` 模式沿用项目声明中的主、次版本，例如 `.python-version` 为 `3.11.9` 时使用 `python:3.11-slim`；需要固定补丁号时设置 `runtime.python_version: "3.11.9"`。

也可在项目根目录创建 `.python-version`，内容为 `3.12`，或在 `pyproject.toml` 中填写：

```toml
[project]
requires-python = ">=3.12"
```

未声明 Python 版本时会使用 `python:3.12-slim` 并打印配置示例。无法解析已有声明时会报错并提示设置方法。`runtime.python_version` 必须是字符串，例如 `"3.10"`；不接受数字、仅主版本 `"3"` 或范围 `">=3.12"`，避免 YAML 将 `3.10` 转成 `3.1`。

已有 `.dockpack.yaml` 无需迁移，省略 `runtime` 即可使用自动选择。`dockpack init` 不会覆盖已有配置；需要显式指定时，手动添加上述 `runtime` 配置。修改版本后，请重新执行 `dockpack pack dev`，将配置和新包一起传给离线机器，并重新执行 `dockpack dev init`。自定义 Dockerfile 内的 `FROM` 仍由项目自行维护。

### `application`：启动、构建与端口

| 字段 | 类型 | 默认值 | 实际生效场景 |
| --- | --- | --- | --- |
| `application.service` | 字符串 | `app` | 原 Compose 中的应用服务名。开发包会跳过该服务的镜像，使用 `dockpack-dev-node` / `dockpack-dev-python` 作为开发容器；生产流程按此名称定位应用。无 Compose 时保留默认值即可。 |
| `application.dev_command` | 字符串数组 | `[]` | 开发容器启动命令。为空时 `dev start` 尝试推断；未能推断时使用 `sleep infinity` 保持容器运行，可通过 `dev exec` 操作。 |
| `application.dev_port` | 整数 `1–65535` 或 `null` | `null` | 开发服务的同号主机/容器端口映射，例如 `5173:5173`，不会修改程序监听端口。命令为空且能识别 Vite 时，`dev start` 可能推断命令及端口。 |
| `application.command` | 字符串数组 | `[]` | 自动生成生产 Dockerfile 时的启动命令，不能为空。不用于开发启动，也不统一覆盖已有 Dockerfile/Compose 的命令。 |
| `application.build_command` | 字符串数组 | `[]` | 当原 Compose 应用只有 `image`、没有 `build`，且根目录存在 Dockerfile 时，生产流程先在已初始化的开发容器中执行此命令，再构建该 Dockerfile。其他已有 Compose `build` 场景以其 Dockerfile 为准；自动生成的 Node.js Dockerfile 根据 `scripts.build` 决定是否执行 `npm run build`。 |
| `application.port` | 整数 `1–65535` 或 `null` | `null` | 自动生成生产应用服务时的同号端口映射；`null` 表示不添加映射。已有 Compose 服务应在 Compose 中设置端口。 |

`dev_command` 与 `command` 分别用于开发和生产。例如 Vite 开发服务器的命令不能直接当作静态资源生产部署方案。

### `target`：容器目标平台

| 字段 | 可选值 | 默认值 | 作用与注意事项 |
| --- | --- | --- | --- |
| `target.dev_platform` | `auto`、`linux/amd64`、`linux/arm64` | `auto` | `pack dev` 的镜像和依赖收集平台。`auto` 使用打包机器 Docker daemon 的平台，不会自动识别另一台离线服务器。修改后需重新打包，并在离线端重新 `dev init`。 |
| `target.production_platform` | 当前仅支持 `linux/amd64` | `linux/amd64` | 生产构建平台，同时用于准备根目录 Dockerfile 的生产基础镜像。虽然配置解析接受字符串，生产构建会拒绝其他值。 |

跨架构打包要求联网机器的 Docker 能运行目标架构容器。离线端会检查配置、开发包和 Docker daemon 的平台是否匹配。

CLI 离线运行包中的 `darwin-arm64`、`linux-x64` 等名称表示 CLI 主机平台，与这里的容器平台分别选择，详见[运行包选择说明](./offline-runtime.md#选择运行包)。开发与生产平台不同、且使用同一镜像标签时，打包保留开发平台镜像并输出提示，生产平台基础镜像需另行准备，详见[生产构建准备](./production.md#1-在联网环境准备构建资源)。

如果 Compose 服务配置了 `build.platforms`，开发打包会使用 `!override` 将其替换为开发目标平台；这种情况需要 Docker Compose 2.24.4 或以上。旧版需升级或移除该列表。

### `compose`：现有服务与文件

| 字段 | 类型 | 默认值 | 作用与注意事项 |
| --- | --- | --- | --- |
| `compose.files` | 字符串数组 | `[]` | 按数组顺序加载、合并的 Compose 文件。`init` 会尝试发现并写入路径；配置中的空列表表示不加载 Compose，不会在后续打包时重新发现文件。 |
| `compose.profiles` | 字符串数组 | `[]` | 启用的 Compose profiles，需要 Compose v2。 |
| `compose.dev_networks` | 非空字符串组成的数组 | `[]` | 所有 dockpack 开发容器加入的 Compose 网络配置键，例如 `[57ai-network]`。空列表使用隐式默认网络。`init` 根据配套服务的网络自动生成并去重，可手动删减；不修改生产服务的网络。 |
| `compose.include_services` | 字符串数组 | `[]` | `dev start/stop` 显式纳入的配套服务。通常填写数据库、缓存等，不填写被开发容器替代的原应用服务。它不是打包白名单，也不控制生产包包含哪些服务。 |
| `compose.exclude_services` | 字符串数组 | `[]` | 开发与生产打包排除的服务。与 `include_services` 不得重叠；还应同步调整 Compose 中对被排除服务的依赖。 |

开发打包收集除 `application.service` 和排除列表之外的配套服务镜像；生产打包纳入未排除的服务。因此，只填写 `include_services: [db]` 不会自动排除 Compose 中其他服务。

`dev_networks` 支持从服务的网络列表和网络映射两种写法中检测网络键。只有默认网络时生成 `[]`；配套服务分别使用默认网络和自定义网络时，会同时列出 `default` 与自定义网络；多个自定义网络取并集。如没有配套服务，则参考原应用服务。`network_mode: host/none/service:.../container:...` 不会转换为网络名。多个网络之间存在隔离要求时，应在生成后按需删减。

网络键必须来自 `compose.files` 的网络定义；`default` 可使用 Compose 的隐式默认网络。此字段不会自动创建外部网络，`external: true` 的网络仍需提前准备。不要填写 Docker 展示的带项目前缀的实际名称：例如 Compose 定义 `networks: { app-net: { name: shared-net } }` 时，应填写 `app-net`，而不是 `shared-net`。

### `dependencies`：依赖检测记录与限制

| 字段 | 类型 / 可选值 | 默认值 | 当前行为 |
| --- | --- | --- | --- |
| `dependencies.policy` | 字符串 `locked` | `locked` | 当前仅允许这一种策略。实际版本是否固定取决于依赖文件；它不会自动锁定未固定版本的 Python requirements。 |
| `dependencies.node_files` | 字符串数组 | `[]` | 初始化生成的检测记录。当前不会根据此列表改换收集路径，实际使用根目录 `package.json` 和 `package-lock.json`。 |
| `dependencies.python_files` | 字符串数组 | `[]` | 初始化生成的检测记录。当前不会根据此列表改换收集路径，优先使用根目录 `requirements.txt`；缺少时使用 `requirements-dev.txt`，不会自动合并二者。 |

当前开发包支持 npm 和 pip。修改文件列表无法启用 pnpm、Yarn、Poetry 或 uv，也不会指定其他位置的依赖文件。

## 常见场景

### Python 开发服务

以下示例假设项目使用 pip、根目录有 `requirements.txt` 和 `.python-version`，且安装了 Uvicorn，应用入口为 `app.main:app`。请按实际项目修改：

```yaml
project:
  name: my-api
  ecosystems: [python]
application:
  dev_command: [python, -m, uvicorn, "app.main:app", --host, 0.0.0.0, --port, "8000", --reload]
  dev_port: 8000
target:
  dev_platform: linux/amd64
```

Python 的系统库、原生扩展及安装过程所需资源仍需按项目准备，参见 [Roadmap](../ROADMAP.md#2-后端-python-离线开发环境)。

### 开发时同时启动数据库和缓存

在已有配置中设置以下部分，服务名称应与实际 Compose 一致：

```yaml
application:
  service: api
compose:
  files: [compose.yaml, compose.offline.yaml]
  profiles: []
  dev_networks: [app-network]
  include_services: [db, redis]
  exclude_services: [adminer]
```

保留已有的 `application.dev_command` 等其他字段。上例要求两个 Compose 文件都存在、定义了 `app-network`，且 `db`、`redis` 也加入该网络，并已处理对 `adminer` 的服务依赖。dockpack 会生成应用开发容器，配套服务按 Compose 的配置启动。

后端配置中的连接地址也要使用 Compose 服务名和容器端口，例如 `MYSQL_HOST=db`、`REDIS_HOST=redis`。容器里的 `localhost` 指向自己，仅加入网络不会自动改写 `.env` 或应用配置。对于 57ai 示例，应设置 `dev_networks: [57ai-network]`，并将 `MYSQL_HOST`、`REDIS_HOST`、`MINIO_ENDPOINT` 分别设置为 `mysql`、`redis`、`minio:9000`。

### 本地与 dockpack 共用一份 `.env`

如果应用像本项目的 Python 示例一样使用 Pydantic Settings，进程环境变量优先于 `.env`。可保留供本地直接启动使用的 `.env`：

```dotenv
MYSQL_HOST=localhost
REDIS_HOST=localhost
MINIO_ENDPOINT=localhost:9000
```

再在 `.dockpack.yaml` 的开发命令中为容器进程覆盖连接地址。以下服务名和网络名以 57ai 项目为例：

```yaml
application:
  dev_command:
    - env
    - MYSQL_HOST=mysql
    - REDIS_HOST=redis
    - MINIO_ENDPOINT=minio:9000
    - uvicorn
    - app.main:app
    - --host
    - 0.0.0.0
    - --port
    - "8000"
    - --reload
  dev_port: 8000
compose:
  # 保留原有 files、include_services 等配置
  dev_networks: [57ai-network]
```

本地直接启动时读取 `.env` 的 `localhost`，dockpack 启动的应用进程则读取上述覆盖值，无需来回改 `.env`。该方式要求镜像有 `env` 命令，且应用没有反过来强制以文件值覆盖环境变量。它只作用于此启动命令及其子进程，不会给独立的 `dev exec` 命令自动注入这些值。当前没有独立的 `dev_environment` 配置字段。

## 修改后什么时候生效？

| 修改内容 | 后续操作 |
| --- | --- |
| 开发命令、开发端口 | 停止开发服务后重新 `dev start`，同时确认程序监听地址和端口。 |
| `compose.dev_networks` | 使用支持该字段的 CLI，停止开发服务后重新 `dev start`，启动时重新生成的 overlay 会应用网络配置。仅调整已有网络的连接关系不需要重新打包依赖；若引入新服务镜像则需要重新打包。旧配置缺少此字段时默认 `[]`，可手动补充；再次 `init` 不会覆盖已有配置。 |
| 开发平台、运行时版本、依赖文件 | 联网端重新 `pack dev`，传输新配置、源码和依赖文件，再在离线端 `dev init --bundle ...`。仅修改离线端配置不会转换包内镜像或补全依赖。 |
| 开发运行时列表、Compose 服务及镜像 | 重新打包并初始化，确保新容器所需的镜像和依赖已随包交付。 |
| 生产启动命令、生产端口、生产构建配置 | 按该字段的适用场景重新 `build prod`，再传输和部署新的生产包。 |
| `dependencies.*_files` 检测记录 | 当前不改变实际依赖收集行为，不能用来指定新的依赖文件。 |

检查包的实际平台请使用 `dockpack pack inspect <离线包>`。若配置写的是 AMD64 而清单仍为 ARM64，应确认打包工具版本、项目路径，并重新生成、传输正确的包。
