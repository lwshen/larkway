# 在 Docker 中运行 Larkway

用仓库根目录的 `docker-compose.yml` 把 bridge 跑在容器里,默认使用 CI 推送到 GHCR 的预构建镜像
`ghcr.io/lwshen/larkway:latest`,不在本地编译(本地测试 `Dockerfile` 见下文)。容器同时就是
agent 的工作环境:agent 在容器内读写代码、跑命令、开 MR,对宿主机只能看到挂载进来的目录。

镜像内容:Node 24、bridge(`dist/main.js`)、`larkway` CLI、`claude`、`codex`、`lark-cli`、
`paseo`、`glab`、`git`、`ripgrep`、`vim`(含 `vi`)、`nano`、JDK 21(Eclipse Temurin,`JAVA_HOME=/opt/java/openjdk`);以非 root 用户 `node` 运行,`LARKWAY_HOME=/home/node/.larkway`。

## 快速开始

在仓库根目录执行:

```bash
docker compose pull   # 拉取 GHCR 镜像(约 2 GB)

# 1. 登录 agent 后端(一次即可,登录态存进 volume)
docker compose run --rm larkway claude                      # 进入后 /login,完成后退出
# 或 Codex(设备码流程;普通 `codex login` 的 localhost 回调在容器外打不开)
docker compose run --rm larkway codex login --device-auth

# 2. 配置第一个 bot(终端扫码)
docker compose run --rm larkway larkway init --backend=claude   # 用 Codex 时去掉 --backend
#    注意:必须写成 --backend=claude;`--backend claude`(空格)不生效。
#    init 默认 backend 是 codex,未登录 codex 时前置自检会直接失败。

# 3. 体检,然后后台启动
docker compose run --rm larkway larkway doctor
docker compose up -d
docker compose logs -f
```

最后在飞书群设置 → 机器人 → 添加你的 bot,@ 它即可。

## 镜像来源

### GHCR 预构建镜像(默认)

`.github/workflows/docker.yml` 构建 `linux/amd64` + `linux/arm64` 镜像并推送到 `ghcr.io/lwshen/larkway`:

| 触发            | 推送的 tag                               |
| --------------- | ---------------------------------------- |
| push 到 `main`  | `latest`、`sha-<短 sha>`                 |
| push `v*` tag   | `1.2.3`、`1.2`、`sha-<短 sha>`           |
| PR 到 `main`    | 只构建两个平台,不推送                    |
| 手动 (dispatch) | `sha-<短 sha>`;在 `main` 上另加 `latest` |

`latest` 指 `main` 的最新构建,不是正式发布版。要固定版本,把 compose 里的 tag 换成 `sha-<短 sha>`
(或用下面的 `LARKWAY_IMAGE` 覆盖)。该 package 公开,`docker pull` 无需登录。

### 本地构建(测试 Dockerfile 或未合并的改动)

compose 文件里**没有** `build:`,它永远不会自己编译。本地测试时用 `docker build` 打一个本地 tag,
再用 `LARKWAY_IMAGE` 让同一个 compose 文件改用它:

```bash
docker build -t larkway:local .
export LARKWAY_IMAGE=larkway:local
docker compose up -d            # 其余 run / logs 等命令照常
# 改代码后:重新 docker build,再 docker compose up -d(镜像变了会自动重建容器)

unset LARKWAY_IMAGE             # 切回 GHCR 镜像
docker compose up -d
```

`LARKWAY_IMAGE` 只对设置它的 shell 生效;想长期使用,可写进 compose 同目录的 `.env`(已在 `.gitignore`)。
本地模式下不要执行 `docker compose pull`:它会去 Docker Hub 找 `larkway:local` 并报错。

不把 `build:` 放进同一个 compose 文件,原因有两个:一是 GHCR 拉取失败时 compose 会悄悄改为本地编译;
二是 `docker compose build` 会把本地产物标成 `ghcr.io/...:latest`,让人误以为在跑官方镜像。

## 与在宿主机上运行的差异

