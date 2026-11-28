# 生产集群运维与故障应急手册（OPERATIONS）

> 本手册覆盖 4 节点生产集群拓扑、**免重启热配置与热发邮件**、**零踢人蓝绿热更新 SOP**、TLS 证书与 CDN 维护、同机共存服务边界，以及故障应急处理。
>
> **安全约定**：真实主机 IP、SSH 端口与指纹配置在本机 `~/.ssh/config`（别名：`xiangyang`、`server-156`、`ningbo`、`kunming`）与私密运维手册中，本文不保存任何明文口令、Token 或原始 IP。

---

## 一、生产 4 节点分流集群拓扑（总容量 `295` 人）

所有节点运行同一套无状态对局网关（`server/performance-maps.js`）+ 按图自动启停/分片的 `GameRoom` 子进程（`server/private-map-server.js`），节点间每 **2.5 秒**互探 `/perf/health?local=1` 与 `/perf/rooms.json?local=1` 实现全服房间联邦和自动负载路由。

| 节点 ID | SSH 别名 | 展示名称 | 硬件规格 | 软/硬上限 | 权重 | 角色与入口特性 |
|---|---|---|---|---:|---:|---|
| `xiangyang` | `xiangyang` | **华中主区** | 32C / 32G / 50M | `100 / 105` | **2.0** | **核心主力对局节点**，直签 Let's Encrypt 短期 IP 证书，走独立高端口直连 50M 全速（零中转）；最大 16 Worker |
| `node2` | `server-156` | 高速二区 | 高配海外/BGP | `100 / 105` | 1.3 | 承接主域名入口 `https://cs2-ws.apikeygame.top`（灰云直连）与静态素材源站 `https://cs2-cdn.apikeygame.top`（橙云 CF 缓存）；最大 12 Worker |
| `ningbo` | `ningbo` | 华东一区 | 8C / 16G / 20M | `60 / 65` | 1.0 | 兼任直连 Web `/perf/` 服务与华东主力分流，通过高端口反代出口提供有效 HTTPS/WSS；最大 12 Worker |
| `kunming` | `kunming` | 昆明三区 | 4C / 4G | `35 / 38` | 0.7 | 西南补充节点（直签 IP 证书高端口）+ 宁波出口反代；最大 3 Worker |

### 关键分流与限流公式
- 新房选点函数 `rankClusterNodesForNewRoom()` 过滤条件：`enabled && acceptNewRooms && healthy && ready && !draining && !overloaded && !full && !hardFull`。
- 排序评分：`score = (humans / maxHumans) / weight + cpuPenalty`（当 `load1m / cpus > 0.65` 时叠加 CPU 惩罚）。
- 结果：高权重（`2.0`）的 `xiangyang` 自然承接最高比例新房，单机达到软上限（`maxHumans`）自动停止分配新房，达到硬上限（`hardMaxHumans`）拒绝非重连新进连接（已断线玩家持 `resumeToken` 不受拦截）。

---

## 二、日常免重启热运营（2.5 秒生效，零中断）

### 2.1 动态调整集群上限、权重、摘流或切换 CDN
配置文件路径（四台节点保持一致）：`/opt/cs2-web/cluster-config.json`（模板见 [ops/cluster-config.example.json](../../ops/cluster-config.example.json)）。

常用场景：
1. **调高/调低某节点人数上限或权重**：修改对应节点的 `maxHumans` / `hardMaxHumans` / `weight` 与顶层 `version` 字段。
2. **某机房带宽告警 / 计划维护（优雅摘流）**：
   - 将该节点设为 `"acceptNewRooms": false`（停止接新房，老房间继续打完）或 `"enabled": false`（全服摘除）；
   - 同步到 4 台节点并调用环回热重载，**10 秒内新流量全部切走且不踢走任何正在打游戏的玩家**。
3. **动态切换 CDN 源站**：修改 `cdn.assetBaseURL` / `cdn.mapBaseURL`，新进入战局的客户端会自动通过 `/perf/download-config.json` 拉取新 CDN 地址，无需重发 Toy。

