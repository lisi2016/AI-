# 课时签到后端 · 安全加固运行手册

适用对象：`8.138.41.74` 上的 `attendance` 服务（源码 = `课时签到微信小程序/backend`，Nginx 80 → `127.0.0.1:8081`）。
本手册里的命令**都在服务器上以 root 执行**，除非明确写了「在本地」。

> **我无法代你执行**：本机（Windows 开发机）`C:\Users\Lenovo\.ssh` 里只有 `known_hosts`，没有私钥，无法免密登录 `8.138.41.74`。所以下面给的是「你自己复制粘贴」的命令，每一步都有自检和回滚。

---

## 一、先看现状（2026-10-11 实测）

对线上 `http://8.138.41.74` 跑只读探针 `tools/verify-hardening.js` 的结果（**未做任何写操作**）：

| 检查项 | 线上实测 | 判定 |
|---|---|---|
| `GET /api/v1/health` | HTTP 200，服务 `kcsq-backend` v0.1.0，已运行 10.1 天 | ✅ 正常 |
| 开发模式 | `devMode: true`（unit 里 `Environment=DEV_MODE=1`） | ❌ **开发模式对外网开放** |
| 默认密钥伪造令牌 | HTTP 401 被拒 | ✅ `TOKEN_SECRET` 已不是仓库默认值 |
| 后台账号 `ADMIN001` 口令 | `123456` 仍可登录 | ❌ **弱口令** |
| 后台账号 `2017001` 口令 | `123456` 仍可登录 | ❌ **弱口令** |
| `GET /admin/` | HTTP 200（公网可直接打开登录页） | ⚠️ 唯一防线就是口令强度 |
| 健康检查字段 | 回显 `dataDir=/opt/apps/attendance/data` | ⚠️ 泄露服务器绝对路径（低危） |

**风险的两条独立入口，任一都足以冒用身份**：

1. `DEV_MODE=1` ⇒ `/auth/login` 接受任意 `code`（不必是微信真码）、`/auth/bind` **不需要 bindTicket**。而 `测试账号表.md` 里工号/姓名是公开的，任何人都能把手里的微信绑成某个教师/班干部身份。
2. `/admin/` 公网可达 + 口令 `123456` ⇒ 任何人可登录系部/教务处后台，查看并导出全部课时数据（CSV）。

另有一条**必须避免的新问题**：`DEV_MODE` 的代码默认值是 `true`（`src/util.js: boolEnv('DEV_MODE', true)`）。所以「把 `DEV_MODE=1` 那行删掉」不等于生产模式，**必须显式写 `DEV_MODE=0`**。

---

## 二、动手前：只有一个硬前提

### AppSecret（决定第 3 步能不能做）

切 `DEV_MODE=0` 后，`/auth/login` 会真的去调微信 `code2Session`（`src/auth.js`），此时：

- 没有 `WX_APPSECRET` ⇒ 所有小程序用户登录返回 `50002 服务端未配置 WX_APPID / WX_APPSECRET`，**整个小程序不可用**（我在本地演练实例上已复现该 502/50002）。
- AppSecret 只能从**微信公众平台 → 开发管理 → 开发设置**取（AppID 已知：`wx93424039f392ad42`）。如果当初不是自己注册的小程序，需要问学校小程序管理员；如果 AppSecret 丢失，可在平台上「重置」，重置后旧值立即失效。

脚本对此是**拒绝执行**策略：`prod` 阶段读不到合法 AppSecret 就直接退出，不会把线上打瘫；即使切过去后发现微信调不通，也会**自动回滚**到 `DEV_MODE=1`。

> 第 2 步（轮换密钥）和第 4 步（改后台口令）**不需要** AppSecret，可以现在就做。

### 把文件传上去

在本机（Windows PowerShell）：

```powershell
cd 'D:\教学工作\2026\月工作总结以及工作计划\deploy'
ssh root@8.138.41.74 'mkdir -p /root/kcsq-harden/tests'
scp harden-attendance.sh attendance.service rotate-web-passwords.sh root@8.138.41.74:/root/kcsq-harden/
scp tests\harden-logic-test.sh root@8.138.41.74:/root/kcsq-harden/tests/
```

