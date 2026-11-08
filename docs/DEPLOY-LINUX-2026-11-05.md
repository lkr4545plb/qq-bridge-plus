# Linux 部署说明（2026-11-05，`instance-20261104-2007`）

本文件记录**这台机器上实际做了什么**，以及"还差什么才能真的收 QQ 消息"。
QQ 登录与网络策略按约定留给你起床后处理，这里不代为操作。

## 现在的状态

| 组件 | 状态 | 说明 |
|---|---|---|
| 桥接进程 | ✅ systemd 常驻 | `qq-bridge.service`，`Restart=always`，`RestartPreventExitStatus=2`（与 `start.bat` 同语义：exit 2 = 已有实例，不重启） |
| DSH 连接 | ✅ `dshReady: true` | 指向 `http://<本机内网IP>:8080`（本机 `dsh web` 的监听地址） |
| 控制台 | ✅ `127.0.0.1:3100` | 令牌在 `state/console-token`；**只绑回环**，要从外部访问走 SSH 隧道 |
| SnowLuma（QQ 网关） | ❌ 未安装 | 这台没有 Docker；安装与扫码登录都需要你来做，见文末 |
| 白名单 / ownerQQ | 空 | 按设计**不会回复任何人**，也进不了管理命令 |

## 常用命令

```bash
systemctl status qq-bridge          # 状态
sudo systemctl restart qq-bridge    # 重启（改了 config.json 之后需要）
sudo systemctl stop qq-bridge       # 停止
sudo journalctl -u qq-bridge -f     # 跟日志（stdout/stderr）
tail -f state/bridge.log            # 桥接自己的日志（有 2000 行轮转）
cat state/console-token             # 控制台令牌
```

开机自启已 `enable`。`state/`、`config.json` 都在 `.gitignore` 里，不会进版本库。

## 控制台怎么进

```bash
# 本地开隧道，然后浏览器打开（令牌换成 state/console-token 的内容）
ssh -N -L 3100:127.0.0.1:3100 ubuntu@<这台机器的地址>
# → http://127.0.0.1:3100/?token=<TOKEN>
```

控制台是**全权管理端**（能改人格、白名单、令牌、重启桥接），不要直接拿 nginx 暴露到公网。

## 这台机器特有的两处适配（换机器/升级 DSH 时要重看）

1. **`dsh.baseUrl` 用的是内网地址 `<本机内网IP>:8080`**，不是 `127.0.0.1`。
   `dsh web` 是带 `--host <本机内网IP>` 启动的，没绑回环。
   为此 `src/dsh-client.js` 新增了 `isLocalDshBase()`：**回环或本机任一网卡地址**都允许用
   本机 `.credentials.yaml` 里的签名密钥铸 Cookie（launch token 仍只允许回环，语义不变）。

2. **Cookie 名字的端口口径**。这台的 DSH 被 `dsh-purge` 打过 `cookie-name-ignore-port` 补丁，
   Cookie **名字**里不含端口，而原版 DSH 含端口。`mintBrowserSessionCookie()`
   现在同时发**两个名字**（带端口 + 不带端口），载荷里的 authority 仍是带端口的 `host:port`——
   对打过/没打过补丁的 DSH 都能用，不需要额外开关。

## 本轮代码改动带来的新配置

| 配置 | 默认 | 作用 |
|---|---|---|
| `dsh.muxHandshakeTimeoutMs` | `10000` | 事件流建连后 10s 收不到任何帧就重连（健康 DSH 必回 `ready` 帧） |
| `dsh.muxIdleTimeoutMs` | `0`（关） | 空闲超时。**默认关**：DSH 在安静时段本来就可能几小时不发帧，误判会变成每 ~93 秒"重连 + 清空在途 collector + 重发 follow 快照"，比半开连接更糟。要用请设 ≥ 15 分钟并观察日志 |
| `socialV2.state.saveDebounceMs` | `400` | social-v2 落盘合并窗口（只在**每条入站消息**那条热路径生效；显式保存仍同步且会取消待写） |
| `socialV2.wake.promptDedupe` | `{enabled:true, repeatEvery:4}` | 唤醒提示的静态说明按会话去重：首轮/每 4 轮发全量，其余只带状态 + "规则同上轮" |
| `socialV2.wakeTimeScale` | 睡觉 0–8 点 ×0.2、DS 波峰 ×0.5 | 只作用于"摇概率"的软唤醒；@/名字/关键词/提问/拍一拍/指定成员/私聊一律不打折 |

## swap

已加 2 GB `/swapfile-qqbridge` 并写入 `/etc/fstab`（本机 12 GB 内存，这份主要用于兜底
未来 SnowLuma 容器的内存尖峰）。撤销：

```bash
sudo swapoff /swapfile-qqbridge && sudo rm /swapfile-qqbridge
sudo sed -i '/swapfile-qqbridge/d' /etc/fstab
```

## 还差什么才能真正收 QQ 消息（等你起床）

