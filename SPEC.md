# DUSKRAIN (cs2-web) 高可用、高并发与前后端彻底分离演进规范 (Living Spec)

> 本文档是服务端架构改造、资产逻辑解耦与网页端技术栈升级的单一事实来源（Single Source of Truth）。每完成一个阶段，须同步更新状态表与验证证据。

- **文档版本**：`v1.0.0`
- **最后更新**：`2026-11-26`
- **最终锁定路线（ADR-001）**：**网页端（TypeScript + Three.js WebGPU/WebGL2 + SolidJS + Rust/WASM 物理核） + Go 控制面（+ Redis） + 纯逻辑 Battle Worker（Node 过渡 -> Rust 目标）**
- **关联设计文档**：
  - [高可用总体架构设计](docs/HA-ARCHITECTURE.md)
  - [Go 控制面与节点调度规约](docs/CONTROL-PLANE-SPEC.md)
  - [Web 客户端重构与技术栈迁移规约](docs/WEB-CLIENT-MIGRATION-SPEC.md)
  - [B站 Toy 平台交付与 SDK 集成规约](docs/TOY-DELIVERY-SPEC.md)
  - [二进制增量协议 v2 与 WASM ABI 规约](docs/PROTOCOL-V2-SPEC.md)
  - [本地与生产高可用集群运维手册](docs/LOCAL-CLUSTER-RUNBOOK.md)
  - [生产集群实机部署与性能压测报告](docs/BENCHMARK-CLUSTER.md)
  - [当前在线协议基线 v1](server/PROTOCOL.md)

---

## 1. 架构核心目标（不可妥协约束）

1. **所有静态资产彻底客户端化 / CDN 化**
   - 地图渲染模型（`render/map.gltf`、`map.bin`）、贴图、天空盒、武器/刀具/皮肤/探员/手臂模型（`.glb`）、音乐盒（`.mp3`）、雷达底图（`.png`）、预览图、Web 前端壳子（HTML/JS/CSS/WASM）**100% 由 CDN/OSS 分发**。
   - 客户端本地预测/碰撞用几何文件（`map.json`、`physics.f32`、`physics-mask.u8`、`physics-groups.json`、`entity-collision-policy.json`）也由 CDN 校验加载，不再由对局逻辑服承担大文件下行流量。
2. **服务端纯逻辑化（Logic-Only Battle Server）**
   - 对局节点仅加载逻辑碰撞与寻路运行集（实测 9 图合计 **344.44 MiB**，代码 **1.43 MiB**，**0 个**渲染模型、贴图、音频或 HTML 文件）。
   - 支持显式 `DUST2_LOGIC_ONLY=1` 与 `DUST2_SERVE_MAP_FILES=0`：关闭一切静态资源 HTTP 服务，只暴露 `/ws`、`/health`、`/ready`（及内部 `/room-directory.json`、`/private-map.json`）。
3. **控制面与数据面分离，消除单点网关代理**
   - **控制面（Go + Redis）**：无状态大厅、全局房间目录、节点健康度与 Warm Pool 调度、签发 HMAC `JoinToken`。
   - **数据面（Battle Workers）**：有状态 30Hz/64Hz 权威模拟节点。客户端拿到 `JoinToken` 和节点 `wsUrl` 后跨源直连对局节点，不再经由单点网关 `net.connect` 代理全站长连接。
4. **生产级高可用生命周期**
   - 严格区分存活检查（`/health`）与就绪/接流检查（`/ready`）。
   - 支持 **优雅排空（Graceful Drain）**：收到下线指令后 `/ready` 立即返回 `503`，控制面停止向该节点调度新房，新 `join` 返回 `SERVER_DRAINING`，存量对局自然结束零掉线。

---

## 2. 边界契约（Asset vs Logic Contract）

