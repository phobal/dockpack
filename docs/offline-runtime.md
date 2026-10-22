# CLI 离线运行包

首次搭建请先按 [README](../README.md) 完成联网准备和离线初始化。本页说明如何为其他操作系统选择 CLI 运行包，以及维护者如何构建这些运行包。

## 选择运行包

在联网机器上从 [GitHub Releases](https://github.com/phobal/dockpack/releases) 的 Assets 下载对应文件及同名 `.sha256` 校验文件，传入离线环境。

| 运行 dockpack 的主机 | 文件名 |
| --- | --- |
| Linux x64 | `dockpack-cli-<版本>-linux-x64.tar.gz` |
| Linux ARM64/aarch64 | `dockpack-cli-<版本>-linux-arm64.tar.gz` |
| Windows x64 | `dockpack-cli-<版本>-win32-x64.zip` |
| macOS Intel | `dockpack-cli-<版本>-darwin-x64.tar.gz` |
| macOS Apple Silicon | `dockpack-cli-<版本>-darwin-arm64.tar.gz` |

这里选择的是 **CLI 主机平台**。`.dockpack.yaml` 的 `target.dev_platform` 选择的是 **项目容器平台**，两者分别设置。例如在 Apple Silicon Mac 操作 Linux 容器，CLI 运行包用 `darwin-arm64`；向 x64 Linux 服务器交付时，开发包目标仍是 `linux/amd64`，服务器上的 CLI 运行包则用 `linux-x64`。

同一版本有五个独立下载附件，npm 包只发布一次。建议联网与离线机器使用相同版本的 CLI。项目归档按 `schema_version` 判断格式兼容性，不要求其 `dockpack_version` 与 CLI 版本完全相等；不支持的格式会明确报错。

## Linux / macOS

以下以 `0.5.0`、macOS Apple Silicon 为例，替换为实际下载文件：

```sh
shasum -a 256 -c dockpack-cli-0.5.0-darwin-arm64.tar.gz.sha256
tar -xzf dockpack-cli-0.5.0-darwin-arm64.tar.gz
export PATH="$PWD/dockpack-cli-0.5.0-darwin-arm64:$PATH"
dockpack --version
```

Linux 可使用 `sha256sum -c` 校验。将整个解压目录加入 PATH，或者用启动文件的完整路径执行命令。保留完整运行包目录，不能只复制启动文件。

## Windows PowerShell

以下以 `0.5.0` 为例：

```powershell
Get-Content .\dockpack-cli-0.5.0-win32-x64.zip.sha256
Get-FileHash .\dockpack-cli-0.5.0-win32-x64.zip -Algorithm SHA256
# 确认两处 SHA-256 相同后再解压
Expand-Archive .\dockpack-cli-0.5.0-win32-x64.zip -DestinationPath .\tools
.\tools\dockpack-cli-0.5.0-win32-x64\dockpack.cmd --version
.\tools\dockpack-cli-0.5.0-win32-x64\dockpack.cmd dev init .\my-project
.\tools\dockpack-cli-0.5.0-win32-x64\dockpack.cmd dev start .\my-project
```

也可以将解压后的运行包目录加入 PATH，之后在项目目录执行 `dockpack`。Docker 必须运行在 Linux 容器模式，并能运行项目所需平台的容器。

## 系统要求

运行包自带 Node.js，启动时不访问 npm。Docker CLI、daemon 和 Compose 需要提前安装。

当前构建固定使用 Node.js 24.22.0，对应[官方系统要求](https://github.com/nodejs/node/blob/v24.22.0/BUILDING.md#platform-list)：

- Linux x64/arm64：内核 >= 4.18、glibc >= 2.28，不适用于 Alpine/musl。
- Windows x64：Windows 10 / Server 2016 或以上。
- macOS：13.5 或以上。

macOS 包目前没有额外的应用签名或公证，需按企业可执行文件分发策略部署。生产卷备份和恢复仅支持本地 Linux Docker 主机。ARM64 CLI 运行包不代表支持 ARM64 生产包；生产包目前仅支持 `linux/amd64`。

## 维护者：从源码构建

普通用户无需执行本节，直接下载安装包即可。在 dockpack 仓库根目录执行：

```sh
npm ci
npm run build
node dist/cli.js --help
npm run build:offline
# 只生成一个主机平台
npm run build:offline -- --target linux-arm64
# 指定产物目录
npm run build:offline -- --target linux-x64 --output ./release
```

离线构建会捆绑 CLI 与生产依赖，并下载固定版本的官方 Node.js 归档。版本、下载来源和五个平台的 SHA-256 固定在 `scripts/offline-runtime.json`；复用下载缓存时也会校验哈希。更新运行时需同步更新版本、文件名和校验值，官方清单位于 `https://nodejs.org/dist/v<版本>/SHASUMS256.txt`。

默认产物位于 `release/`，每个平台生成一个压缩包和一个 `.sha256` 文件。运行包包含启动器、`runtime/`、`app/`、许可证、`runtime.json` 和 `checksums.sha256`。`.offline-cache/` 是下载缓存，`.offline-build/` 是临时构建目录，这些目录及 `release/` 均不进入 Git 或 npm 发布包。

## 维护者：通过 Actions 发布下载附件

工作流 **Build offline runtime packages** 支持手动执行和推送 `v<版本>` 标签。标签必须与 `package.json` 一致，例如版本 `0.5.0` 对应 `v0.5.0`。

五个平台全部构建成功后，标签运行会创建或复用对应 GitHub Release，上传五个压缩包及五个校验文件到 Assets。重跑会替换同名附件；带预发布版本号的标签会创建为预发布版本。发布使用内置 `GITHUB_TOKEN` 的 `contents: write` 权限。

从分支手动运行时只保存 Actions Artifacts；从标签手动运行时也会发布 Release Assets。此工作流不发布 npm 包。
