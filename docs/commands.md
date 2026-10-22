# 命令参考

首次使用请按 [README](../README.md) 的联网准备与离线操作步骤执行。

## 项目与开发环境

| 命令 | 作用 |
| --- | --- |
| `dockpack init [project-directory]` | 检测项目，新建带注释的 `.dockpack.yaml`；已有配置保留 |
| `dockpack pack dev [project-directory] [-o <archive>]` | 联网收集镜像与依赖，默认输出到项目 `.dockpack/offline-dev-<平台>.tar.gz` |
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
| `<项目>/.dockpack/state.json` | 本机开发状态，在目标机器通过 `dev init` 建立 |
| `<项目>/.dockpack/compose.dev.yaml` | 工具生成的开发 Compose overlay，命令执行时会重写，不用于手动持久配置 |
| `<项目>/.dockpack/compose.install.yaml` | 安装依赖时临时挂载只读缓存，结束后删除 |
| `$XDG_CACHE_HOME/dockpack/bundles/` | 导入后的开发包缓存；未设置时使用 `~/.cache/dockpack/bundles/` |
| `$XDG_DATA_HOME/dockpack/deployments/` | 生产部署目录；未设置时使用 `~/.local/share/dockpack/deployments/` |

归档为带清单和 SHA-256 校验和的 gzip tar 包，导入和检查时会验证内容。生成的开发 overlay 使用 `DOCKPACK_PROJECT_DIR` 挂载源码，调用 Compose 时由工具设置该变量；开发状态和 overlay 不记录源机器上的绝对项目或缓存路径。

使用同一个有 Docker 权限的账号完成初始化和后续开发，避免不同账号访问到不同的导入缓存。
