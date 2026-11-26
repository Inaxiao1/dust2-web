# 二进制增量协议 v2 与 Rust/WASM 物理核心规约 (Protocol v2 & WASM ABI Spec)

> 对应总规约 [SPEC.md](../SPEC.md) Phase 3D / Phase 4。旨在将 30Hz 输入与 15Hz/30Hz 状态快照的序列化开销和下行带宽压缩 60%–80%，同时为浏览器 `WasmPhysicsKernel` 与未来 Rust Battle Worker 定义稳定的二进制与 ABI 契约。

---

## 1. WebSocket 二进制帧协议 v2（向后兼容 v1 JSON）

### 1.1 能力协商
- 客户端发送 `join` 消息时可选携带 `binaryProtocol: 2`。
- 若 Battle Worker 支持 v2，则在 `welcome` 中返回 `binaryProtocol: 2`，之后该连接上的高频帧自动切换为二进制帧（`ArrayBuffer` / `Buffer`），低频控制消息（`buy`、`refund`、`chat`、`error`、`welcome` 等）继续保留 JSON 文本帧，兼顾易调试与极限带宽效率。
- 未声明 `binaryProtocol: 2` 的旧客户端完全保持 JSON v1 兼容。

### 1.2 二进制帧头格式（Little-Endian）

| 偏移 | 类型 | 含义 |
| :--- | :--- | :--- |
| `0` | `uint8` | 协议版本号 `0x02` |
| `1` | `uint8` | 帧类型：`0x01` = Client Input，`0x02` = Snapshot Full，`0x03` = Snapshot Delta |

### 1.3 `0x01` Client Input 帧（固定 26 字节，替代 ~220 字节 JSON）

| 偏移 | 类型 | 字段 |
| :--- | :--- | :--- |
| `0..1` | `uint8[2]` | `[0x02, 0x01]` |
| `2..5` | `uint32` | `seq` |
| `6..7` | `int16` | `forward * 1000`（范围 -1000..1000） |
| `8..9` | `int16` | `right * 1000` |
| `10..13` | `float32` | `yaw`（弧度） |
| `14..17` | `float32` | `pitch`（弧度） |
| `18..19` | `uint16` | `flags` 位掩码：`bit0=jump, bit1=crouch, bit2=walk, bit3=fire, bit4=reload, bit5=interact, bit6=fire2` |
| `20` | `uint8` | `slot` (`0..5`) |
| `21..25` | `uint8[5]` | 保留对齐位 |

### 1.4 `0x02` Snapshot Full / `0x03` Snapshot Delta 帧

- 公共头（28 字节）：
  - `version (u8)` + `kind (u8)` + `flags (u16)`
  - `serverTime (f64)`（Unix ms）
  - `ctScore (u8)` + `tScore (u8)` + `roundNumber (u8)` + `roundPhase (u8: 0=waiting,1=freeze,2=live,3=ended)`
  - `roundTimeLeft (f32)`
  - `bombState (u8: 0=none,1=carried,2=dropped,3=planted,4=exploded,5=defused)` + `playerCount (u8)` + `removedCount (u8)` + `eventBytesLen (u32)`
  - `bombX/Y/Z (f32 x 3)` + `bombProgress (f32)` + `bombRemaining (f32)`
- 玩家记录（每个发生变化的玩家占固定轻量结构 + 短字符串 ID/Weapon）：
  - `Delta` 模式下只编码相比上一已发基线发生位置/视角/血甲/弹药/状态变化的玩家，及已离房玩家的 `removedIds`。
  - 事件数组（`shot`、`hit`、`kill` 等稀疏事件）按 UTF-8 JSON 附加于尾部，仅在有事件时占字节。

---

## 2. Rust / WASM 共享物理核心 ABI（`physics-core/`）

`cs2-web/physics-core/` 作为独立 Rust crate（`crate-type = ["cdylib", "rlib"]`），同时面向：
- **服务端**：原生 `rlib` 直接嵌入未来 Rust Battle Worker；
- **浏览器端**：编译为 `.wasm` 由 `client-next/src/physics/wasm-kernel.ts` 加载。

### 导出函数契约
- `alloc(len: usize) -> *mut u8` / `dealloc(ptr: *mut u8, len: usize)`
- `init_collision(ptr: *const f32, float_len: usize) -> u32`（返回 1 表示成功，0 表示三角形长度非法）
- `free_collision()`
- `raycast_world(ox, oy, oz, dx, dy, dz, max_dist: f32) -> f32`（无命中返回 `-1.0`）
- `step_player(x, y, z, vx, vy, vz, grounded, forward, right, yaw, jump, crouch, walk, dt, out_ptr: *mut f32)`（写回 7 个 `f32`：`[x, y, z, vx, vy, vz, grounded]`）

客户端通过 `createBestPhysicsKernel({ wasmUrl })` 优先尝试初始化 `WasmPhysicsKernel`，若 WASM 未构建或不可用则透明回退至 `TSPhysicsKernel`，确保任何环境开箱即用。