| 项            | 容器里的做法                                                                                          | 原因                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 启动方式      | 不用 `larkway start`;容器主进程就是前台的 `node dist/main.js`,由 `restart: on-failure` 负责重启       | Linux 上 `larkway start` 走 systemd,容器里没有                                                                             |
| 重启策略      | `on-failure`,不要用 `always` / `unless-stopped`                                                       | 没有 bot 或配置不完整时 bridge 会**有意**以 exit 0 退出,`always` 会导致反复重启                                            |
| Web 管理界面  | 不可用,用 CLI(`larkway init` / `bot edit` / `doctor`)                                                 | Web UI 固定绑定 `127.0.0.1`,端口映射到不了                                                                                 |
| Claude 登录态 | 在容器里 `/login` 一次;或用 `claude setup-token` 生成的长期 token 通过 `CLAUDE_CODE_OAUTH_TOKEN` 传入 | macOS 上 Claude 凭据在 Keychain 里,挂载 `~/.claude` 带不过来                                                               |
| Codex 登录态  | 在容器里 `codex login --device-auth`                                                                  | 不建议拷贝宿主机 `auth.json`:两份 refresh token 轮换时会互相踢下线                                                         |
| 运行用户      | 非 root(`node`)                                                                                       | Claude Code 拒绝以 root 使用 `bypassPermissions`(Larkway 默认模式)                                                         |
| lark-cli      | 无需单独登录                                                                                          | bridge 每次启动按 bot yaml 的 `app_id` + `.env` 里的 secret 重建该 bot 的 lark-cli profile(`src/lark/profileBootstrap.ts`) |
| 网络          | 不需要暴露端口                                                                                        | 飞书事件走出站 WebSocket 长连接                                                                                            |

使用 `CLAUDE_CODE_OAUTH_TOKEN` 时,Claude runner 会原样透传它,但 Larkway 的启动就绪探测和
`doctor` 不识别这种方式,会报 Claude 未登录 / `BACKEND NOT READY`。该探测只做诊断,不阻止启动。

## 持久化

compose 把整个 `/home/node` 挂到名为 `larkway-home` 的 volume(名字固定,与 compose 项目目录无关),
其中包括:`~/.larkway`(bot yaml、`.env`、session、workspace、日志)、`~/.claude` + `~/.claude.json`、
`~/.codex`、`~/.config/glab-cli`、`~/.gitconfig`、`~/.ssh`,以及 Java 构建缓存 `~/.m2`、`~/.gradle`
(可能很大,备份时可以排除)。删除这个 volume 等于重置全部配置和登录态。

## 连接 Paseo

镜像自带 `paseo` CLI,agent 可以用它操作别处的 Paseo daemon(例如你自己电脑上的),经 Paseo relay
连接,端到端加密,daemon 不必暴露端口:

1. 在 daemon 所在机器上运行 `paseo daemon pair --relay`(或 Paseo Desktop:Settings → host →
   Pair a device → Enable relay),拿到配对链接 `https://app.paseo.sh/#offer=…`。
2. 写进容器内的 `~/.larkway/.env`,**必须加双引号**(dotenv 把未加引号值里的 `#` 当注释,链接会被截断):
   `PASEO_HOST="https://app.paseo.sh/#offer=…"`。bridge 启动时加载这个文件,codex / claude 子进程继承它。
3. `docker compose restart larkway`,并在 bot workspace 的 `AGENTS.md` 里告诉 agent 可以用 `paseo` CLI。

配对链接等同密码:拿到它就能连上那个 daemon、在那台机器上启动 agent。放进容器后,能在飞书里 @ 这个
bot 的人都能间接用到它——建议给 daemon 设密码,并把 bot 限定在指定群。只有 bridge 进程会加载
`~/.larkway/.env`,`docker compose exec larkway paseo …` 手动测试时要自己带上 `PASEO_HOST`。

## bot_open_id

`larkway init` 会问「Bot 的 Feishu open_id」。可以先回车保留 `ou_placeholder`,但长期使用要填真实值:
断线重连后的群消息补抓、追问合并、多 bot 互相 @ 交接都依赖它。open_id 按应用区分,必须用**这个 bot
自己的应用凭据**查询。init 扫码后 App Secret 已写入 `.env`、App ID 已打印在屏幕上,另开一个终端即可查:

```bash
docker compose run --rm larkway node /app/scripts/get-bot-open-id.cjs <APP_ID> [SECRET_ENV_NAME]
```

输出的 `bot_open_id: ou_...` 粘回 init;或事后写入:

```bash
docker compose run --rm larkway larkway bot edit <bot-id> --set bot_open_id=ou_xxx
docker compose restart
```

## Git / GitLab

agent 在容器里 clone 和提交,容器默认没有任何 Git 凭据:

- **glab**:`docker compose run --rm larkway glab auth login`(自建 GitLab 加 `--hostname gitlab.example.com`)。
- **HTTPS token**:写进 `~/.larkway/.env`,在 bot yaml 用 `git_token_env: <变量名>` 引用。配了 repo
  指针但没配 token 时,bridge 启动会警告并回退到"宿主 Git 认证",在容器里即为无认证。
