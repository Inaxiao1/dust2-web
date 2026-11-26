# 本地与生产高可用集群运维手册 (HA Cluster Runbook)

> 对应总规约 [SPEC.md](../SPEC.md) Phase 4。提供本地一键联调集群启动方式、Redis 多副本控制面切换以及容器 / Kubernetes 生产部署说明。

---

## 1. 一键启动本地高可用联调集群

在仓库根目录执行：

```bash
npm run dev:ha
```

该命令由 [scripts/dev-ha-cluster.mjs](../scripts/dev-ha-cluster.mjs) 驱动，自动拉起：
1. **Go 控制面**（`http://127.0.0.1:8080`）：全局房间目录、负载均衡与 HMAC `JoinToken` 签发，CORS 放行 `http://127.0.0.1:5179` 与 `https://www.bilibilitoy.com`。
2. **两台纯逻辑 Node Battle Worker**（`:3001` 与 `:3002`）：均开启 `DUST2_LOGIC_ONLY=1`、`DUST2_SERVE_MAP_FILES=0`、`DUST2_REQUIRE_JOIN_TOKEN=1` 并自动向控制面注册心跳。

随后另开终端启动新版 Web 客户端：

```bash
cd client-next && npm run dev
# 打开 http://127.0.0.1:5179
```

---

## 2. Go 控制面多副本与 Redis 切换

[control-plane/cmd/control-plane/main.go](../control-plane/cmd/control-plane/main.go) 默认使用 `MemoryStore`（零依赖，适合单机测试）。

生产多副本部署时，只需注入 `REDIS_ADDR`（可选 `REDIS_PASSWORD`、`REDIS_KEY_PREFIX`）：

```bash
CONTROL_PLANE_ENV=production \
HOST=0.0.0.0 PORT=8080 \
REDIS_ADDR=redis.internal:6379 \
JOIN_TOKEN_SECRET="<32字节随机密钥>" \
WORKER_AUTH_TOKEN="<32字节随机密钥>" \
ALLOWED_ORIGINS="https://www.bilibilitoy.com,https://cs2.duskrain.cn" \
./control-plane
```

底层由零依赖原生 RESP2 客户端 [control-plane/internal/store/redis.go](../control-plane/internal/store/redis.go) 维护带 TTL 的 `cs2:worker:*` 与 `cs2:room:*` 键，任意控制面副本重启或扩容均不丢失全局路由表。

---

## 3. 容器与 Kubernetes 生产模板（`deploy/ha/`）

- **[deploy/ha/Dockerfile.control-plane](../deploy/ha/Dockerfile.control-plane)**：多阶段构建 Go 控制面静态二进制（最终镜像 `< 20 MB`）。
- **[deploy/ha/Dockerfile.battle-worker](../deploy/ha/Dockerfile.battle-worker)**：仅拷贝 `server/`、`shared/`、`package.json` 与纯逻辑地图碰撞目录（排除全部 2.67 GB 客户端静态渲染/音频资产），默认开启 `DUST2_LOGIC_ONLY=1`、`DUST2_SERVE_MAP_FILES=0`、`DUST2_REQUIRE_JOIN_TOKEN=1`。
- **[deploy/ha/k8s-deployment.yaml](../deploy/ha/k8s-deployment.yaml)**：
  - 控制面 Deployment（多副本 + `/api/v1/health` 与 `/api/v1/ready` 探针 + HPA）。
  - Battle Worker Deployment（`/health` livenessProbe + `/ready` readinessProbe + `lifecycle.preStop` 调用 `POST /drain` 实现零掉线滚动发版 + `terminationGracePeriodSeconds: 1800` 等待存量对局自然结束）。

---

## 4. 生产机（`game.example.com`）Systemd + Nginx 运维速查

已部署目录位于 `/opt/cs2-ha/`（详见 [BENCHMARK-CLUSTER.md](BENCHMARK-CLUSTER.md)）：

- **对外 HTTPS/WSS 入口**：
  - 网页客户端直接开玩：`https://game.example.com/cs2/`（静态托管于 `/opt/cs2-ha/web/`，运行时配置 `client-config.json`）
  - 静态地图 CDN：`https://game.example.com/cs2/cdn/maps/de_dust2/`（静态托管于 `/opt/cs2-ha/cdn/`，CORS `*` + `immutable` 缓存）
  - 控制面 API：`https://game.example.com/cs2/api/v1/{health,rooms}`
  - 6 节点纯逻辑对局 WSS：`wss://game.example.com/cs2/w{1..6}/ws`（端口 `19101`–`19106`，`MAX_ROOMS=4`/节点）
  - 节点探针：`https://game.example.com/cs2/w{1..6}/{health,ready}`
- **常用日常运维命令（主机内执行）**：
  ```bash
  systemctl status cs2-control-plane cs2-battle-worker@{1..6}
  journalctl -u cs2-control-plane -u 'cs2-battle-worker@*' -n 50 --no-pager
  ```
- **远端 6 Worker 回归压测**：
  ```bash
  BENCH_BASE_URL=https://game.example.com/cs2 BENCH_ORIGIN=https://game.example.com BENCH_WORKERS=6 BENCH_STAGES=12,24 node scripts/bench-remote.mjs
  ```
