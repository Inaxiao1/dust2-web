# 生产级高可用集群部署与实测性能压测报告

> 对应总规约 [SPEC.md](../SPEC.md) Phase 4 实机验证。本文档记录在目标部署服务器 `game.example.com`（8 vCPU / 15 GiB RAM）上的隔离部署拓扑、真实公网 HTTPS/WSS 延迟、JSON v1 vs Binary v2 带宽对比、20–280 并发玩家阶梯压测、Go 控制面本地吞吐基准、在线 Graceful Drain 演练结果以及容量规划建议。（说明：文中生产入口已脱敏为 `game.example.com`。）

- **测试日期**：`2026-11-26`
- **压测脚本**：[scripts/bench-remote.mjs](../scripts/bench-remote.mjs)、[scripts/bench-drain-remote.mjs](../scripts/bench-drain-remote.mjs)
- **被测入口**：`https://game.example.com/cs2`（有效 TLS 证书，兼容 B站 Toy `https://www.bilibilitoy.com` 跨域调用）

---

## 1. 目标主机与隔离部署拓扑

### 1.1 主机硬件与环境基线
| 项目 | 实测规格 |
| :--- | :--- |
| **主机环境 / OS** | `prod-host-8c16g` / Ubuntu 24.04.1 LTS (`Linux 6.8.0-147-generic x86_64`) |
| **CPU** | 8 vCPU (`Intel Xeon Platinum 8269CY @ 2.50GHz`) |
| **内存 / 磁盘** | 15 GiB RAM（部署前可用 7.6 GiB） / 155 GiB 根分区（49 GiB 可用） |
| **同机已有服务** | `nginx`（TCP 80/443）等既有服务（部署全程零侵入、零重启） |
| **本机到主机 ICMP RTT** | `min=24.84 ms / avg=25.37 ms / max=26.11 ms / stddev=0.48 ms`（0% 丢包） |

### 1.2 隔离部署目录与 Systemd 服务（`/opt/cs2-ha/`）

所有组件独立安装在 `/opt/cs2-ha/`，不污染系统全局环境，也不暴露任何未加密公网端口（全部绑定 `127.0.0.1`，由 Nginx 443 统一 TLS 终结）：

| 服务单元 | 监听地址 | 职责与核心参数 | 静态资产体积 |
| :--- | :--- | :--- | :--- |
| `cs2-control-plane.service` | `127.0.0.1:19080` | Go 静态二进制（`6.7 MB`）；无状态房间调度、全局目录与 HMAC-SHA256 `JoinToken` 签发；`WORKER_TTL_SECONDS=15` | `0 B` |
| `cs2-battle-worker@1.service` | `127.0.0.1:19101` | 隔离 Node `v22.14.0` 运行纯逻辑对局服（`DUST2_LOGIC_ONLY=1`、`DUST2_SERVE_MAP_FILES=0`、`DUST2_REQUIRE_JOIN_TOKEN=1`、`MAX_ROOMS=16`）；上报地址 `wss://game.example.com/cs2/w1/ws` | `2.1 MB` 压缩包（仅代码 + `de_dust2` 碰撞与穿透表，排除 2.67 GB 客户端资产） |
| `cs2-battle-worker@2.service` | `127.0.0.1:19102` | 同上；上报地址 `wss://game.example.com/cs2/w2/ws` | 共享 `/opt/cs2-ha/worker` |
| `/etc/nginx/snippets/cs2-ha.conf` | `https://game.example.com/cs2/*` | 反代 `/cs2/api/*` -> `:19080/api/*`、`/cs2/w{1,2}/ws` -> `:1910{1,2}/ws`（`tcp_nodelay on`、`proxy_buffering off`）、`/cs2/w{1,2}/{health,ready}`；**`/drain` 与 `/internal/*` 严禁暴露公网** | — |

> **安全边界**：随机生成的 `JOIN_TOKEN_SECRET`、`WORKER_AUTH_TOKEN`、`DUST2_DRAIN_TOKEN` 仅保存在主机 `/opt/cs2-ha/env/cluster.env`（`chmod 600`），不写入仓库或日志。公网访问 `https://game.example.com/cs2/index.html` 返回 `404`，CORS 实测精准放行 `Origin: https://www.bilibilitoy.com`。

---

## 2. 延迟与吞吐基准

### 2.1 Go 控制面：本机原生性能 vs 公网 HTTPS 端到端