> 用你的实际登录用户替换 `root`（若你用普通用户登录，后续命令加 `sudo`）。
> ⚠️ **这台开发机上没有到服务器的 SSH 私钥**（`C:\Users\Lenovo\.ssh` 里只有 `known_hosts`），所以上面这些命令、以及第三节所有服务器端操作，都只能**由你在能登录服务器的机器上执行**；我这边无法替你远程执行，也无法替你验证线上 unit 的实际内容。
> 传输后建议核对哈希，确认传上去的正是下面这份（本手册对应版本）：

| 文件 | 字节 | SHA256（前 16 位） |
|---|---|---|
| `harden-attendance.sh` | 19355 | `dac501b9aabfc8c3` |
| `attendance.service` | 708 | `0686f70c199ee0ef` |
| `rotate-web-passwords.sh` | 5278 | `f706f8216de0dee3` |
| `tests/harden-logic-test.sh` | 11959 | `e0bbf54a4836472f` |

服务器上校验：`cd /root/kcsq-harden && sha256sum harden-attendance.sh`

脚本只依赖 Linux 自带工具（`systemctl`/`curl`/`openssl`/`sed`/`install`/`grep`/`awk`），**不需要** `python3`、`jq`、`node`。
（可选）先在服务器上跑一次离线逻辑测试（用假 systemctl/curl，不会碰真实服务）：`bash tests/harden-logic-test.sh` → 期望 `48 通过 / 0 失败`。

---

## 三、按顺序执行

### 第 0 步：体检（只读，不改任何东西）

```bash
cd /root/kcsq-harden
sudo bash harden-attendance.sh status
```

会打印：服务是否 active、**进程真实生效的配置（密钥已脱敏）**、健康检查里的 `devMode`、环境文件权限与各项是否有值、下一步该做什么。

### 第 1 步：轮换密钥（不需要 AppSecret，可随时做）

```bash
sudo bash harden-attendance.sh seal
```

做四件事：① 把 unit 里可能内联的 `TOKEN_SECRET`/`CODE_SECRET`/`WX_*` **迁移**到 `/etc/attendance.env`（权限 600）；② 生成两个 32 字节随机密钥；③ **原地加固** unit（只删掉内联的密钥行、补上 `EnvironmentFile=/etc/attendance.env` 与 `NODE_ENV=production`；**保留**线上原有的 `ExecStart`/`WorkingDirectory`/`User`/`Group`/`PORT`，不做整份覆盖，避免把服务改到别的端口导致 Nginx 反代失效）；④ 重启并确认 `devMode` 仍为 `true`（**本步刻意不动 DEV_MODE**，不影响用户使用）。

副作用：此前签发的登录令牌全部失效 ⇒ 用户重进小程序会自动重新登录；已绑定的工号/学号、课时数据、审计哈希链都不受影响。

### 第 2 步：改掉后台弱口令（不需要 AppSecret）

```bash
sudo bash rotate-web-passwords.sh          # 交互式输入新口令（不回显、不进命令行历史）
```

- 默认改 `ADMIN001` 与 `2017001` 两个账号；走的是公开 API（后端没有命令行改密工具），旧口令默认 `123456`。
- 新口令要求 ≥12 位（脚本强制），不要用 `123456`、`admin123`、工号本身。
- 想一次改多个账号：`sudo ACCOUNTS=ADMIN001,2017001 bash rotate-web-passwords.sh`（`sudo VAR=值 命令` 是 sudo 允许的传参方式，变量名必须是 `ACCOUNTS`）。
- ⚠️ 后台连续 5 次密码错误会锁定该账号 15 分钟，脚本每个账号只试 1 次，请勿反复试错。
- 说明：**教师/班干部（如 `2010032`、`2017001` 之外的干部号）在小程序里靠微信身份 + 白名单绑定，没有口令**，所以「弱口令」只涉及 `/admin` 的 `dept_admin`/`admin` 两个账号。

### 第 3 步：切生产模式（**需要 AppSecret**）