- **SSH**:把 key 和 `known_hosts` 放进 volume 的 `/home/node/.ssh`(权限 600)。
- **提交身份**:`docker compose run --rm larkway git config --global user.name "..."`(email 同理),
  或 `larkway init --advanced` 里配置。

repo 指针只是提示 agent 去哪里找代码,不会被预先 clone,也不构成权限边界
(见 [agent-workspace.md](agent-workspace.md))。

## 切换 App ID / App Secret

`app_id`、`app_secret_env`(secret 的变量名)、`bot_open_id` 在 `~/.larkway/bots/<bot-id>.yaml`;
secret 真值在 `~/.larkway/.env`。三者要一起换(open_id 随应用变化)。

**换成新扫码创建的应用**:重跑 `larkway init`,Bot ID 填原来的。遇到「Bot 已存在,覆盖?」**必须选 Y**——
扫码那一步已经把新 secret 覆盖进 `.env` 的同名变量,选 N 会导致 yaml 里的旧 App ID 与新 secret 不匹配。

**换成已有应用**:

```bash
# 1. 新 secret 写到新变量名下(输入不回显、不进 shell 历史;旧变量留作回滚)
docker compose run --rm larkway sh -c 'printf "App Secret: "; stty -echo; read -r s; stty echo; echo; printf "LARKWAY_<BOT_ID>_APP_SECRET_2=%s\n" "$s" >> ~/.larkway/.env'
# 2. 查新应用的 bot_open_id
docker compose run --rm larkway node /app/scripts/get-bot-open-id.cjs cli_new LARKWAY_<BOT_ID>_APP_SECRET_2
# 3. 一次改三项
docker compose run --rm larkway larkway bot edit <bot-id> \
  --set app_id=cli_new --set app_secret_env=LARKWAY_<BOT_ID>_APP_SECRET_2 --set bot_open_id=ou_new
# 4. 体检并重启
docker compose run --rm larkway larkway doctor
docker compose restart
```

换应用等于换了一个飞书机器人:要把新机器人拉进群、旧的移出。手动创建的应用需自己在开发者后台开启机器人
能力、事件订阅选「长连接」并订阅接收消息事件;`larkway doctor` 会检查长连接可达性与权限范围。

## 升级

```bash
git pull              # 更新 compose 文件本身
docker compose pull
docker compose up -d
```

本地构建模式下改为 `git pull && docker build --pull -t larkway:local . && docker compose up -d`。

`claude` / `codex` / `lark-cli` / `paseo` 的版本取决于镜像构建时间(GHCR 镜像即 `main` 最近一次 CI 构建)。不要在容器里用
`larkway update`:它走 `npm i -g` + `larkway stop/start`,前者以非 root 用户写不了全局目录,后者依赖 systemd。

## 已知限制

- **Dev 预览链接不可达**:bridge 自动探测的 `devHostname` 是容器 IP(如 `172.17.0.2`),预览端口段
  3001–3050 未映射。需要预览时,在 compose 里映射这些端口,并在 `~/.larkway/config.json` 把
  `devHostname` 设为宿主机可访问的地址。
- **lark-cli 凭据存储未在真实应用上验证**:容器里没有系统 keyring,lark-cli 能否正常持久化 profile
  只在无凭据环境下验证过启动路径。
- **镜像约 2.9 GB**:主要是 `claude` / `codex` 的原生二进制、`paseo`(连同它依赖的 daemon 包约 580 MB)和 JDK(约 300 MB)。Docker Desktop 默认磁盘上限较小时可能需要调大。
- **CLI 版本不固定**:除 `glab` 固定版本外,其余 agent CLI 每次 build 取最新版。`main` 没有新提交时
  GHCR 镜像不会重建,里面的 CLI 会逐渐落后;需要时在 Actions 页手动触发 Docker workflow。
- **工具链需自行补充**:除 Node 24 和 JDK 21 外,agent 要构建 / 测试的项目所需的其他语言运行时(Python、Go…)
  需要在 Dockerfile 里自行添加。
- **Java 构建工具**:镜像不带 Maven / Gradle,用项目自带的 `./mvnw` / `./gradlew`。不要 `apt install maven`:
  它会连带安装 Debian 的 OpenJDK 17。需要渲染字体的项目(Apache POI 自动列宽、PDF 生成等)还要装 `fontconfig`
  和字体包。
- **没有 Web UI**:见上表。
