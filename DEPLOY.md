# 部署到公网指南

本系统为纯 Node.js 应用（Express + JSON 文件存储），**数据保存在 `data/` 与 `reports/` 目录**。部署到公网时，核心要求是：**选择带持久磁盘的平台，并妥善备份这两个目录**。

> ⚠️ 不要直接部署到 Vercel / Netlify 等 serverless 平台：它们的文件系统不持久，重启后会丢失全部数据和已生成的 Word 文档。

---

## 方案 A（推荐）：国内云服务器 —— 全流程详细教程

适合正式长期使用。腾讯云 / 阿里云轻量应用服务器 2核2G 即可（新人活动价约 ¥100/年）。以下以 **Ubuntu 22.04 + Docker** 为例（最简路径），文末附 pm2 备用方案。

### 第 1 步：购买服务器

1. 打开腾讯云轻量应用服务器 或 阿里云轻量应用服务器 官网，选购 **2核2G**、系统选 **Ubuntu 22.04 LTS**。
2. 购买后记下**公网 IP**，在控制台设置 root 密码（或创建密钥对）。

### 第 2 步：安全组 / 防火墙放行端口

在云控制台的「防火墙 / 安全组」中添加入站规则：

| 端口 | 用途 |
|---|---|
| 22 | SSH 远程登录（默认已开） |
| 80 | HTTP（Let's Encrypt 证书校验用） |
| 443 | HTTPS（正式访问入口） |

**不需要放行 3081**：应用只走 Nginx 反代，不直接暴露。

### 第 3 步：SSH 登录服务器

- 本地电脑 PowerShell：`ssh root@服务器IP`，输入密码。
- 或用云厂商自带的**网页版终端**（腾讯 OrcaTerm / 阿里 Workbench），免装客户端。

### 第 4 步：安装 Docker

```bash
# 国内服务器建议用阿里云镜像安装
curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun

# 开机自启
systemctl enable --now docker

# 验证
docker --version && docker compose version
```

配置镜像加速器（拉取 node 基础镜像更快）：

```bash
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.net",
    "https://docker.mirrors.ustc.edu.cn"
  ]
}
EOF
systemctl restart docker
```

### 第 5 步：上传项目到服务器

建议放到 `/opt/monthly-report`：

```bash
mkdir -p /opt/monthly-report
cd /opt/monthly-report
```

上传方式任选其一：

- **宝塔面板**（图形化）：服务器安装宝塔后，在「文件」里上传 zip 并解压到 `/opt/monthly-report`；
- **scp**（本地 PowerShell）：先把本地项目打包（排除 node_modules/data/reports），再上传：
  ```powershell
  cd D:\教学工作\2026\月工作总结以及工作计划
  tar -czf monthly-report.tar.gz --exclude=node_modules --exclude=data --exclude=reports .
  scp monthly-report.tar.gz root@服务器IP:/opt/monthly-report/
  ```
  服务器上解压：`tar -xzf monthly-report.tar.gz`。

> `data/` 和 `reports/` 不需要上传——首次启动会自动创建。若想保留现有数据，则一并上传这两个目录。

### 第 6 步：构建并启动

```bash
cd /opt/monthly-report
docker compose up -d --build

# 查看启动日志
docker logs -f monthly-report
# 看到"月度工作总结与计划生成系统 已启动"即成功
```

数据保存在服务器的 `/opt/monthly-report/data` 与 `/opt/monthly-report/reports`，**容器重建/重启不丢失**。

### 第 7 步：绑定域名 + HTTPS（必须）

1. **域名解析**：在域名服务商控制台添加 A 记录，指向服务器公网 IP（如 `report.你的域名.com`）。
2. **配置 Nginx 反代**（两种方式选一）：
   - **宝塔面板**（推荐新手）：安装宝塔 → 网站 → 添加站点（填域名）→ 设置 → 反向代理 → 目标 URL 填 `http://127.0.0.1:3081` → SSL 申请免费 Let's Encrypt 证书 → 强制 HTTPS。
   - **命令行**：把 `nginx.conf.example` 复制为 `/etc/nginx/conf.d/monthly-report.conf` 并修改 `server_name`，然后：
     ```bash
     apt install -y nginx certbot python3-certbot-nginx
     systemctl enable --now nginx
     certbot --nginx -d report.你的域名.com
     ```

### 第 8 步：上线验证

按 [自检清单](#部署后自检清单) 逐项检查，重点：改默认密码、配置 SMTP 发测试邮件、配置大模型测试连接。

### 第 9 步：数据备份（必做）

设置每天凌晨自动打包备份：

```bash
mkdir -p /backup
crontab -e
# 加入一行：
0 3 * * * tar czf /backup/monthly-report-$(date +\%F).tar.gz -C /opt/monthly-report data reports --exclude='data/*.tmp'
```

定期把 `/backup` 下载到本地保存。

### 备用：pm2 方式（不用 Docker）

```bash
# 安装 Node 20+（宝塔一键安装，或 nvm）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20

cd /opt/monthly-report
npm install --omit=dev
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup   # 按提示执行输出的命令实现开机自启
```

Nginx 反代与 HTTPS 配置同上。

---

## 方案 B：单位内网服务器 / 常开电脑 + 内网穿透（免费快速）

如果暂时不想买服务器，可在单位一台常开的电脑上运行系统，再用内网穿透让公网访问：

- **frp**（推荐，自建）：单位有公网 IP 的机器做 frps，内网电脑跑 frpc 映射 3081 端口。
- **花生壳 / natapp / cpolar**：免费版即可，按提示映射本地 3081 端口到公网域名。

注意：免费穿透的域名和速度有限制，适合测试或临时使用；正式使用建议方案 A。

---

## 方案 C：国外 PaaS（Render / Railway）

- 代码推 GitHub 后一键部署，免费额度够用，但**国内访问慢且不稳定**。
- 必须为 `data/`、`reports/` 挂载持久卷（Render 的 Disk、Railway 的 Volume），否则重启丢数据。
- 只推荐给在海外或对访问速度不敏感的场景。

---

## 部署后自检清单

- [ ] 浏览器打开 `https://您的域名/` 能正常提交
- [ ] 设置页登录、修改教研室/主任邮箱/成员名单后保存成功
- [ ] 已填写「自动汇总设置」中的二级学院接收邮箱
- [ ] 配置大模型 API Key 并「测试连接」通过
- [ ] 配置 SMTP 并「发送测试邮件」收到邮件
- [ ] 汇总生成两份 Word 可下载，邮件能发送到学院邮箱/主任邮箱
- [ ] 已修改默认管理员密码
- [ ] 已设置 `data/`、`reports/` 的定期备份

## 常见部署问题

- **拉取镜像慢**：已配置镜像加速器仍慢，可换用 `dockerpull.org` 等加速地址，或服务器端手动 `docker pull node:20-alpine` 一次。
- **邮件发不出去**：国内云服务器一般封禁 25 端口出站，本系统使用 465/587 端口不受影响；若用 587 请把「SSL 加密」勾选去掉。
- **大模型汇总超时**：Nginx 已配置 `proxy_read_timeout 300s`；若用宝塔反代，请在反代配置中同样调大超时。
- **忘记管理员密码**：登录服务器，编辑 `data/settings.json`，把 `adminPassword` 改为 `sha256(新密码)` 的十六进制（可用 `echo -n 新密码 | sha256sum` 生成），重启容器。
