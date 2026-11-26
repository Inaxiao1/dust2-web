# DUSKRAIN 高可用、高并发后端架构与客户端选型设计

本文档对应 [SPEC.md](../SPEC.md) 的工程架构细节说明，面向 **数千至上万并发玩家、多地图动态扩容、前后端彻底分离** 的生产环境改造。

---

## 1. 现状架构瓶颈诊断

对照当前仓库代码，现有实现主要存在以下 5 个扩展性与可用性瓶颈：

1. **单机子进程硬限制与冷启动抖动**
   - [server/performance-maps.js](../server/performance-maps.js) 中硬编码 `maxWorkers = 2`，重内存地图（`de_inferno`、`de_cache`、`de_ancient`、`de_train`）独占槽位；每张地图仅允许 `maxRooms = 1`（[server/private-map-server.js](../server/private-map-server.js)）。
   - 子进程按需冷启动加载碰撞与导航审计，超时上限高达 75 秒，空闲 120 秒即被 `kill()` 销毁。
2. **网关单点与 WebSocket 二次代理瓶颈**
   - 所有用户的 HTTP、静态资产和 `/ws` 流量都穿过单个 `performance-maps.js` 进程，通过 `net.connect` 透传到本地子进程。
   - 网关无法横向扩容多实例，一旦重启或 OOM，全站所有在局连接瞬间中断。
3. **单事件循环串行推进多房间**
   - [server/index.js](../server/index.js) 在主事件循环内用单个 `setInterval` 串行执行所有房间的 `room.tick(1/30)`、Bot AI 和 `JSON.stringify` 快照广播。物理射线检测或 AI 寻路毛刺会直接拖慢同进程其他房间。
4. **资产与逻辑未彻底隔离**
   - [server/performance-maps.js](../server/performance-maps.js) 第 220 行将 `mapBaseURL` 硬编码为 `null`，导致地图文件与高画质渲染包仍走游戏网关磁盘读取；[client/download-origin.js](../client/download-origin.js) 在检测到 `localSkinPaths` 等字段时会把外观资源流量拉回游戏服。
5. **全量 JSON 快照序列化开销**
   - 15Hz 广播全量房间快照 + `perMessageDeflate` 在房间内满员（10 人）时 CPU 占用较高，且缺乏 Delta 增量压缩。

---

## 2. 目标三平面高可用架构

```text
                       ┌────────────────────────────────────────────────────┐
                       │         Plane 1: 边缘静态资产与客户端层 (CDN/OSS)    │
                       │  · 新技术栈客户端包 / Web App / Android / PC 端      │
                       │  · 九图渲染包 (GLTF/BIN/HDR/Sky) & 客户端碰撞包       │
                       │  · 216款武器皮肤 / 探员 / 13套音乐盒 / 雷达 / 预览图  │
                       └─────────────────────────┬──────────────────────────┘
                                                 │ HTTPS (Immutable Cache + SHA256)
                                                 ▼
                       ┌────────────────────────────────────────────────────┐
                       │       Plane 2: 无状态控制面 (Lobby / Matchmaking)    │
                       │  · 多副本 HTTP API + L7 负载均衡 (Nginx / ALB)       │
                       │  · 全局房间目录 / 建房调度 / 节点选择 / 限流鉴权      │
                       │  · 签发短时 JoinToken (roomId, workerUrl, exp, sig) │
                       └──────────────┬────────────────────────┬────────────┘
                                      │                        │
                                      ▼                        ▼
                       ┌─────────────────────────┐    ┌─────────────────────┐
                       │   Redis / Valkey 集群    │    │  Prometheus/Grafana │
                       │ · rooms:{code} (Hash)   │    │ · tick_duration_p99 │
                       │ · workers:{id} (TTL)    │    │ · active_rooms      │
                       │ · map_pool:{mapId}      │    │ · ws_connections    │
                       └──────────────┬──────────┘    └─────────────────────┘
                                      │ 心跳 / 房间上报 / Drain 状态同步
                                      ▼
                       ┌────────────────────────────────────────────────────┐
                       │      Plane 3: 有状态纯逻辑对局层 (Battle Workers)     │
                       │  · 仅加载 server/ + shared/ + compiled 逻辑碰撞/nav  │
                       │  · 零 HTML/JS/贴图/音频文件分发                      │
                       │  · 单核隔离 (1 Pod/进程 对应 1~N 个固定地图房间)     │
                       │  · 支持 Warm Pool 预热池与 Graceful Drain 零掉线发布 │
                       └────────────────────────────────────────────────────┘
```

