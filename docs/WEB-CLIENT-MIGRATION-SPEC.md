# Web 新技术栈客户端设计及迁移规约 (Client Migration Spec)

> 对应 [SPEC.md](../SPEC.md) Phase 3。目标是将当前分散在 `client/` 的无类型原生 JS + DOM 拼接重构为 **纯静态、CDN 托管、可预测与可测试的现代 Web 游戏客户端**。

---

## 1. 目标技术栈

| 模块 | 选型 | 说明 |
| :--- | :--- | :--- |
| **语言与构建** | **TypeScript + Vite** | 严格类型检查与共享协议 Schema 约束，产物纯静态发布至 CDN/OSS |
| **3D 渲染引擎** | **Three.js（WebGPU 优先，WebGL2 自动兜底）** | 利用 `WebGPURenderer` 降低复杂地图（如炼狱小镇/核子危机）Draw Call 与状态切换开销；不支持 WebGPU 的浏览器无缝降级至 WebGL2 |
| **UI / HUD** | **SolidJS** | 无虚拟 DOM 差异比对，信号级（Fine-grained）精准更新血量、弹药、击杀提示、记分板与触控布局，避免 120Hz 渲染线程被 UI 重绘打断 |
| **本地物理预测** | **Rust -> WASM（通过 `PhysicsKernel` 抽象）** | 与服务端共用同一套物理与射线逻辑，零 GC 抖动；过渡期可先挂接 `TSPhysicsKernel`（封装现有 `shared/physics.js`），安装 Rust 工具链后零改动切换为 `WasmPhysicsKernel` |
| **资产与缓存** | **SHA-256 强校验 + Cache Storage / IndexedDB** | 继承现有的分块解压（`DecompressionStream`）与内容寻址缓存设计，全部指向 CDN `assetBaseURL` / `mapBaseURL` |

---

## 2. 建议目录结构（`client-next/`）

```text
client-next/
├── index.html
├── vite.config.ts
├── package.json
├── src/
│   ├── main.ts                  # 应用入口：加载配置、挂载 SolidJS 壳与渲染循环
│   ├── config/
│   │   └── endpoints.ts         # 控制面 API 基址 + CDN 下载配置（不再硬编码同源）
│   ├── net/
│   │   ├── control-plane.ts     # 调用 Go 控制面 /api/v1/rooms 获取 JoinToken 与 wsUrl
│   │   ├── game-socket.ts       # 直连 Battle Worker WSS，支持重连、心跳与协议解码
│   │   └── protocol.ts          # 类型安全的 Client/Server 消息定义（对齐 v1 & v2）
│   ├── assets/
│   │   ├── cdn-fetcher.ts       # CORS + SHA-256 流式校验与缓存复用
│   │   ├── map-loader.ts        # 按图加载 GLTF/BIN、雷达图、高帧率/高画质切换
│   │   └── cosmetic-loader.ts   # 按房间清单懒加载武器皮肤、探员与音乐盒
│   ├── physics/
│   │   ├── kernel.ts            # PhysicsKernel 抽象接口（stepPlayer / raycast / hull）
│   │   ├── ts-kernel.ts         # 过渡期适配器（复用现有 shared/physics.js 规则）
│   │   └── wasm-kernel.ts       # 目标实现：加载 Rust/WASM 物理核心
│   ├── render/
│   │   ├── renderer.ts          # WebGPU / WebGL2 自适应初始化与渲染管线管理
│   │   ├── world-scene.ts       # 地图几何、天空盒、可破坏物（玻璃/木板）表现
│   │   ├── viewmodel.ts         # 第一人称手臂与武器动画
│   │   └── entities.ts          # 远端玩家插值、C4、投掷物与弹痕特效
│   ├── input/
│   │   ├── desktop.ts           # Pointer Lock + 键盘采样（30Hz 序列帧）
│   │   └── touch.ts             # 触控摇杆、可编辑布局与陀螺仪
│   ├── state/
│   │   └── match-store.ts       # SolidJS Signals：分离高频 HUD 状态与低频大厅状态
│   └── ui/
│       ├── Lobby.tsx            # 跨图公开房间大厅、建房/房间码加入
│       ├── Hud.tsx              # 准星、血甲、弹药、击杀卡、雷达、C4 倒计时
│       ├── LoadoutMenu.tsx      # 216 皮肤、10 探员、13 音乐盒仓库
│       └── BuyMenu.tsx          # 购买/退枪/发枪面板
└── tests/
```

---

## 3. 关键接口契约：`PhysicsKernel`

客户端预测与服务端权威判定最容易发生“手感漂移”。所有客户端物理必须只通过以下契约调用：

```ts
export interface PlayerMoveInput {
  forward: number;
  right: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  crouch: boolean;
  walk: boolean;
}

export interface PlayerMoveState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  grounded: boolean;
  crouch: boolean;
  ladderId: string | null;
}

export interface PhysicsKernel {
  loadMapCollision(physicsBytes: ArrayBuffer, maskBytes: Uint8Array, metaJson: unknown): Promise<void>;
  stepPlayer(state: PlayerMoveState, input: PlayerMoveInput, dt: number): PlayerMoveState;
  raycastWorld(origin: [number, number, number], dir: [number, number, number], maxDist: number): number | null;
  dispose(): void;
}
```

---

## 4. Phase 3 工程落地规约（`client-next/`）

### 4.1 依赖锁定与构建方式
- `client-next/` 作为独立纯静态前端工程存放于 `cs2-web/client-next/`，构建产物输出至 `client-next/dist/`，**零服务端代码依赖**，可直接上传 OSS/CDN/Cloudflare Pages。
- 核心依赖版本选型：
  - `solid-js@^1.9.20` + `vite-plugin-solid@^2.11.17`（与 Vite 8 兼容且提供稳定细粒度信号更新）
  - `three@0.185.1`（直接利用其内置 `three/webgpu` 导出与 `WebGPURenderer` 自动回退 WebGL2 能力）
  - `three-mesh-bvh@0.9.14`（供过渡期 `TSPhysicsKernel` 使用）
  - `typescript` + `vite@^8.3.8`