| 维度 | Web 客户端 / CDN 职责 | 服务端（Go 控制面 + Battle Worker）职责 |
| :--- | :--- | :--- |
| **3D 渲染与特效** | Three.js（WebGPU 优先 / WebGL2 兜底）渲染地图 GLTF、武器/探员 GLB、粒子、弹道特效与音频 | 无（仅下发 `shot`/`hit`/`kill`/投掷物事件 ID 与坐标） |
| **UI 与大厅壳** | SolidJS + TypeScript 驱动大厅、商店、装备库、记分板、雷达与触控布局 | Go 控制面提供 `/api/v1/rooms` 等 REST API；对局内状态由 Worker 下发 |
| **物理与预测** | CDN 加载并校验 `physics.f32`；通过 `PhysicsKernel`（TS 过渡 -> Rust/WASM）本地预测与插值 | Battle Worker 加载只读 `physics.f32`、`nav.json`、`navigation-audit.json` 做权威步进、延迟补偿与 Bot 寻路 |
| **鉴权与防作弊** | 携带 `JoinToken` 跨源直连 Worker WSS；30Hz 上报输入采样 | Go 签发有时效 HMAC `JoinToken`；Worker 校验武器/经济/C4 规则并按阵营裁剪快照（`snapshotForSide`） |

---

## 3. 已锁定的技术栈选型（ADR-001 · Web 版）

- **Web 客户端**：`TypeScript` + `Vite` + `Three.js`（WebGPU 渲染器优先，WebGL2 自动回退）+ `SolidJS`（HUD/菜单）+ `Rust/WASM`（确定性物理与碰撞预测内核，由 `PhysicsKernel` 接口解耦）
- **控制面服务**：`Go (1.27)`（无状态 HTTP/REST + HMAC JoinToken + Worker 调度）+ `Redis / Valkey`（本地可先用内存 `Store` 跑通单测与联调）
- **对局逻辑服**：
  - **Phase 2 联调期**：使用已完成纯逻辑剥离的 Node.js Battle Worker（支持 `DUST2_LOGIC_ONLY=1`、`/ready`、`/drain`、CORS/WS Origin 白名单 + 新增 `JoinToken` 校验与心跳上报）。
  - **Phase 3 性能升级期**：将对局引擎升级为 **Rust（Tokio + 共享 BVH + 二进制增量快照 / WebTransport）**，与浏览器端 WASM 共用同一份物理 crate。

---

## 4. 服务端运行模式与接口契约

### 4.1 Node Battle Worker 环境变量（Phase 1 已落地）

| 变量名 | 默认值 | 含义 |
| :--- | :--- | :--- |
| `DUST2_LOGIC_ONLY` | `0` | 设为 `1` 时禁用 `dist/`、`public/`、HTML 等静态资源 HTTP 服务 |
| `DUST2_SERVE_MAP_FILES` | `1` | 设为 `0` 时禁用 `private-map` 的地图几何文件 HTTP 下载（强制走 CDN），保留轻量 `/private-map.json` 签名元数据 |
| `DUST2_ALLOWED_ORIGINS` | 空（同源） | CORS 与 WebSocket `Origin` 白名单（逗号分隔或 `*`），允许无 `Origin` 原生/测试客户端 |
| `DUST2_DRAIN_TOKEN` | 空 | 启用后支持 `POST /drain`（Bearer Token 鉴权）触发优雅排空；同时支持 `SIGUSR2` 与程序化 `beginDrain()` |
| `PERF_MAP_BASE_URL` | 空 | 九图网关下发给客户端的 `mapBaseURL`（回退读取 `DUSTII_MAP_DOWNLOAD_BASE`） |
| `PERF_DISABLE_LOCAL_ASSETS` | `0` | 设为 `1` 时禁止网关吐出任何本地资产/地图/雷达/预览图，并清空本地皮肤/音乐回源标记 |
| `PERF_LOGIC_GATEWAY_ONLY` | `0` | 设为 `1` 时禁用网关所有 HTML 与 `mode-ui` 页面，仅留控制 JSON API 与 WS |
| `PERF_MAX_WORKERS` | `2` | 九图网关最大并发子进程数上限（1–32） |

### 4.2 健康检查与优雅排空端点

- `GET /health`：始终返回 `200 OK`，包含 `ready`、`draining`、`logicOnly`、`serveMapFiles`、`rooms`、`humans`、`memory`、`performance`。
- `GET /ready`：正常接流返回 `200 OK`；`draining === true` 时返回 `503 Service Unavailable`。
- `WS /ws`：排空时存量房间继续运行，新 `join` 报错 `SERVER_DRAINING`，`listRooms` 返回 `joinable: false`。

---

## 5. 分阶段实施路线与状态追踪（Living Checklist）