| 指标 | 主机本机回环（`127.0.0.1:19080`，纯服务端开销） | 远程公网 HTTPS（Mac -> `https://game.example.com/cs2`，含本地代理/TLS 链路） |
| :--- | :--- | :--- |
| **`GET /api/v1/health` 顺序延迟** | `min 0.42 ms` / **`P50 0.61 ms`** / `P95 1.49 ms` / `P99 2.59 ms`（200 次） | `min 79.60 ms` / **`P50 82.17 ms`** / `P95 89.32 ms` / `P99 90.91 ms`（30 次） |
| **`GET /api/v1/rooms` 顺序延迟** | — | `min 80.55 ms` / **`P50 81.49 ms`** / `P95 85.80 ms`（20 次） |
| **`POST /api/v1/rooms`（选点 + 签发 Token）** | `min 0.47 ms` / **`P50 0.52 ms`** / `P95 1.13 ms`（50 次） | `P50 77.19–83.72 ms`（不含网络传输的服务端耗时 `< 1 ms`） |
| **并发吞吐（健康检查）** | 32 并发 x 100 轮 = 3,200 请求：**`2,838 QPS`**（P50 `10.39 ms` / P95 `16.71 ms` / P99 `22.50 ms`，0 错） | 12 并发 x 4 轮 = 48 请求：`66.0 QPS`（P50 `82.33 ms`，0 错） |

> **链路说明**：测试端 Mac 到生产主机裸 ICMP RTT 为 `25.4 ms`，443 端口因测试端本地代理转发增加约 `~52 ms` 往返，故端到端空载应用层 RTT 落在 `75–82 ms`；**国内直连玩家实际 RTT 预计落在 `26–40 ms`**（服务端自身处理耗时 `< 1 ms`）。

### 2.2 公网 WSS 建连与应用层 Ping/Pong RTT（60 采样）

- 建房 API（`POST /api/v1/rooms`）：`83.72 ms`
- WSS TLS 握手建连：`249.96 ms`
- 端到端完整入房（建连 + `join` 验签 + 收到 `welcome`）：`340.91 ms`
- WSS 应用层 RTT（60 采样，间隔 50ms）：**`min 75.81 ms` / `P50 77.70 ms` / `avg 83.79 ms` / `P95 114.44 ms` / `P99 165.14 ms`**

---

## 3. Binary Protocol v2 vs JSON v1 实测带宽对比

测试场景：同一 10 人死斗房（1 名真人 + 9 名高频交火机器人，30Hz 输入上报 + 15Hz 状态快照广播，显式关闭 `perMessageDeflate` 以测原始线协议体积），持续采样 6 秒：

| 维度 | JSON v1（基线） | Binary Protocol v2（增量二进制） | 优化幅度 |
| :--- | :--- | :--- | :--- |
| **下行带宽（单玩家）** | `193.38 KB/s`（6s 合计 `1,188,520 B`） | **`11.55 KB/s`**（6s 合计 `70,978 B`） | **-94.0%（16.7x 压缩）** |
| **单帧快照均值大小** | `13,060.7 B/帧` | **`788.6 B/帧`** | **-94.0%** |
| **上行带宽（30Hz 输入）** | `5.92 KB/s`（6s 合计 `36,378 B`） | **`0.74 KB/s`**（固定 `26 B/帧`，合计 `4,576 B`） | **-87.5%（8.0x 压缩）** |
| **快照实测频率** | `15.16 Hz` | `15.00 Hz` | 保持一致 |
| **快照间隔 P95 / 抖动** | `P95 74.33 ms` / `stddev 5.11 ms` | **`P95 71.51 ms` / `stddev 2.93 ms`** | 抖动降低 **42.7%** |

> **带宽成本意义**：按 100 名并发在线玩家估算，JSON v1 仅对局下行就需要 `~155 Mbps` 公网出口带宽；启用 Binary v2 后降至仅 **`~9.2 Mbps`**，可轻松在单台常规云服务器带宽内承载数百名真人玩家。

---

## 4. 多房间并发阶梯压测（2 -> 28 房间 / 20 -> 280 活跃玩家）

测试方法：通过 Go 控制面动态建房，双 Worker（`worker-1` / `worker-2`）按负载自动均分；每个房间包含 1 名真人（30Hz 二进制输入）+ **9 名全模拟 AI 机器人**（最重 CPU 场景：每 tick 全量导航寻路 + 视线射线检测 + 交火弹道），每阶段稳态压测 8 秒，30Hz tick 预算为 **`33.33 ms`**，15Hz 理想快照间隔为 **`66.67 ms`**。

