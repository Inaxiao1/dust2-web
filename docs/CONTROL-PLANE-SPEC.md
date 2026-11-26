# Go 控制面与对局节点调度规约 (Control Plane Spec)

> 对应 [SPEC.md](../SPEC.md) Phase 2 核心设计。控制面负责**全局房间目录、节点发现、负载均衡、JoinToken 签发与优雅下线协同**，保持完全无状态，底层通过 `RegistryStore` 接口对接内存（本地测试）或 Redis/Valkey（生产多副本）。

---

## 1. 角色与网络流向

```text
Web 客户端 (托管于 CDN: https://cs2.example.com)
   │
   ├── 1. GET  /api/v1/rooms                   ──► Go 控制面 (多副本 + ALB)
   ├── 2. POST /api/v1/rooms  (或 /rooms/{code}/join)
   │      ◄── 返回 { roomCode, mapId, workerWsUrl, joinToken, expiresAt }
   │
   └── 3. WSS 直连 workerWsUrl?token=<joinToken> ──► 纯逻辑 Battle Worker
                                                       │
                                      本地无状态 HMAC 验签，无需回查控制面
```

Battle Worker 后台周期性向控制面（或直接向 Redis）发送心跳：
- `POST /api/v1/workers/register`：启动加载完某张地图碰撞/Nav 后注册能力。
- `POST /api/v1/workers/heartbeat`：每 3–5 秒上报活跃房间列表、人数、CPU / `tickP99Ms`、`draining` 状态。
- `POST /api/v1/workers/{id}/drain`：节点发版/缩容时置为 `draining=true`，控制面立即停止为其分配新房，存量对局正常打完。

---

## 2. HTTP REST 接口规约

所有公网响应默认携带可配置 CORS 响应头（支持 CDN 前端跨源请求）；Worker 内部注册/心跳端点需携带 `Authorization: Bearer <WORKER_AUTH_TOKEN>`。

### 2.1 健康与就绪
- `GET /api/v1/health` -> `200 OK`: `{ "ok": true, "service": "cs2-control-plane", "workers": N, "rooms": M }`
- `GET /api/v1/ready` -> `200 OK`（若存储不可达或控制面排空则返回 `503`）

### 2.2 大厅房间目录与建房/进房调度
- `GET /api/v1/rooms?mapId=de_mirage`
  - 聚合所有**未过期且存活** Worker 上报的 `public` 房间。
  - 若某房间所在 Worker 已进入 `draining` 或心跳超时，目录中标记 `joinable: false`（超时的 Worker 房间自动从目录剔除）。
- `POST /api/v1/rooms`
  - 请求体：`{ "mapId": "de_mirage", "mode": "defuse", "visibility": "public", "playerName": "Player", "bots": 6, "botDifficulty": "normal" }`
  - 调度策略（`SelectWorker`）：
    1. 过滤掉 `draining == true`、`healthy == false`、`activeRooms >= maxRooms` 或心跳超时的 Worker。
    2. 匹配支持目标 `mapId`（优先命中已预热 `mapId` 的专图 Worker，若支持多图通用 Worker 也可匹配）。
    3. 排序打分：优先最低房间负载率（`activeRooms / maxRooms`）→ 最低 `tickP99Ms` → 最低当前人类玩家数。
  - 返回 `201 Created`：
    ```json
    {
      "roomCode": "A9F3C1",
      "mapId": "de_mirage",
      "mode": "defuse",
      "workerId": "worker-mirage-01",
      "workerWsUrl": "wss://node-01.cs2.example.com/ws",
      "joinToken": "v2.eyJ...",
      "expiresAt": 1795651260
    }
    ```
- `POST /api/v1/rooms/{code}/join`
  - 请求体：`{ "playerName": "Player" }`
  - 查找 `rooms[code]` 对应的 Worker；若房间不存在返回 `404 ROOM_GONE`；若房间已满、已结束或所属 Worker 正在 `draining` 返回 `409 ROOM_UNAVAILABLE`。
  - 校验通过后签发该房间与目标 `workerId` 绑定的 `joinToken`，返回 `200 OK`。

### 2.3 Worker 生命周期管理接口（需 Bearer Token）
- `POST /api/v1/workers/register`
  ```json
  {
    "workerId": "worker-mirage-01",
    "wsUrl": "wss://node-01.cs2.example.com/ws",
    "maps": ["de_mirage"],
    "maxRooms": 4,
    "region": "cn-east"
  }
  ```
- `POST /api/v1/workers/heartbeat`
  ```json
  {
    "workerId": "worker-mirage-01",
    "draining": false,
    "tickP99Ms": 4.2,
    "rooms": [
      {
        "code": "A9F3C1",
        "mapId": "de_mirage",
        "mode": "defuse",
        "visibility": "public",
        "humans": 3,
        "bots": 7,
        "capacity": 10,
        "phase": "live",
        "joinable": true,
        "scores": { "CT": 5, "T": 4 }
      }
    ]
  }
  ```
- `POST /api/v1/workers/{id}/drain`
  - 标记指定 Worker 为 `draining = true`（亦支持在心跳中自带 `draining: true`）。

---

## 3. JoinToken 格式与无状态验签

