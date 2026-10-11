# 方案 A 上线说明：让「院系 / 教学班」在后台导入中心维护

> 目标：把「导入中心」从 4 个类型扩到 6 个（最左两个页签 = **院系**、**教学班**），
> 以后院系 / 教学班改名、归档、新增都能在网页上做，不用再登服务器改 JSON + 重启。
>
> 服务器命令需 root；本机没有 SSH 私钥，**必须由你在服务器上执行**。

---

## 1. 产物清单（都在 `deploy/` 下）

| 文件 | 大小 | sha256 | 说明 |
| --- | --- | --- | --- |
| `kcsq-import-masterdata-20261011.tar.gz` | 34059 B | `68967119dfe9ccddea1c15eda19c128ddd4b8290f13f2dba1c1c527084e01cf8` | 补丁包，**只含 5 个文件**，解到 `/opt/apps/attendance` |
| `apply-import-masterdata.sh` | 10719 B | `eac00d4081253737df4ad65fcdf2a53bf798e4d909f980553c322cbea5391bc7` | 服务器端执行脚本（status / apply / rollback） |
| `tests/import-masterdata-apply-test.sh` | 9860 B | `9bc5f14075b9861236c46862b8c94a7cdea931a4976875417955f80e82fbcbcd` | **本机离线自测**（48 项断言，全绿），不碰真实环境 |

包内 5 个文件（这就是方案 A 的全部代码改动）：

```
attendance/src/io.js                            # 校验/落库/模板：6 个导入类型 + 主数据 helper
attendance/src/routes/admin.routes.js           # 路由：precheck 前置、6 类型、data=1 导出
attendance/src/routes/index.js                  # 接口说明 + 公开统计里的 depts/classes 计数
attendance/public/admin/js/pages/import.js      # 后台导入中心：6 个页签 + 「导出当前数据（含 ID）」
attendance/tools/import-masterdata-test.js      # 新增：40 项主数据导入单测（可选，便于线上自查）
```

**不包含** `data/`、`package.json`、systemd unit、nginx 配置 —— 不会覆盖任何线上数据或运维配置。

---

## 2. 上线三步（在服务器上）

```bash
# ① 上传补丁包（本机 scp / 宝塔面板 / 任意方式都行）
#    放到 /tmp/kcsq-import-masterdata-20261011.tar.gz
#    顺便把 apply-import-masterdata.sh 也传到 /root/

# ② 先看现状（只读，不做任何改动）
cd /root && bash apply-import-masterdata.sh status
#    期望看到：线上 IMPORT_TYPES = ['tasks','students','whitelist','cadres'] → 需要 apply
#    同时会校验补丁包 sha256 是否与本说明一致

# ③ 执行更新（自动备份 → 解包 → 标记校验 → node --check → 重启 → 探活）
cd /root && bash apply-import-masterdata.sh apply
```

脚本行为：

1. 把将被覆盖的 4 个旧文件备份到 `/root/attendance-backup-<时间戳>/`（同秒重复执行会加 `-2`，不覆盖上一次备份）；
2. `tar -xzf ... -C /opt/apps/attendance --strip-components=1`；
3. **校验新能力真的就位**（`IMPORT_TYPES`/`depts`/`resolveMaster`/`nextMasterId`/`precheck`/「导出当前数据」）；
4. `node` 在 PATH 里就逐个 `node --check`；
5. `systemctl restart attendance` → `is-active` + 本机 `curl /api/v1/health`、`/admin/`；
6. **任何一步不过 → 自动回滚**并打印 `journalctl -u attendance -n 50` 的排查提示。

出问题一键还原：

```bash
cd /root && bash apply-import-masterdata.sh rollback          # 自动取最新备份
cd /root && bash apply-import-masterdata.sh rollback /root/attendance-backup-20261011-223000
```

---

## 3. 验收（浏览器）

Ctrl+F5 **强刷**（`import.js` 有缓存）后打开 `http://8.138.41.74/admin/` →「数据」→「导入中心」：

- [ ] 页签从 4 个变成 **6 个**，最左边是「院系」「教学班」；
- [ ] 这两个页签多出一个「**导出当前数据（含 ID）**」按钮，点它能下到 `export_depts.csv` / `export_classes.csv`（含真实 ID 列）；
- [ ] 「下载标准模板（CSV）」下到的表头分别是 `院系名称,院系代码,上级院系,院系ID`、`教学班名称,年级,所属院系,班主任,教学班ID,状态`；
- [ ] 拿导出文件原样再导一次：预校验通过、确认导入后**行数不变**（原地更新）；
- [ ] 故意写错一个院系名再预校验：报错原文里能看到 `所属院系「X」不存在（请先用「院系」页签导入院系，或改填院系ID）`；
- [ ] 「导入历史」里能看到 `depts` / `classes` 任务，且成功的任务有「回滚本次导入」。

线上自查（可选，包内已带单测）：

```bash
cd /opt/apps/attendance && node tools/import-masterdata-test.js   # 期望「通过 40 / 失败 0」
```

---

## 4. 注意事项

- **不要用旧的 `deploy-attendance.sh` 全量包**做这次更新：那个包会整目录覆盖，而本次只需要这 5 个文件。
- 补丁包 sha256 已写进 `apply-import-masterdata.sh`（`EXPECT_SHA256`）。若重新打包，跑 `apply` 时加 `EXPECT_SHA256=<新值>`，或同步改脚本里的常量。
- 与安全加固包（`kcsq-harden-20261011.tar.gz`）**互不冲突**，两者改的文件没有交集，先后顺序随意。
- 脚本只重启服务、不动 `data/`；导入出来的数据都落在 `data/*.json`，导入后**不需要重启**。
- `apply` 是幂等的：线上已经是方案 A 版本时重跑不会损坏任何东西（会再备份一次）。

---

## 5. 本机离线自测怎么复现

```bash
# Windows / Git Bash：
bash deploy/tests/import-masterdata-apply-test.sh
```

覆盖：旧版本识别、备份内容、解包后逐字节与包内一致、`data/` 不被触碰、幂等、指定备份回滚、无参回滚取最新、篡改包被拒、缺包/缺目录被拒、
**解包后缺标记必须自动回滚** —— 共 **48 项断言**，当前 **48 通过 / 0 失败**。
（脚本用 `DRY_RUN=1` 跳过 systemctl/curl，所以只覆盖文件层逻辑；重启与探活只能在真服务器上验。）