```bash
# 3.1 写入 AppSecret（替换成真实值；等号后不要加引号和空格）
sudo sed -i 's|^WX_APPSECRET=.*|WX_APPSECRET=这里粘贴真实AppSecret|' /etc/attendance.env
sudo grep -c '^WX_APPSECRET=..*' /etc/attendance.env     # 期望输出 1

# 3.2 执行（脚本会自己校验 AppSecret 是否可用，不可用就回滚）
sudo bash harden-attendance.sh prod
```

`prod` 阶段的动作与保护：

1. 检查 `WX_APPID`/`WX_APPSECRET` 存在、格式正常、不是占位符 ⇒ 否则**直接拒跑**；
2. 备份当前 unit 与环境文件到 `/root/attendance-backup-<时间戳>/`；
3. 原地加固 unit（补上 `Environment=DEV_MODE=0` + `EnvironmentFile=/etc/attendance.env`，其余 `ExecStart`/`WorkingDirectory`/`User`/`PORT` 原样保留）并重启；
4. 轮询 15 秒确认健康检查变成 `devMode=false` ⇒ 没变就**自动回滚**成 `DEV_MODE=1`（含「重启后服务起不来」这一种：不会把线上停在 `DEV_MODE=0` 的失败状态）；
5. 用一次无效 `code` 调 `/auth/login` 反查微信接口：只有拿到微信的「code 无效 40029」才算配置正确；若报「未配置 / AppID 无效 40013 / AppSecret 无效 40125」⇒ **自动回滚**，并保持小程序可登录。

> `attendance.service` 里 **刻意写成 `EnvironmentFile=/etc/attendance.env`（不带 `-` 前缀）**：万一环境文件被删，服务会**启动失败**而不是悄悄退回代码里的公开默认密钥。这台机器上 `/etc/attendance.env` 是必需文件，别删。
>
> 探测微信时脚本**故意不加 `curl -f`**：这个后端把「微信配置错误」映射成 HTTP 502（`errors.js` 里 `50002 → 502`），加了 `-f` 会把响应体（里面才有微信的 `40029`/`40013`/`40125`）丢掉，导致配置正确也被误判成失败而回滚。

---

## 四、验收（在**本机**执行，只读探针）

```powershell
cd 'D:\教学工作\2026\月工作总结以及工作计划\课时签到微信小程序'
node tools\verify-hardening.js --base http://8.138.41.74
```

期望输出（全部 PASS，退出码 0）：

```
[PASS] health    ... devMode=false
[PASS] devMode   devMode=false：已关闭开发模式
[PASS] forge     默认密钥签发令牌被拒绝（401）
[PASS] password:ADMIN001   口令已非默认
[PASS] password:2017001    口令已非默认
```

退出码含义：`0` = 已加固；`1` = 仍有未加固项（探针会逐项说明）；`2` = 服务器不可达。
（`INFO` 行是提示不是失败，例如 `dataDir` 字段外泄、`/admin/` 可公网打开。）

⚠️ 探针的密码检查每跑一次会让对应账号累计 **1 次失败**（连续 5 次锁 15 分钟）。重复验收请加 `--skip-password`：

```powershell
node tools\verify-hardening.js --base http://8.138.41.74 --skip-password
```

无 Node 环境时，用 DSH 自带运行时：

```powershell
& 'C:\Users\Lenovo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' tools\verify-hardening.js --base http://8.138.41.74
```

### 切完 `DEV_MODE=0` 后，务必做一次真机回归

在微信开发者工具里（`app.js` 已指向 `http://8.138.41.74`，需勾选「不校验合法域名」）：

1. 未绑定账号的微信 → 进入绑定页 → 绑定成功（这条走的就是新的 `bindTicket` 路径，是本次改动最可能出问题的地方）；
2. 已绑定账号 → 直接进入首页，能看到「我的课程」；
3. 班干部带出课程 → 生成 60 秒动态码 → 教师端扫码确认成功。