同步并立刻触发热重载（无需等 2.5s 轮询）：
```bash
for h in xiangyang server-156 ningbo kunming; do
  scp -o BatchMode=yes /tmp/cluster-config.json "$h:/opt/cs2-web/cluster-config.json"
done
# 按各节点当前活跃本地端口触发立即重载（示例端口以各节点 nginx upstream 为准）
ssh xiangyang  'curl -fsS -X POST http://127.0.0.1:<ACTIVE_PORT>/perf/internal/reload-config'
ssh server-156 'curl -fsS -X POST http://127.0.0.1:<ACTIVE_PORT>/perf/internal/reload-config'
ssh ningbo     'curl -fsS -X POST http://127.0.0.1:<ACTIVE_PORT>/perf/internal/reload-config'
ssh kunming    'curl -fsS -X POST http://127.0.0.1:<ACTIVE_PORT>/perf/internal/reload-config'
```

### 2.2 发送全服公告 / 皮肤 / 匕首 / 探员 / 经验 / 自定义物品奖励
配置文件路径（四台节点保持一致）：`/opt/cs2-web/mail-announcements.json`（模板见 [ops/mail-announcements.example.json](../../ops/mail-announcements.example.json)）。

- **方式 A（推荐，同步文件至四台节点，2.5s 热生效）**：编辑 JSON 增删邮件条目（务必保证 `id` 全局唯一），`scp` 覆盖四台节点的 `/opt/cs2-web/mail-announcements.json` 即可。
- **方式 B（本机环回实时 API）**：
  - 新增/更新单封邮件：`curl -X POST http://127.0.0.1:<PORT>/perf/internal/mail -H 'Content-Type: application/json' -d '{...}'`
  - 删除邮件：`curl -X DELETE http://127.0.0.1:<PORT>/perf/internal/mail/<MAIL_ID>`
  - 强制重载：`curl -X POST http://127.0.0.1:<PORT>/perf/internal/reload-mail`
  - 注意：若通过单机 API 写入，务必同步到其余 3 台节点，保证玩家无论命中哪个容灾入口看到的邮箱一致。

奖励条目示例（支持自由混搭，未来新物品用 `type: "item"` 即可免改客户端发放）：
```json
{
  "id": "event-2026-winter",
  "category": "reward",
  "pinned": true,
  "sender": "随时随地CS 运营组",
  "title": "版本更新补偿与限定纪念章",
  "body": "正文支持换行，安全按纯文本渲染。",
  "createdAt": 1795900000000,
  "target": "all",
  "rewards": [
    { "type": "skin", "skinId": "karambit-vanilla" },
    { "type": "agent", "agentId": "ct-ava" },
    { "type": "xp", "amount": 1000 },
    {
      "type": "item",
      "itemId": "badge-winter-2026",
      "title": "冬季赛季限定徽章",
      "category": "badge",
      "quantity": 1,
      "icon": "W26",
      "description": "活动限定收藏品"
    }
  ]
}
```
> 若只需发给特定玩家，将 `"target"` 改为 `"uids"` 并添加 `"targetUids": ["目标toyOpenId"]`；对外 `/perf/mail.json` 接口会自动剔除 `targetUids` 字段，绝不泄露名单。

---

## 三、零踢人蓝绿热更新 SOP（服务端代码升级唯一允许方式）

每台节点均配置双 systemd 槽位：**Blue（`cs2-web-perf.service`）** 与 **Green（`cs2-web-perf-green.service`）**，各监听不同本地环回端口：

| 节点 | Blue 端口 | Green 端口 | Nginx 指向配置文件 |
|---|---:|---:|---|
| `xiangyang` | `:3240` | `:3241` | `/etc/nginx/conf.d/cs2-node-tls.conf`（`upstream cs2_xy_local`） |
| `server-156` | `:3240` | `:3241` | `/etc/nginx/snippets/cs2-perf.conf` |
| `ningbo` | `:3240` | `:3242` | `/etc/nginx/conf.d/cs2-internal-tls-3241.conf`（`upstream cs2_local_3240`） |
| `kunming` | `:3246` | `:3247` | `/etc/nginx/conf.d/cs2-node3-3245.conf` |

### 标准切换步骤（逐节点执行，严禁跳过第 1 步！）
1. **核查双槽位在线人数**：
   ```bash
   curl -sS http://127.0.0.1:<BLUE_PORT>/perf/health?local=1
   curl -sS http://127.0.0.1:<GREEN_PORT>/perf/health?local=1
   ```
   **仅当空闲槽位 `node.humans === 0` 时才允许重启该空闲槽位！** 若旧排水槽仍有玩家在局，切勿强杀，等该局结束自然归零后再升级。