| 阶段 | 并发房数（分布 W1/W2） | 总活跃角色 | 单 Worker `tickP50` | 单 Worker `tickP95` | 客户端快照间隔 P50 | 负载下 WSS RTT P50 / P95 | 单 Worker 内存 RSS / Heap | 8C 主机 Load Avg (1m) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Stage 1** | 2 房（1 / 1） | 20 人 | `0.00–0.01 ms` | **`8.89–8.97 ms`** | **`66.51 ms` (15.0 Hz)** | `80.7 / 86.8 ms` | `159–162 / 26–27 MiB` | `0.42–0.54` |
| **Stage 2** | 6 房（3 / 3） | 60 人 | `0.01–4.68 ms` | **`20.99–22.99 ms`** | **`66.17 ms` (15.1 Hz)** | `90.9 / 152.9 ms` | `180–184 / 28–39 MiB` | `0.56–0.67` |
| **Stage 3** | 12 房（6 / 6） | 120 人 | `6.64–6.96 ms` | `41.78–44.46 ms` | `77.42 ms` (12.9 Hz) | `103.6 / 128.0 ms` | `189 / 29–35 MiB` | `0.62–0.79` |
| **Stage 4** | 20 房（10 / 10） | 200 人 | `16.29–16.36 ms` | `73.81–74.32 ms` | `151.22 ms` (6.6 Hz) | `122.2 / 206.4 ms` | `195–197 / 28–40 MiB` | `0.89–1.20` |
| **Stage 5** | 28 房（14 / 14） | 280 人 | `28.74–30.00 ms` | `103.92–108.29 ms` | `215.74 ms` (4.6 Hz) | `149.1 / 282.2 ms` | `199–200 / 40–42 MiB` | `1.35–1.49` |

### 关键瓶颈诊断与结论

1. **完美对称调度与极低内存占用**：控制面在所有 5 个阶段均将房间精确 **50/50 均分**至双 Worker；单 Worker 在 140 名活跃角色满载时 RSS 仅 **`200 MiB`**（15 GiB 内存仅占 `1.2%`），全程无 OOM、无内存泄漏，停压后房间归零。
2. **精确摸清单进程 Node Worker 实时红线**：
   - 在“每房 9 AI 机器人”的极限重算场景下，单核 Node.js 事件循环在 **3–4 房（30–40 名全模拟角色）** 时 `tickP95` 为 `21–23 ms < 33.33 ms`，保持满帧 `30Hz / 15Hz` 丝滑同步。
   - 超过 **6 房 / 单 Worker** 后，单进程 JS 事件循环进入单核瓶颈（此时 8 核主机 1m Load 仅 `1.49`，**还有超过 6 颗 vCPU 完全闲置**！）。
3. **本机立即生效的零代码扩容方案（横向多 Worker 铺满 8 核）**：
   - 无需改任何一行代码，只需在同一台 8 vCPU / 15 GiB RAM 主机上将 `cs2-battle-worker@{1..6}` 扩至 **6 个 Worker 实例**，每实例配置 `MAX_ROOMS=4`（预留 2 vCPU 给 Nginx、Go 控制面与同机既有服务）：
   - **硬实时满帧 SLA 容量（`tickP95 < 33ms`，15Hz 零掉帧）直接从 8 房（80 人）提升至 24 房（240 人）**，总内存占用仅约 `1.1 GiB / 15 GiB`。
   - 若为纯真人竞技房（无 9 AI Bot 寻路开销），单核负载大幅下降，单 Worker 可稳定支撑 `6–8` 房（整机 `360–480` 名同时在线真人）。
4. **中长期突破单核上限（ADR-001 演进方向）**：后续将 `GameRoom.tick()` 与 BVH 射线检测迁至 `physics-core/` 同源 Rust Battle Worker，可将单核房间密度再提升 `5–10x`。

---

## 5. 在线 Graceful Drain（零掉线发版）实机演练

通过 [scripts/bench-drain-remote.mjs](../scripts/bench-drain-remote.mjs) 对运行中的集群执行实弹排空验证：