任一步失败时先用 `sudo bash harden-attendance.sh rollback` 回到开发模式，再排查：
`sudo journalctl -u attendance -n 80 --no-pager`（`50002` 就是 AppSecret 的问题；`40101` 是 bindTicket 缺失/过期）。

---

## 五、回滚（1 条命令）

```bash
sudo bash harden-attendance.sh rollback     # DEV_MODE=1，恢复开发模式，立即重启
```

- 只回退 `DEV_MODE`，**不**回退密钥（密钥轮换本身无法也不应回退）。
- 当前 unit/环境文件在改动前已备份到 `/root/attendance-backup-<时间戳>/`，需要手工比对时看那里。
- 该命令仅用于应急联调；`DEV_MODE=1` 意味着绑定免票据，**排查完应尽快再切回生产**。

---

## 六、这次没做的事（以及为什么）

| 事项 | 现状 | 说明 |
|---|---|---|
| HTTPS + 已备案域名 | 未做 | 小程序 `apiBase` 仍是 `http://8.138.41.74`（明文），只能在开发者工具勾「不校验合法域名」下用；**微信正式版要求 HTTPS + 已备案域名**，无备案域名无法提交审核。属于资料/资质问题，不是代码问题。 |
| `/admin` 限制来源 IP | 未做 | 改口令后风险已降一个量级；更稳的是 Nginx 里 `allow/deny` 只放学校出口 IP（会连带影响在家办公，需你确认网段）。 |
| 健康检查收敛字段 | 未做 | `/api/v1/health` 仍回显 `dataDir` 与 `devMode`。建议后续改成只回 `{ok,version}`（需要改 `backend` 源码并重新部署）。 |
| 把项目纳入 git 并推送 | 未做（你没选） | 现在是 tarball 部署，不是 git push；`D:\教学工作\2026\月工作总结以及工作计划` 是 git 仓库但该项目目录未被跟踪。 |
| 每小时自动轮换/告警 | 未做 | 需要监控/定时任务，属于后续演进。 |

---

## 七、命令速查

```bash
# 体检
sudo bash harden-attendance.sh status

# 轮换密钥（随时可做，不用 AppSecret）
sudo bash harden-attendance.sh seal

# 改后台口令（交互式）
sudo bash rotate-web-passwords.sh

# 切生产（必须先填 WX_APPSECRET）
sudo bash harden-attendance.sh prod

# 应急回滚
sudo bash harden-attendance.sh rollback

# 日志 / 状态
sudo systemctl status attendance --no-pager
sudo journalctl -u attendance -n 80 --no-pager
```

本地只读验收：

```powershell
node tools\verify-hardening.js --base http://8.138.41.74
node tools\verify-hardening.js --base http://8.138.41.74 --skip-password   # 重复验收用
```

---

## 八、文件清单（本套加固件）

| 文件 | 作用 |
|---|---|
| `deploy/harden-attendance.sh` | 主脚本：`status` / `seal` / `secrets` / `prod` / `rollback`，幂等、带备份、失败自动回滚；探测端口从线上 unit 的 `PORT`/环境文件读取（**不写死 8081**），也不会覆盖运维的 `ExecStart`/`User`/`WorkingDirectory` |
| `deploy/attendance.service` | 生产 unit 模板：**仅当本机还没有 unit 时**才整份使用；已有 unit 时脚本只做原地加固，不会覆盖运维参数 |
| `deploy/attendance.env.example` | `/etc/attendance.env` 的字段说明（真实文件权限必须是 600） |
| `deploy/rotate-web-passwords.sh` | 通过公开 API 修改 `/admin` 后台口令（新口令不回显、不进历史） |
| `deploy/tests/harden-logic-test.sh` | 离线逻辑测试：用假 systemctl/curl 跑通 seal/prod/回滚，`48 通过 / 0 失败` |
| `课时签到微信小程序/tools/verify-hardening.js` | 只读验收探针（`--base` 指向线上；不改任何数据，**只在本机跑，不用传到服务器**） |
| `deploy/harden-secrets.sh` | **已废弃**，转发到 `harden-attendance.sh`（原实现锚定字面量 `DEV_MODE=1`，改 mode 后静默失效） |