### 4.2 运行时配置解耦（支持无重构建切换 CDN/控制面域名）
- 加载顺序：构建期环境变量（`VITE_CONTROL_PLANE_URL`、`VITE_ASSET_BASE_URL`、`VITE_MAP_BASE_URL`）作默认兜底；运行时优先读取同源静态 `client-config.json`（404 时静默忽略），允许同一份 CDN 静态包按不同部署环境指向不同 Go 控制面地址。

### 4.3 核心模块设计（Phase 3A 首轮交付）
1. **协议与网络层（`src/net/`）**：
   - `protocol.ts`：定义 Go 控制面 REST 请求/响应、v1 Battle Worker WS 上行/下行帧、9 图目录元数据与兼容性常量（与 `shared/online-build.js` 对齐）。
   - `control-plane.ts`：`ControlPlaneClient` 封装 `health()`、`listRooms(mapId?)`、`createRoom(...)`、`joinRoom(code, playerName)`，统一解析 `{ code, message }` 错误结构并支持 `AbortSignal`。
   - `game-socket.ts`：`GameSocketClient` 负责连接 `workerWsUrl?token=...`，发送带 `joinToken` 的 `join` 包，维护 `welcome` / `snapshot` / `error` / `pong` 状态机，支持 30Hz 输入发送与断线清理。
2. **物理核抽象层（`src/physics/`）**：
   - `kernel.ts`：声明 `PhysicsKernel` 接口（`loadMapCollision`、`stepPlayer`、`raycastWorld`、`dispose`）。
   - `ts-kernel.ts`：`TSPhysicsKernel` 提供基于 `three-mesh-bvh` 的独立实例射线检测与重力/碰撞步进（不依赖全局单例，可单测）；待本机安装 Rust 工具链后无缝替换为 `WasmPhysicsKernel`。
3. **自适应渲染层（`src/render/renderer.ts`）**：
   - `createMatchViewport(canvas)` 使用 `three/webgpu` 初始化 `WebGPURenderer({ canvas, antialias: true })` 并执行 `await renderer.init()`，显式探测当前激活后端（`webgpu` 或 `webgl2` fallback）。
   - 按 15Hz 服务端快照更新远端玩家实体与包点网格展示，支持窗口大小自适应与显式 `dispose()` 释放 GPU 资源。
4. **SolidJS 响应式大厅与局内 HUD（`src/state/` + `src/ui/`）**：
   - `match-store.ts`：管理控制面连接状态、9 图选择、公开房间目录定时轮询、当前连接生命周期、血量/护甲/金钱/比分/回合倒计时与实时事件流。
   - `Lobby.tsx` + `Hud.tsx` + `App.tsx`：大厅选图、建房/一键加入公开房/房间码加入、断线错误提示、局内 HUD 叠层与 WASD/鼠标/Ping 控制面板。

---

## 5. 渐进式迁移顺序（确保全程可运行、可验证）

1. **Phase 3A（脚手架 + 控制面直连 + WebGPU 基础场景 + 完整文档与单测）** ✅ 已完成（见 [client-next/README.md](../client-next/README.md)）
2. **Phase 3B（Toy 交付合规 + CDN 校验地图加载 + 第一人称 Pointer Lock 与预测调和）** ✅ 已完成
   - **Toy 交付合规**（详见 [TOY-DELIVERY-SPEC.md](TOY-DELIVERY-SPEC.md)）：`vite.config.ts` 已启用 Rolldown `vendor-three` / `vendor-solid` 拆包；`src/platform/toy-sdk.ts` 实现宿主按需加载、`307044` 指数退避与零轮询；`toy_doctor.py` 预检返回 `ok: true, findings: []`。
   - **CDN 校验下载器（`src/assets/cdn-loader.ts`）**：实现路径穿越拦截、SHA-256 校验、`CacheStorage` 内容寻址缓存、`render-manifest.json` / `render/map.gltf` / `physics.f32` 加载并接入 `MatchViewport.setMapScene()` 与 `TSPhysicsKernel.loadMapCollision()`。
   - **第一人称控制与调和（`src/input/fps-controller.ts` + `src/physics/reconciliation.ts`）**：实现 Pointer Lock + 拖拽视角回退、30Hz 预测输入队列、15Hz 服务端 `player.seq` 裁剪重放、平滑误差衰减与重生瞬移重置。
3. **Phase 3C（全量 HUD、购买/退枪、小地图雷达、第一人称武器 Viewmodel/特效、移动端触控与程序化音效）** ✅ 已完成
   - 新增 `src/catalog/weapons.ts`、`src/audio/sfx.ts`、`src/render/viewmodel.ts`、`src/ui/BuyMenu.tsx`、`src/ui/Radar.tsx`、`src/ui/radar-math.ts`、`src/ui/Scoreboard.tsx`、`src/ui/TouchControls.tsx`。
4. **Phase 3D（二进制增量协议 v2 与 Rust/WASM `WasmPhysicsKernel` 桥接）** ✅ 已完成（WASM 二进制待安装 Rust 工具链后编译部署）
   - 新增 `src/net/binary-protocol.ts`（对接服务端 `binaryProtocol: 2` 26B 输入帧与 Full/Delta 快照）、`src/physics/wasm-kernel.ts`（`WasmPhysicsKernel` + `createBestPhysicsKernel` 自动回退）与仓库根目录 `physics-core/` Rust crate。

