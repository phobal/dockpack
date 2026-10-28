# 命令参考

首次使用请按 [README](../README.md) 的联网准备与离线操作步骤执行。

## 项目与开发环境

| 命令 | 作用 |
| --- | --- |
| `dockpack init [project-directory]` | 检测项目，新建带注释的 `.dockpack.yaml`；已有配置保留 |
| `dockpack download [-p <platforms...>]` | 联网下载当前 CLI 版本的离线运行包到当前目录的 `.dockpack/`，未传平台时交互多选 |
| `dockpack pack dev [project-directory] [-o <archive>] [--pull <policy>] [--refresh-dependencies]` | 联网收集镜像与依赖，默认输出到项目 `.dockpack/offline-dev-<平台>.tar.gz` |
| `dockpack pack inspect <archive>` | 校验离线包并显示类型、平台、镜像等清单信息 |
| `dockpack dev init [project-directory] [--bundle <archive>]` | 离线导入开发包、安装依赖并初始化本机状态；默认查找项目内对应平台的包 |
| `dockpack dev start [project-directory]` | 前台启动开发服务，显示日志 |
| `dockpack dev stop [project-directory]` | 停止开发服务及纳入运行的 Compose 服务 |
| `dockpack dev rebuild [project-directory]` | 使用已导入的缓存建立新依赖卷，不启动服务 |
| `dockpack dev exec [project-directory] -- <command...>` | 在第一个配置的开发运行时容器中执行命令，该容器须已启动 |
| `dockpack import <archive>` | 通用的校验与镜像导入命令，不安装开发依赖，不替代 `dev init` |

`project-directory` 默认取当前命令执行目录，不会向上查找项目。默认包名将平台中的 `/` 替换为 `-`，例如 `linux/amd64` 对应 `offline-dev-linux-amd64.tar.gz`；`auto` 使用当前 Docker daemon 的实际平台。

显式传入的 `-o` / `--bundle` 相对路径按命令执行目录解析；默认包路径则位于所选项目的 `.dockpack/` 内。

执行开发容器命令时建议明确用 `.` 表示当前项目，避免项目位置参数与命令混淆，例如 `dockpack dev exec . -- npm run lint`。

全参数形式示例：

```sh
dockpack pack dev ./my-project -o ./custom-dev.tar.gz
dockpack dev init ./my-project --bundle ./custom-dev.tar.gz
dockpack dev start ./my-project
```

下载离线 CLI 时，选择的是运行 dockpack 的主机平台：

```sh
dockpack download                                     # 空格多选平台，回车下载
dockpack download -p linux/amd64                       # 单个平台
dockpack download -p linux/amd64 linux/arm64            # 多个平台
dockpack download -p linux/amd64 -p windows/amd64       # 可重复使用 -p
```

支持 `linux/amd64`、`linux/arm64`、`windows/amd64`、`darwin/amd64`、`darwin/arm64`，也接受发布文件的平台名（如 `linux-x64`、`win32-x64`）和逗号分隔的平台列表。命令从 GitHub Releases 下载与当前 CLI 相同版本的压缩包，并打印保存目录的绝对路径。非交互环境必须通过 `-p` 指定平台。详细安装方法见[CLI 离线运行包](./offline-runtime.md)。

## 生产环境

| 命令 | 作用 |
| --- | --- |
| `dockpack build prod [project-directory] -o <archive>` | 离线构建生产包；输出路径必填 |
| `dockpack prod inspect <archive>` | 校验并查看生产包清单 |
| `dockpack deploy import <archive>` | 导入生产包 |
| `dockpack deploy up <archive>` | 启动生产服务 |
| `dockpack deploy down <archive>` | 停止生产服务，保留命名卷 |
| `dockpack deploy status <archive>` | 查看生产服务状态 |
| `dockpack deploy logs <archive> [service]` | 查看全部或指定服务日志 |
| `dockpack deploy backup <archive> [-o <backup>]` | 备份内部命名卷 |
| `dockpack deploy restore <archive> --backup <backup> [--overwrite]` | 恢复备份；覆盖非空卷时需显式确认 |

具体前提和限制见[生产部署指南](./production.md)。`-o` 是 `--output` 的简写。可通过 `dockpack --help` 或 `dockpack <子命令> --help` 查看帮助。