### 2.1 三平面职责边界

1. **Plane 1 — 静态资产与客户端平面（0 业务服务器带宽）**
   - 所有客户端代码、地图视觉模型、贴图、武器模型、皮肤、探员、音频全部通过内容哈希（SHA-256）发布至对象存储（R2 / OSS / S3）+ CDN。
   - **关键要求**：游戏逻辑服务器完全不存放、不读取、不分发展示层资源；客户端升级与资产热更只需更新 CDN Manifest。

2. **Plane 2 — 无状态控制面（Control Plane）**
   - 负责公开大厅聚合（替代现网跨进程 HTTP 轮询 `/room-directory.json`）、房间码路由、玩家匹配、跨服防刷限流。
   - **调度流程**：
     1. 玩家点击「创建房间（地图 `de_mirage`）」或「加入房间 `AB12CD`」。
     2. 控制面查询 Redis 中对应地图的 `Warm Pool` 或健康 Worker 列表，选择 `tick_p99` 最低且未 `draining` 的节点。
     3. 控制面在 Redis 预占房间路由记录，并签发带 HMAC 签名的 `joinToken` + 目标节点公网直连地址（`wss://edge-node-03.example.com/ws`）。
     4. 客户端直接建立到目标对局节点的 WebSocket（或未来 WebTransport/UDP）连接，彻底消除中心网关代理瓶颈。

3. **Plane 3 — 纯逻辑对局平面（Battle Workers）**
   - **最小镜像体积**：仅打包 Node/Logic 运行时 + `server/` + `shared/` + 地图 `compiled/`（`physics.f32`、`physics-mask.u8`、`physics-groups.json`、`nav.json`、`navigation-audit.json`、`entity-collision-policy.json`）。
   - **CPU 隔离模式**：
     - 方案 A（推荐用于 K8s / 容器）：每个 Worker 容器分配 1 vCPU，单进程承载 1 张已预加载地图的 `1~4` 个房间（复用进程内同一份只读物理 BVH 内存，极度省内存，同时隔离 CPU）。
     - 方案 B（裸金属/大虚机）：主调度进程通过 `worker_threads` 为每个房间或每张地图分配独立线程。
   - **优雅排空（Graceful Drain）**：
     - 发布或缩容收到 `SIGTERM` / `POST /drain` 时：Worker 进入 `draining = true` -> `/ready` 立即返回 `503` -> Redis 中标记为不可调度 -> 拒接新房请求（`SERVER_DRAINING`） -> 存量对局正常打完并自然销毁后进程安全退出。

---

## 3. 通信协议演进路径（v1 -> v2）

| 维度 | 当前 Protocol v1 | 目标 Protocol v2（高并发版） |
| :--- | :--- | :--- |
| **建连鉴权** | 直接 WS `join` 传明文设置 | 控制面 HTTP 鉴权后签发 `joinToken`（含 `roomId`、`mapId`、`userId`、`exp`），Worker 本地无状态验签即可接流 |
| **传输通道** | WebSocket + JSON 文本 + `perMessageDeflate` | **Web端**：WebSocket Binary / WebTransport (QUIC)<br>**原生端**：ENet UDP / QUIC（或 WS Binary 兼容） |
| **状态同步** | 15Hz 全量 JSON 快照 | 20–30Hz **二进制位打包 + Delta 增量快照**（只发变动玩家/血量/位置量化整数），减少 60%+ CPU 与带宽 |
| **防作弊裁剪** | 已有 `snapshotForSide`（T/CT 阵营隔离） | 保留阵营隔离并进一步引入空间 PVS（Potentially Visible Set）裁剪，阻断透视外挂数据来源 |

---

## 4. 客户端技术栈换型决策

既然目标是**“所有地图、武器和渲染资源全部放在客户端，服务端只做纯逻辑计算”**，客户端技术栈的选型取决于产品定位（**网页即点即玩** vs **独立安装包原生端**）：

### 方案对比矩阵