| 阶段 | 目标 | 关键交付项 | 当前状态 | 验证结果 |
| :--- | :--- | :--- | :--- | :--- |
| **Phase 0** | 现状基线与架构规约 | 梳理现网瓶颈，建立 `SPEC.md` 与 `docs/HA-ARCHITECTURE.md` | **Done** | 已核实全量入口、端口与资产清单 |
| **Phase 1** | 资产逻辑解耦 & 纯逻辑服务模式 | 1. `server/index.js` 支持 `logicOnly`、`serveMapFiles`、`allowedOrigins`、`/ready`、`/drain` 与 `beginDrain()`<br>2. `server/private-map-server.js` 透传纯逻辑参数<br>3. `server/performance-maps.js` 修复 `mapBaseURL` 并支持纯 CDN 模式<br>4. `scripts/verify-logic-split.mjs` 资产/逻辑边界审计脚本<br>5. `tests/logic-only-server.mjs` 自动化测试 | **Done** | `npm run logic:check` 通过（Logic 181 文件/345.87 MiB，0 渲染音频文件；Client 4,714 文件/2,667.19 MiB）；定向 108 项测试 **108/108 全部通过** |
| **Phase 2** | Go 控制面 + 房间调度与 Token 鉴权 | 1. 编写 `docs/CONTROL-PLANE-SPEC.md` 与 `docs/WEB-CLIENT-MIGRATION-SPEC.md`<br>2. 实现 Go 控制面（`control-plane/`）：HMAC `JoinToken`、Worker 注册/心跳/排空感知、按地图负载分配房间、全局房间目录、CORS、**零依赖 RESP2 `RedisStore` 多副本共享存储**<br>3. 实现 `server/join-token.js` 与 `server/control-plane-client.js`，接入 `server/index.js` 实现无状态 Token 验签、防重放（`usedJTIs`）与单飞合流心跳上报<br>4. 端到端联调测试 `tests/control-plane-integration.mjs` 与 `redis_test.go` | **Done (Memory + Redis)** | Go `go test -v -race ./...`（含 `TestRedisStoreMultiReplicaSharingAndDrain`）与 `go vet` / `go build` 全通过；`control-plane-integration.mjs` 跨进程验证通过 |
| **Phase 3** | Web 新技术栈客户端建设 (`client-next/`) | 1. **Phase 3A（已完成）**：Vite 8 + TS + SolidJS 1.9 + Three.js WebGPU/WebGL2 骨架、`ControlPlaneClient`、`GameSocketClient`、`PhysicsKernel`/`TSPhysicsKernel`<br>2. **Phase 3B（已完成）**：[docs/TOY-DELIVERY-SPEC.md](docs/TOY-DELIVERY-SPEC.md)、Rolldown `vendor-three`/`vendor-solid` 拆包、`toy-sdk.ts`（`307044` 指数退避/零轮询）、`cdn-loader.ts`（SHA-256 + CacheStorage + GLTF/physics）、`FpsInputController` + `PredictionReconciler`<br>3. **Phase 3C（已完成）**：战术商店 `BuyMenu`（买/退/丢枪）、旋转/北向小地图 `Radar`、第一人称 `FirstPersonRig` Viewmodel + 弹道曳光、战况面板 `Scoreboard` + 人机接管、移动端 `TouchControls` 与 WebAudio 程序化音效 `TacticalAudio`<br>4. **Phase 3D（已完成）**：二进制增量协议 v2（`shared/binary-protocol.js` + `client-next/src/net/binary-protocol.ts` + `server/index.js` 混排支持）、`WasmPhysicsKernel` ABI 桥与 `physics-core/` Rust 物理核心 crate | **Done** | `tsc --noEmit` 0 错；`client-next` **11/11 单测通过**；`vite build` 拆包产出 `index.html` (`0.58 kB`) + app (`19.52 kB` gzip) + `vendor-solid` (`5.18 kB` gzip) + `vendor-three` (`243.34 kB` gzip)；**`toy_doctor.py` 0 ERROR / 0 WARN**；`binary-protocol-v2.mjs` 等 **33/33 Node 集成测试全通过**；注：本机未装 `rustc`，`physics-core/` 源码与 WASM 桥已就位待 CI 编译 |
| **Phase 4** | 高可用集群运维与生产部署 | 1. Go 控制面 `RedisStore`（通过 `REDIS_ADDR` 切换多副本共享状态）<br>2. 一键本地高可用集群联调脚手架 `npm run dev:ha`（[scripts/dev-ha-cluster.mjs](scripts/dev-ha-cluster.mjs)）<br>3. 生产容器与 K8s 编排模板：`deploy/ha/Dockerfile.control-plane`、`Dockerfile.battle-worker`、`k8s-deployment.yaml`（含 `/ready` 探针与 `preStop SIGUSR2` 零掉线排空）与 [docs/LOCAL-CLUSTER-RUNBOOK.md](docs/LOCAL-CLUSTER-RUNBOOK.md)<br>4. 目标生产机（`game.example.com`）隔离部署（`/opt/cs2-ha/` + systemd + HTTPS/WSS Nginx `/cs2/`）与真实压测（[scripts/bench-remote.mjs](scripts/bench-remote.mjs)、[scripts/bench-drain-remote.mjs](scripts/bench-drain-remote.mjs)、[docs/BENCHMARK-CLUSTER.md](docs/BENCHMARK-CLUSTER.md)） | **Done (Deployed & Benchmarked)** | `RedisStore` 双副本测试与 `logic:check` 全通过；实测 Go CP 本机 `2,838 QPS`（建房签发 P50 `0.52ms`）、Binary v2 下行省 **94.0%**（`11.55` vs `193.38 KB/s`）/ 上行省 **87.5%**、20–280 人阶梯压测摸清单核 SLA 红线（4 房/Worker；8C 主机扩 6 Worker 可满帧承载 240 人）、在线 Graceful Drain 100% 切流且存量房 0 掉线 |