## 文件存放位置

| 文件 / 目录 | 用途 |
| --- | --- |
| `<项目>/.dockpack.yaml` | 用户编辑的项目配置 |
| `<项目>/.dockpack/offline-dev-<平台>.tar.gz` | 默认开发离线包 |
| `<当前目录>/.dockpack/dockpack-cli-<版本>-<主机平台>.*` | `download` 下载的 CLI 离线运行包 |
| `<项目>/.dockpack/state.json` | 本机开发状态，在目标机器通过 `dev init` 建立 |
| `<项目>/.dockpack/compose.dev.yaml` | 工具生成的开发 Compose overlay，命令执行时会重写，不用于手动持久配置 |
| `<项目>/.dockpack/compose.install.yaml` | 安装依赖时临时挂载只读缓存，结束后删除 |
| `$XDG_CACHE_HOME/dockpack/bundles/` | 导入后的开发包缓存；未设置时使用 `~/.cache/dockpack/bundles/` |
| `$XDG_DATA_HOME/dockpack/deployments/` | 生产部署目录；未设置时使用 `~/.local/share/dockpack/deployments/` |

归档为带清单和 SHA-256 校验和的 gzip tar 包，导入和检查时会验证内容。生成的开发 overlay 使用 `DOCKPACK_PROJECT_DIR` 挂载源码，调用 Compose 时由工具设置该变量；开发状态和 overlay 不记录源机器上的绝对项目或缓存路径。

使用同一个有 Docker 权限的账号完成初始化和后续开发，避免不同账号访问到不同的导入缓存。

### 镜像拉取策略

`pack dev` 默认使用 `--pull missing`：本地存在目标架构镜像时直接复用，仅在缺失或架构不匹配时拉取。

```bash
dockpack pack dev                       # 默认复用本地镜像
dockpack pack dev --pull always         # 强制检查并拉取远程更新
dockpack pack dev --pull never          # 仅使用本地镜像，缺失或架构不匹配时报错
```

策略适用于运行时镜像、Compose 配套服务镜像、Dockerfile 生产基础镜像和前端原生构建资源镜像。同一次打包按镜像引用与架构去重；若镜像标签被其他架构替换，会重新检查。默认策略也会复用本地 `latest`，需要更新时显式使用 `always`。不同标签或别名仍按不同引用处理。

`never` 仅限制上述镜像收集，不代表整个打包过程断网：依赖下载和 Compose 构建仍可能访问网络。修改目标平台后须准备匹配架构的镜像。

### 重复打包的依赖缓存

`pack dev` 将成功收集的 npm 缓存、Python wheel 和 uv 导出的固定依赖保留在项目 `.dockpack/cache/dependencies/`。再次打包时，依赖输入、目标平台、运行时镜像引用及镜像 ID、CLI 版本均一致，且缓存文件完整性校验通过，就直接将已验证资源复制到新包，跳过下载和重复安装验证。前端原生构建资源也使用同一机制。

npm 的缓存键包含 `package.json`、`package-lock.json` 和可选 `.npmrc`；uv 包含 `pyproject.toml`、`uv.lock` 和可选 `uv.toml`。普通 pip requirements 会跟踪 `-r` / `-c` 引用文件；本地依赖、动态环境变量及无法可靠跟踪的选项继续重新收集。首次缓存仍运行原有收集及验证流程，失败不会发布新缓存。缓存损坏会自动重新收集。

```bash
dockpack pack dev                         # 自动复用符合条件的依赖缓存
dockpack pack dev --refresh-dependencies  # 强制重新收集并更新缓存
```

依赖声明或架构变化后会生成新的缓存条目。镜像拉取策略 `--pull` 与依赖刷新分别控制；`--pull always` 只有在镜像 ID 改变时才使依赖缓存失效。普通 requirements 若未固定版本，重复打包也会复用上次解析结果，需要检查上游更新时使用 `--refresh-dependencies`。变更仓库环境或包管理器的外部配置后也应显式刷新。

删除 `.dockpack/cache/dependencies/` 可释放缓存空间，下次打包会重新收集。该缓存只用于联网准备，不替代交付给离线机器的完整开发资源包。不同依赖输入的条目暂不共享增量下载缓存。
