# `.dockpack.yaml` 配置指南

配置文件放在项目根目录。执行 `dockpack init <项目目录>` 会分析项目并生成带中文注释的配置；已有文件会保留，再次初始化不会补写新字段或更新旧注释。

## 先配置这几项

对于没有 Compose 的 npm 前端项目，先确认运行时版本可被识别（例如根目录的 `.nvmrc` 或 `package.json` 的 `engines.node`），再检查以下配置：

```yaml
schema_version: 1
project:
  name: my-frontend
  ecosystems: [node]
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
5. 使用数据库等 Compose 服务时，再配置 `compose.files` 和 `compose.include_services`。

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
- 此配置没有 `registry`、`node_version`、`python_version`、`environment`、`volumes` 等字段。运行时版本从项目元数据识别；服务环境变量和挂载等使用 Compose/Dockerfile 配置。npm registry 还可能被锁文件中的下载地址固定，修改本机 registry 不一定能改变收集来源。

## 完整字段参考

### 格式与项目

| 字段 | 类型 / 可选值 | 默认值 | 作用与注意事项 |
| --- | --- | --- | --- |
| `schema_version` | 整数 `1` | `1` | 配置格式版本，不是 dockpack 软件版本。 |
| `project.name` | 非空字符串 | 必填 | 写入包清单，并参与生成生产镜像等名称。初始化时使用项目目录名。 |
| `project.ecosystems` | 字符串数组，元素为 `node` 或 `python` | `[]` | 决定开发环境安装哪些依赖、创建哪些运行容器；自动生成生产镜像时要求项目只检测到一种运行时。`pack dev` 仍会检测实际依赖文件，修改此列表不会让不受支持的包管理器变得可用。 |

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

CLI 离线运行包中的 `darwin-arm64`、`linux-x64` 等名称表示 CLI 主机平台，与这里的容器平台分别选择。开发与生产平台不同、且使用同一镜像标签时，还需处理生产基础镜像冲突，详见 [README 的平台说明](../README.md#项目发现与配置)。

### `compose`：现有服务与文件

| 字段 | 类型 | 默认值 | 作用与注意事项 |
| --- | --- | --- | --- |
| `compose.files` | 字符串数组 | `[]` | 按数组顺序加载、合并的 Compose 文件。`init` 会尝试发现并写入路径；配置中的空列表表示不加载 Compose，不会在后续打包时重新发现文件。 |
| `compose.profiles` | 字符串数组 | `[]` | 启用的 Compose profiles，需要 Compose v2。 |
| `compose.include_services` | 字符串数组 | `[]` | `dev start/stop` 显式纳入的配套服务。通常填写数据库、缓存等，不填写被开发容器替代的原应用服务。它不是打包白名单，也不控制生产包包含哪些服务。 |
| `compose.exclude_services` | 字符串数组 | `[]` | 开发与生产打包排除的服务。与 `include_services` 不得重叠；还应同步调整 Compose 中对被排除服务的依赖。 |

开发打包收集除 `application.service` 和排除列表之外的配套服务镜像；生产打包纳入未排除的服务。因此，只填写 `include_services: [db]` 不会自动排除 Compose 中其他服务。

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
  include_services: [db, redis]
  exclude_services: [adminer]
```

保留已有的 `application.dev_command` 等其他字段。上例要求两个 Compose 文件都存在，并已处理对 `adminer` 的服务依赖。dockpack 会生成应用开发容器，配套服务按 Compose 的配置启动。

## 修改后什么时候生效？

| 修改内容 | 后续操作 |
| --- | --- |
| 开发命令、开发端口 | 停止开发服务后重新 `dev start`，同时确认程序监听地址和端口。 |
| 开发平台、运行时版本、依赖文件 | 联网端重新 `pack dev`，传输新配置、源码和依赖文件，再在离线端 `dev init --bundle ...`。仅修改离线端配置不会转换包内镜像或补全依赖。 |
| 开发运行时列表、Compose 服务及镜像 | 重新打包并初始化，确保新容器所需的镜像和依赖已随包交付。 |
| 生产启动命令、生产端口、生产构建配置 | 按该字段的适用场景重新 `build prod`，再传输和部署新的生产包。 |
| `dependencies.*_files` 检测记录 | 当前不改变实际依赖收集行为，不能用来指定新的依赖文件。 |

检查包的实际平台请使用 `dockpack pack inspect <离线包>`。若配置写的是 AMD64 而清单仍为 ARM64，应确认打包工具版本、项目路径，并重新生成、传输正确的包。