---

## 6. 变更与验证日志

- `2026-11-26`：
  - 完成 Phase 1 全部验证：`npm run logic:check` 校验通过，`tests/logic-only-server.mjs` 等 108 项服务端与 CDN 回归测试 **108 pass / 0 fail**。
  - 根据确认锁定 **Web 版演进路线（ADR-001）**：客户端 `TS + Three.js WebGPU/WebGL2 + SolidJS + Rust/WASM`，控制面 `Go + Redis`，对局服 `Node Logic Worker (过渡) -> Rust (目标)`。
  - 新增 [docs/CONTROL-PLANE-SPEC.md](docs/CONTROL-PLANE-SPEC.md) 与 [docs/WEB-CLIENT-MIGRATION-SPEC.md](docs/WEB-CLIENT-MIGRATION-SPEC.md)。
  - 完成 Phase 2A：落地 `control-plane/` Go 服务骨架（`internal/token`、`internal/store`、`internal/api`、`cmd/control-plane`），通过 `go test -v -race ./...`、`go vet ./...` 与编译验证。
  - 完成 Phase 2B：实现 [server/join-token.js](server/join-token.js) 与 [server/control-plane-client.js](server/control-plane-client.js) 并接入 [server/index.js](server/index.js)；通过 `tests/control-plane-integration.mjs` 真机编译 Go 控制面 + 双 Node Battle Worker 跨进程端到端验证（31/31 测试全部通过）。
  - 完成 Phase 3A：建立 [client-next/](client-next/README.md) 工程（`Vite 8 + TypeScript + SolidJS 1.9 + Three.js 0.185 WebGPURenderer`），通过 `tsc --noEmit`、`node --experimental-strip-types --test`（4/4 pass）、`vite build`（77 模块，`266ms`）以及 `npm run logic:check` 边界校验。
  - 完成 Phase 3B：新增 [docs/TOY-DELIVERY-SPEC.md](docs/TOY-DELIVERY-SPEC.md)，完成 `vite.config.ts` Rolldown `vendor-three`/`vendor-solid` 拆包、Toy SDK 桥（`src/platform/toy-sdk.ts`）、CDN 校验地图加载器（`src/assets/cdn-loader.ts`）、第一人称 Pointer Lock（`src/input/fps-controller.ts`）及 `PredictionReconciler` 预测调和（`src/physics/reconciliation.ts`）；通过 `tsc --noEmit`、7/7 单元测试、`vite build`（`index.html 0.58 kB`，业务 chunk `12.98 kB` gzip）、`toy_doctor.py`（`ok: true`, `0` 警告）与 `npm run logic:check`。
  - 完成生产机（`game.example.com`）正式 **6 Worker 扩容 + 网页端/CDN 实机可玩部署**与复测（[docs/BENCHMARK-CLUSTER.md](docs/BENCHMARK-CLUSTER.md) §6）：
    - 扩容至 `cs2-battle-worker@{1..6}.service`（`19101`–`19106`，`MAX_ROOMS=4`），Nginx 托管 `/opt/cs2-ha/web/` 与 `/opt/cs2-ha/cdn/maps/de_dust2/`（`52 MB` 压缩包，含 `510` 张 WebP 贴图、`dust2-6016e2c1497d.bin`、`physics.f32` 与 SHA-256 `render-manifest.json`），公网直接可玩地址：`https://game.example.com/cs2/`。
    - 修复 Chromium 下未绑定 `globalThis.fetch` 的 `Illegal invocation`，为 `CdnAssetLoader` 补齐 `MeshoptDecoder`、`de_dust2` 90° 对齐及阳光环境光；浏览器实机验证 `控制面: 在线 (6 节点)`、`WEBGPU` + `BIN v2` + Dust II 3D 渲染 **0 报错 / 0 资源 404**。
    - 6 Worker 复测压测：12 房/120 人 `tickP95` 从 `44.5 ms` 降至 **`17.3–18.1 ms`**；24 房/240 人精确 `4/4/4/4/4/4` 均分，快照间隔稳定 **`66.49 ms`（15.0 Hz 满帧）**，6 节点总内存仅 `~1.15 GiB`。
  - 完成生产机（`game.example.com`）实机隔离部署与性能/延迟/排空全链路压测（[docs/BENCHMARK-CLUSTER.md](docs/BENCHMARK-CLUSTER.md)）：
    - 在 `/opt/cs2-ha/` 部署 `cs2-control-plane.service` + `cs2-battle-worker@{1,2}.service` + `/etc/nginx/snippets/cs2-ha.conf`（`https://game.example.com/cs2`，有效 TLS 证书，CORS 放行 `https://www.bilibilitoy.com`，零影响同机既有服务）。
    - 实测 Go 控制面本机 `2,838 QPS`、建房签 Token P50 `0.52 ms`；Binary v2 较 JSON v1 下行带宽降低 **94.0%**（`11.55 KB/s` vs `193.38 KB/s`）、上行降低 **87.5%**（`0.74 KB/s` vs `5.92 KB/s`）、快照抖动降 `42.7%`。
    - 20–280 并发角色阶梯压测确认单 Node Worker 9-Bot 满帧 SLA 红线为 `3–4 房`（`tickP95 < 33.33 ms`），280 人峰值时 8C 主机 Load 仅 `1.49`、单 Worker RSS `200 MiB`；在线 Graceful Drain 实测 `/ready` 即刻 `503`、新房 `4/4` 切流健康节点、存量房 3s 持续收帧 `46` 帧零掉线。
  - 完成 Phase 3C / 3D / 4 全链路实施：
    - 新增 [docs/PROTOCOL-V2-SPEC.md](docs/PROTOCOL-V2-SPEC.md) 与 [docs/LOCAL-CLUSTER-RUNBOOK.md](docs/LOCAL-CLUSTER-RUNBOOK.md)。
    - 客户端补齐 `BuyMenu`、`Radar`、`Scoreboard`、`TouchControls`、`FirstPersonRig` Viewmodel/曳光弹、`TacticalAudio`、`BinarySnapshotDecoder` 与 `WasmPhysicsKernel` ABI 桥（`client-next` 11/11 单测通过，`vite build` 产出 app `19.52 kB` gzip，`toy_doctor.py` **0 ERROR / 0 WARN**）。
    - 服务端 [shared/binary-protocol.js](shared/binary-protocol.js) 与 [server/index.js](server/index.js) 支持 v2 二进制 26B 输入与 Full/Delta 快照，并与 v1 JSON 客户端同房兼容（`tests/binary-protocol-v2.mjs` 等 33/33 测试通过）。
    - Go 控制面新增零依赖 RESP2 [redis.go](control-plane/internal/store/redis.go) 与双副本测试 [redis_test.go](control-plane/internal/store/redis_test.go)（`go test -v -race ./...` 全通过）；新增 `physics-core/` Rust 物理核心、`npm run dev:ha` 本地集群启动器与 `deploy/ha/` Docker/K8s 部署模板。
- `2026-11-25`：初始化 `SPEC.md` 与 `docs/HA-ARCHITECTURE.md`，实现 Phase 1 纯逻辑服务端、CORS、`/ready` 与优雅排空改造。