| 候选技术栈 | 渲染与帧率上限 | 安装门槛 / 传播力 | 跨平台能力 (PC + 手机) | 与现有资产/物理复用度 | 综合评估 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A. Godot 4 (C# / GDScript + Forward+/Mobile 渲染器)** | 原生 Vulkan / Metal / DX12，轻松跑满 **120–240 FPS**；支持 WebAssembly 导出兜底 | 需下载安装包（或微端），启动后秒进对局 | Windows / macOS / Linux / Android / iOS 一套工程全覆盖 | **极高**：原生支持 `.glb`/`.gltf` 直接导入，九图资产可直接复用；C# 性能强、生态成熟 | **原生端首选（性价比最高）** |
| **B. TypeScript + Three.js (WebGPU 优先) + SolidJS + Rust/WASM** | WebGPU 相比 WebGL2 DrawCall 提升数倍，桌面稳跑 **120+ FPS** | **零安装点开即玩**，保留网页 URL 邀请裂变的最大优势 | 浏览器全平台 + Capacitor/Tauri 壳包桌面与手机 | **100% 平滑迁移**：直接继承现有 GLTF/GLB/Transport 分块解压与 `physics.f32` 管线；WASM 可同时给 Node/Rust 服务端复用 | **继续做网页端首选** |
| **C. Unity (C# + URP)** | 极其成熟的工业级 FPS 管线、现成动画状态机/IK/粒子/音频插件 | 需下载安装包，WebGL 包体偏重且启动慢 | PC / iOS / Android 生态最完善 | 高（需 GLTFast 插件导入现有 `.glb` 模型，物理转 PhysX） | 团队已有 Unity 熟手时优先 |
| **D. Rust + Bevy** | 极低内存与最高原生性能，可编译至 WebGPU/WASM | 零运行时负担 | 全平台支持但移动端输入法/UI/音频适配工作量偏大 | 高（ECS 架构完美契合 FPS 预测，服务端可直接共用 Rust 逻辑 crate） | 适合强 Rust 工程团队，前期 UI 开发成本高 |

### 推荐结论（ADR-001 已锁定：Web 版演进路线）

项目已确定采用 **Web 版演进路线（保留“打开链接即开打”的核心分发优势，同时前后端彻底分离）**：
- **Web 客户端**：**TypeScript + Three.js（WebGPU 优先，WebGL2 兜底）+ SolidJS HUD + Rust/WASM 物理核心**，构建产物 100% 发布至 CDN。具体工程结构见 [Web 客户端迁移规约](WEB-CLIENT-MIGRATION-SPEC.md)。
- **控制面服务**：**Go + Redis/Valkey**（无状态大厅、节点调度、HMAC `JoinToken` 签发），详见 [Go 控制面规约](CONTROL-PLANE-SPEC.md)。
- **对局逻辑服**：**过渡期**使用已完成资产剥离的纯逻辑 Node Battle Worker 对接 Go 控制面；**目标期**升级为 **Rust（Tokio + 共享 BVH + 二进制增量协议）**，与浏览器 WASM 共用同一套物理内核 crate。

---

## 5. 资产与逻辑最小目录清单（Phase 1 基线）

通过脚本 `node scripts/verify-logic-split.mjs` 自动审计，严格划分打包边界：

### 服务端逻辑运行镜像仅需包含：
- `server/*.js`
- `shared/*.js`（仅引用纯数值、碰撞、规则逻辑，不打包贴图/模型二进制）
- `artifacts/performance-maps/maps-v1/catalog.json`
- `artifacts/performance-maps/maps-v1/<mapId>/READY.json`
- `artifacts/performance-maps/maps-v1/<mapId>/navigation-audit.json`
- `artifacts/performance-maps/maps-v1/<mapId>/entity-collision-policy.json`
- `artifacts/performance-maps/maps-v1/<mapId>/compiled/`（`map.json`、`nav.json`、`physics.f32`、`physics-mask.u8`、`physics-groups.json`）
- （可选兼容旧沙二入口）`public/assets/map/collision.json`、`public/assets/map/penetration-materials.u8`

### 客户端 / CDN 独立发布目录：
- `dist/`（构建后的前端壳）
- `public/assets/`（全部武器、皮肤、探员、手臂、音乐盒音频，除旧版 `map/` 逻辑文件外）
- `artifacts/performance-maps/maps-v1/<mapId>/render*`、`radars/`
- `artifacts/performance-maps/quality-library/`、`quality-transport/`
- `scripts/maps/mode-ui/`、`scripts/maps/mode-previews/`
