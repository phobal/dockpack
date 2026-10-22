import { constants } from "node:fs";
import { access, open, readFile } from "node:fs/promises";
import path from "node:path";
import { Document, isNode, parse } from "yaml";
import { validateConfig, type DockpackConfig } from "./schema.js";
import { DockpackError } from "../errors.js";

export const CONFIG_FILE = ".dockpack.yaml";

const CONFIG_COMMENTS: Record<string, string> = {
  schema_version: "配置格式版本，当前固定为 1。",
  project: "项目标识与开发容器类型。",
  "project.name": "项目名称，用于离线包清单及生成的镜像名称。",
  "project.ecosystems": "开发运行时：node、python，可同时填写；应与实际项目一致。",
  application: "命令按参数拆成数组，例如 [npm, run, dev]；不会自动经过 shell。",
  "application.service": "原 Compose 中的应用服务名；开发打包会用 dockpack 开发容器替代此服务。无 Compose 时保留 app。",
  "application.command": "生产启动命令；自动生成生产镜像时使用，不覆盖已有 Compose/Dockerfile 的命令。",
  "application.build_command": "生产构建前执行的命令；仅特定已有 Dockerfile 的生产流程使用，详见配置参考。",
  "application.port": "自动生成生产服务时映射同号主机/容器端口；null 表示不映射，不会修改程序监听地址。",
  "application.dev_command": "开发启动命令。Web 服务须监听 0.0.0.0；空数组会尝试推断，无法推断时保持容器运行。",
  "application.dev_port": "开发容器与主机映射同号端口；须与程序监听端口一致，null 表示不显式映射。",
  target: "这里设置 Docker 容器架构，不是 CLI 离线运行包的主机平台。",
  "target.dev_platform": "auto 跟随打包机器的 Docker daemon。向 x64 Linux 交付时在联网打包前改为 linux/amd64；也支持 linux/arm64。修改后须重新打包。",
  "target.production_platform": "生产包当前仅支持 linux/amd64。",
  compose: "没有 Compose 时保留空列表；服务名必须与 Compose 文件一致。",
  "compose.files": "相对于项目根目录的 Compose 文件，按顺序合并；空列表表示不加载 Compose，不会重新自动发现。",
  "compose.profiles": "启用的 Compose profiles，需要 Docker Compose v2。",
  "compose.dev_networks": "开发容器加入的 Compose 网络配置键；从配套服务检测生成，可手动调整。空列表使用默认网络，不要填写 Docker 实际网络名。",
  "compose.include_services": "dev start/stop 纳入的配套服务，例如 [db, redis]；不是打包白名单，不要填原应用服务。",
  "compose.exclude_services": "开发/生产打包排除的服务；与 include_services 不可重叠。",
  dependencies: "依赖检测记录。当前不能通过以下文件列表自定义依赖收集路径。",
  "dependencies.policy": "当前仅支持 locked，不支持其他策略。",
  "dependencies.python_files": "检测记录；实际收集根目录 requirements.txt，缺少时使用 requirements-dev.txt，不合并二者。",
  "dependencies.node_files": "检测记录；实际收集根目录 package.json 与 package-lock.json，当前仅支持 npm。",
};

function configWithComments(config: DockpackConfig): string {
  const document = new Document(config);
  document.commentBefore = " dockpack 项目配置。先检查 target.dev_platform、application.dev_command 和 dev_port。\n 重新执行 dockpack init 会保留已有文件，不会覆盖您的修改。\n 完整字段说明：https://github.com/phobal/dockpack/blob/main/docs/configuration.md";
  for (const [key, comment] of Object.entries(CONFIG_COMMENTS)) {
    const node = document.getIn(key.split("."), true);
    if (isNode(node)) node.commentBefore = ` ${comment}`;
  }
  return document.toString();
}

export async function readConfig(filePath: string): Promise<DockpackConfig> {
  try {
    const text = await readFile(filePath, "utf8");
    return validateConfig(parse(text));
  } catch (error) {
    if (error instanceof DockpackError) throw error;
    throw new DockpackError(`Cannot read or validate ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function createConfigOnce(projectDir: string, config: DockpackConfig): Promise<boolean> {
  const filePath = path.join(projectDir, CONFIG_FILE);
  const content = configWithComments(config);
  try {
    const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new DockpackError(`Cannot create ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function configExists(projectDir: string): Promise<boolean> {
  try {
    await access(path.join(projectDir, CONFIG_FILE));
    return true;
  } catch {
    return false;
  }
}