1. **装 SnowLuma（Linux 走 Docker，官方推荐）**
   ```bash
   sudo apt-get install -y docker.io
   sudo usermod -aG docker ubuntu   # 重新登录生效
   ```
   然后按官方 compose 起容器（镜像内置 Linux QQ + Xvfb + VNC + noVNC）：
   ```yaml
   # docker-compose.yml
   services:
     snowluma:
       image: motricseven7/snowluma:latest
       container_name: snowluma
       restart: unless-stopped
       shm_size: 1gb
       ulimits: { nofile: { soft: 65536, hard: 1048576 } }
       cap_add: [SYS_PTRACE]            # 不能省：native addon 靠 ptrace 注入 QQ
       security_opt: [seccomp=unconfined]
       ports:
         - "127.0.0.1:6081:6081"        # noVNC：只给本机，SSH 隧道进去扫码
         - "127.0.0.1:5099:5099"        # WebUI
         - "3000:3000"                  # OneBot HTTP（只给桥接用）
         - "3001:3001"                  # OneBot WS
       volumes:
         - qq-gateway-data:/app/data
         - qq-client-config:/app/.config
         - qq-client-data:/app/.local/share
   volumes:
     qq-gateway-data: { name: qq-gateway-data }
     qq-client-config: { name: qq-client-config }
     qq-client-data: { name: qq-client-data }
   ```
   `docker compose up -d` 之后：
   ```bash
   docker logs snowluma 2>&1 | grep -E "远程桌面密码:|remote desktop password:" | tail -1
   ssh -N -L 6081:127.0.0.1:6081 ubuntu@<这台机器>   # 浏览器开 http://127.0.0.1:6081/ 扫码
   docker logs snowluma 2>&1 | grep -E "临时密码|initial credentials" | tail -1   # WebUI 5099
   ```

2. **在 SnowLuma WebUI 里开 OneBot HTTP(3000) + WS(3001)，设 access token**，
   并把同一个 token 写进 `config.json` 的 `snowluma.accessToken`，然后
   `sudo systemctl restart qq-bridge`。`wsUrl/httpUrl` 默认就是 `127.0.0.1:3001/3000`，不用改。

3. **装预设**（当前 `/api/presets` 里没有 `qq-chat` / `qq-chat-v2`；没有它群会话会 fail-closed 拒绝建会话）：
   ```bash
   cd <仓库路径> && node scripts/setup-dsh.mjs
   ```
   它会改 `~/.dsh/profiles/web/cordis.patch.yml` 与对应 `package.json`，装 3 个 MCP server + 2 个 bundle。
   跑完重启 DSH 与桥接。

4. **填 `ownerQQ` 与 `allow.private` / `allow.groups`**（控制台「访问与安全」页，或直接改 `config.json`）。

5. **网络策略**：只有"从外面访问 noVNC/WebUI"才需要放行端口；建议一律走 SSH 隧道，不开公网端口。

## 回滚

```bash
sudo systemctl disable --now qq-bridge
sudo rm /etc/systemd/system/qq-bridge.service && sudo systemctl daemon-reload
```
代码层面的改动都在工作区（未提交），`git checkout -- <file>` 可逐个还原。

---

## SnowLuma 实际安装记录（2026-11-05 08:2x）

按官方推荐的 Linux + Docker 路径装好了，**没有**把任何端口暴露到公网。

| 项 | 值 |
|---|---|
| Docker | `docker.io` 29.1.3（Ubuntu 22.04 源），`systemctl is-enabled docker` = enabled |
| 镜像 | `motricseven7/snowluma:latest`（2.69 GB 磁盘 / 725 MB 压缩层） |
| 容器 | `snowluma`，`--restart unless-stopped`，`--shm-size=1g`，`--memory 4g`，`--cap-add=SYS_PTRACE`，`--security-opt seccomp=unconfined` |
| 端口 | 全部绑 `127.0.0.1`：6081(noVNC) / 5099(WebUI) / 3000(OneBot HTTP) / 3001(OneBot WS) |
| 卷 | `qq-gateway-data`(/app/data)、`qq-client-config`(/app/.config)、`qq-client-data`(/app/.local/share) |
| 资源 | 空载 ~434 MB / 4 GB 上限，CPU ~3% |

**OneBot token 已统一**：镜像首次启动给 HTTP 与 WS 各生成一个随机 token，而桥接只有一个
`snowluma.accessToken` 字段。已把两者改成同一个值并写进 `config.json`，桥接已重启生效。
（改 token 只能改 `/app/data/config/onebot.json` 后重启容器，或在 WebUI 里改；改完要同步
`config.json`。）

**凭据不写进仓库**：远程桌面密码与 WebUI 初始密码放在 `~/snowluma-credentials.txt`（600）。

**当前状态**：QQ 进程已起但**未登录**（容器日志 `[Hook] awaiting login`），因此 OneBot
端口在监听但暂不服务动作 —— 这解释了桥接状态里的 `snowluma: fetch failed`。扫码登录后即恢复。