2. **同步新代码到 `/opt/cs2-web/`**（已在运行中的 Node 进程已加载内存模块，覆盖磁盘文件不会影响在局玩家）。
3. **重启空闲槽位并探活**：
   ```bash
   systemctl restart <IDLE_SERVICE>
   curl -fsS http://127.0.0.1:<IDLE_PORT>/perf/health?local=1
   curl -fsS http://127.0.0.1:<IDLE_PORT>/perf/mail.json
   ```
4. **切流 Nginx 并平滑重载**：修改对应 nginx 配置中的 `127.0.0.1:<PORT>` 指向新槽位，执行 `nginx -t && systemctl reload nginx`。
5. **优雅排水旧槽位（零踢人）**：
   ```bash
   systemctl kill -s SIGUSR2 <OLD_SERVICE>
   ```
   旧网关收到 `SIGUSR2` 后将 `draining = true` 同步给全部子 Worker，不再接受新连接，已连接玩家打完当前对局后自动释放，全程无掉线感知。

---

## 四、TLS 证书、CDN 与同机共存红线

1. **TLS 自动续期**
   - `xiangyang`：Let's Encrypt 短期（6 天）IP 证书，由 `cs2-ip-cert-renew.timer` 每 6 小时自动检查续期并重载 nginx。
   - `server-156`：`cs2-apikeygame` 域名证书（`cs2-ws.apikeygame.top` / `cs2-cdn.apikeygame.top`）由 `cs2-certificate.timer` 自动续期；IP 证书由 `freeship26-ip-certificate.timer` 维护。
   - `kunming`：复用机上自动续期 IP 证书服务高端口。
2. **Nginx 关键约束**
   - Ubuntu 24.04 自带 Nginx `1.24.0` **不支持** `http2 on;` 指令，保持标准 `listen <port> ssl;`。
   - `server-156` 上 `/etc/nginx/sites-enabled/z-cs2-domains.conf` 必须以 `z-` 前缀命名，确保字母序排在 `freeship26-ip` 默认站点之后，避免覆盖 IP 默认证书导致其他服务及 Peer 探活报 TLS 域名不匹配。
3. **CDN 缓存架构**
   - `cs2-cdn.apikeygame.top` 走 Cloudflare **橙云代理**回源至 `server-156:/opt/cs2-web/cdn`，所有带哈希/不可变资产带 `Cache-Control: public, max-age=31536000, immutable`，绝大部分静态流量由 Cloudflare 边缘节点直接命中消化。
   - `cs2-ws.apikeygame.top` 走 Cloudflare **灰云直连**（不经过 CF 代理，确保低延迟直连 WebSocket）。
4. **同机共存业务严禁触碰清单**
   - `server-156`：Golden Hour（`:443 /api/rooms` 反代）、FreeShip；
   - `ningbo`：Golden Hour 游戏主服（`golden-hour.service`）、GetJobs（`getjobs-control`）；
   - `kunming`：AimArena（`:8443` / `:18080`）、Inkwave、Hi-Zhichang Auth。

---

## 五、巡检与故障应急速查

### 一键全服巡检
```bash
# 1. 公网健康与 4 节点容量汇总
curl -sS https://cs2-ws.apikeygame.top/perf/health
curl -sS https://cs2-ws.apikeygame.top/perf/config.json
curl -sS https://cs2-ws.apikeygame.top/perf/mail.json

# 2. 查看某节点实时遥测（RTT、人数、防作弊日志，仅本机环回可读）
ssh xiangyang 'curl -sS http://127.0.0.1:3240/perf/internal/telemetry.json'
```

### 高频故障处理预案
- **单机房流量耗尽 / 宕机**：在剩余健康节点的 `/opt/cs2-web/cluster-config.json` 中把故障节点 `"enabled": false` 并调用 `POST /perf/internal/reload-config`。若故障的是主域名 `cs2-ws.apikeygame.top` 源站，同时在 Cloudflare DNS 将 `cs2-ws` A 记录切至健康节点，或依赖客户端内置 5 入口自动容灾（60 秒冷却退避）无缝顶上。
- **新加入加密房报“房间已关闭”**：优先排查目标节点是否已升级至包含 `roomCosmetics` 跨节点桥接的版本（提交 `1bbb499` 及以后），以及四台节点间 `2.5s` 心跳是否全部 `healthy: true`。
- **某节点 CPU 飙高 / Tick 抖动**：检查 `perf/health` 中 `load1m / cpus` 是否超过 `maxLoadPerCpu`，必要时在 `cluster-config.json` 临时调低该节点 `maxHumans` 或 `weight`，系统将自动把新房导流至其余节点。