- **格式**：`v2.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, "v2." + payloadB64))>`
- **Payload 字段**：
  ```json
  {
    "jti": "random-hex-id",
    "roomCode": "A9F3C1",
    "mapId": "de_mirage",
    "workerId": "worker-mirage-01",
    "action": "create",
    "mode": "defuse",
    "visibility": "public",
    "playerName": "Player",
    "iat": 1795651200,
    "exp": 1795651260
  }
  ```
- **Worker 验签规则**：
  1. 使用 `timingSafeEqual` 验证 HMAC-SHA256 签名；
  2. 验证 `now <= exp`（默认有效期 60 秒，仅用于建立 WS 握手/首包 `join`）；
  3. 验证 `payload.workerId === 当前 Worker ID`（防止 Token 跨节点重放）；
  4. 验证 `payload.mapId === 当前 Worker 运行地图` 且 `payload.roomCode` 匹配客户端 `join` 请求。

---

## 4. Redis 数据结构设计（Phase 2B 接入）

| Key | 类型 | TTL | 内容 |
| :--- | :--- | :--- | :--- |
| `cs2:worker:{workerId}` | Hash / JSON String | `15s`（每次心跳续期） | `wsUrl`, `maps`, `maxRooms`, `activeRooms`, `tickP99Ms`, `draining`, `lastSeen` |
| `cs2:workers:index` | Set | 无 | 活跃 `workerId` 集合（查询时剔除已过期的 Key） |
| `cs2:room:{roomCode}` | Hash / JSON String | `20s`（随心跳续期） | `workerId`, `mapId`, `mode`, `visibility`, `humans`, `bots`, `capacity`, `phase`, `joinable`, `scores` |
| `cs2:rooms:public` | Set | 无 | 公开房间 `roomCode` 索引 |

---

## 5. Phase 2B 已实现细节与本地联调方式

### 5.1 Battle Worker 侧新增模块与机制

1. **无状态验签（[server/join-token.js](../server/join-token.js)）**
   - `verifyJoinToken(token, secret, { expectedWorkerId, expectedMapId, nowSeconds })`
   - 使用 `crypto.createHmac('sha256', secret)` + `crypto.timingSafeEqual` 验证签名，校验 `exp`、`workerId`（防跨节点盗用）和 `mapId`（防跨地图使用）。
   - [server/index.js](../server/index.js) 支持从 WS 握手查询参数 `?token=...` 或 `join` 消息体 `joinToken` 读取凭证；通过 `usedJTIs` 缓存已消费 `jti`（并随心跳定期清理过期记录）阻止单凭证重放；`claims.action === 'join'` 时强制加入已存在房间。
2. **主动注册与合流心跳（[server/control-plane-client.js](../server/control-plane-client.js)）**
   - `startControlPlaneReporter` 启动时自动调用 `/api/v1/workers/register`，定时推送 `/api/v1/workers/heartbeat`（含 `draining`、`tickP95Ms` 及实时房间摘要）。
   - 采用单飞合并循环（`pendingReport`）：在建房、退房、`beginDrain()` 时调用 `reportNow()`；即使当下存在在途心跳，也会在结束后立即补发最新状态，保证排空信号不会被旧心跳覆盖；控制面重启返回 `404` 时自动重注册。

### 5.2 Worker 联调环境变量

| 变量名 | 说明 |
| :--- | :--- |
| `DUST2_CONTROL_PLANE_URL` | Go 控制面基址（如 `http://127.0.0.1:8080`），配置后自动开启注册与心跳 |
| `DUST2_WORKER_ID` | 当前 Worker 唯一标识（需与 Token `workerId` 校验一致） |
| `DUST2_WORKER_AUTH_TOKEN` | 访问控制面内部注册/心跳 API 的 Bearer Token |
| `DUST2_WORKER_WS_URL` | 上报给控制面的公网/客户端可达 WS 地址（未设时回退本地监听地址） |
| `DUST2_JOIN_TOKEN_SECRET` | 与控制面一致的 HMAC-SHA256 验签密钥 |
| `DUST2_REQUIRE_JOIN_TOKEN` | 设为 `1` 时强制要求所有 WS `join` 必须携带有效 `JoinToken` |
| `DUST2_HEARTBEAT_MS` | 心跳间隔毫秒数（默认 `3000`） |
| `DUST2_PRIVATE_MAX_ROOMS` | 单张私有地图 Worker 的最大并发房间数（默认 `1`，范围 `1–24`） |

### 5.3 本地多进程联调启动示例

```bash
# 终端 1：启动 Go 控制面
cd control-plane
JOIN_TOKEN_SECRET="dev-join-secret-at-least-16b" \
WORKER_AUTH_TOKEN="dev-worker-auth-token-16b" \
ALLOWED_ORIGINS="http://127.0.0.1:5179" \
PORT=8080 go run ./cmd/control-plane

# 终端 2：启动纯逻辑 Node Battle Worker 节点 A
DUST2_LOGIC_ONLY=1 DUST2_SERVE_MAP_FILES=0 \
DUST2_CONTROL_PLANE_URL="http://127.0.0.1:8080" \
DUST2_WORKER_ID="worker-dust2-a" \
DUST2_WORKER_AUTH_TOKEN="dev-worker-auth-token-16b" \
DUST2_JOIN_TOKEN_SECRET="dev-join-secret-at-least-16b" \
DUST2_REQUIRE_JOIN_TOKEN=1 \
DUST2_ALLOWED_ORIGINS="http://127.0.0.1:5179" \
PORT=3001 node server/index.js
```