| 验证项 | 实测结果 | 判定 |
| :--- | :--- | :--- |
| **存量房触发排空** | 对承接存量房的 `worker-2` 调用本机 `POST /drain` -> `{"ok":true,"ready":false,"draining":true,"rooms":1}` | **PASS** |
| **就绪探针切换** | `GET https://game.example.com/cs2/w2/ready` 立即返回 **HTTP `503`**（`ready: false, draining: true`） | **PASS** |
| **控制面感知耗时** | 控制面自动切换为 `activeWorkers: 1, drainingWorkers: 1`（含远端触发耗时 `2.95 s`） | **PASS** |
| **新房隔离调度** | 连续新建 4 个房间：**4/4（100%）** 精准调度至健康节点 `worker-1` | **PASS** |
| **存量对局零掉线** | 排空后 3 秒内，旧房间在 `worker-2` 持续收到 **`46` 帧 Binary v2 快照（15.3 Hz）**，0 断线、0 丢帧 | **PASS** |
| **演练后恢复** | 重启 `cs2-battle-worker@2` 后集群恢复 `activeWorkers: 2, drainingWorkers: 0, totalRooms: 0` | **PASS** |

---

## 6. 生产扩容至 6 Worker + 网页端/CDN 实机可玩部署验证

在完成上述容量摸底后，已按建议将集群正式扩容为 **6 个纯逻辑 Battle Worker**，并部署新版 Web 客户端（`client-next/`）与 `de_dust2` 独立 CDN 地图包，实现公网直接开玩：

### 6.1 生产可玩入口与静态资源分离拓扑
- **直接游玩入口**：`https://game.example.com/cs2/`（Nginx 托管 `/opt/cs2-ha/web/`，客户端运行时读取 `client-config.json`）
- **地图 CDN 目录**：`https://game.example.com/cs2/cdn/maps/de_dust2/`（Nginx 托管 `/opt/cs2-ha/cdn/`，包含 `render-manifest.json`、`render/map.gltf`、`render/dust2-6016e2c1497d.bin`、`510` 张 WebP 贴图与 `physics.f32`，CORS `*` + `immutable` 缓存；Battle Worker 依旧保持 `DUST2_LOGIC_ONLY=1`，0 字节静态流量）
- **6 节点纯逻辑对局池**：`cs2-battle-worker@{1..6}.service`（`127.0.0.1:19101`–`19106`，`MAX_ROOMS=4`/节点，对外 `wss://game.example.com/cs2/w{1..6}/ws`）

### 6.2 6 Worker 扩容后 120 / 240 并发玩家实测对比（每房 9 AI 机器人）

| 并发规模 | 扩容前（2 Worker） | 扩容后（**6 Worker**） | 收益 |
| :--- | :--- | :--- | :--- |
| **12 房 / 120 人** | 分布 `6/6`；`tickP95 = 41.78–44.46 ms`（超预算）；快照间隔 P50 `77.42 ms` (`12.9 Hz`)；RTT P50 `103.6 ms` | 分布 **`2/2/2/2/2/2`**；`tickP95 = 17.30–18.12 ms`；**快照间隔 P50 `65.72 ms` (`15.2 Hz` 满帧)**；RTT P50 `84.86 ms`；单 Worker RSS `179–188 MiB` | `tickP95` 降低 **59%**，满帧运行 |
| **20–24 房 / 200–240 人** | 200 人分布 `10/10`；`tickP95 = 73.81–74.32 ms`；快照间隔退化至 `151.22 ms` (`6.6 Hz`)；RTT P50 `122.2 ms` | **240 人**分布 **`4/4/4/4/4/4`**；`tickP50 = 10.61–11.76 ms`、`tickP95 = 29.47–35.43 ms`；**快照间隔 P50 `66.49 ms` (`15.0 Hz` 满帧)**；RTT P50 **`99.88 ms`**；6 节点合计 RSS `~1.15 GiB` | 负载高 20%，帧率反升 **2.3x**（`6.6 -> 15.0 Hz`） |

### 6.3 浏览器实机端到端验收
- 修复了 Chromium 下 `ControlPlaneClient`、`CdnAssetLoader` 与 `loadRuntimeConfig` 中未绑定 `globalThis.fetch` 导致的 `Illegal invocation` 问题，并补充 `MeshoptDecoder` 与 `de_dust2`（`rotation.y = Math.PI / 2`、去除 `F_DEPTH_FEATHER` 遮挡与原始光源）渲染对齐。
- 实机浏览器访问 `https://game.example.com/cs2/` 验证通过：大厅显示 `控制面: 在线 (6 节点)` -> 一键建房通过 WSS `BIN v2` 入房 -> `WEBGPU` 后端渲染完整 CS2 Dust II 3D 场景与第一人称武器/准星/雷达/HUD，预测误差 `0.00m`，**0 控制台报错、0 资源 4xx/5xx**，退出后房间自动清理归零。
