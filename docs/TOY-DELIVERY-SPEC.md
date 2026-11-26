# B站 Toy 平台交付、SDK 集成与轻壳打包规约 (Toy Delivery Spec)

> 对应总规约 [SPEC.md](../SPEC.md) 与官方本机 Toy Skill（`toy` CLI + `toy_doctor.py`）。本文档明确 **Toy 轻壳托管 + 独立 CDN 大资产 + Go 控制面 + 纯逻辑 Battle Worker** 的生产架构边界、合规铁律与发布验收流程。

---

## 1. Toy 运行拓扑与流量分离

Toy 页面运行在 B站托管的版本化 iframe 内（如 `https://www.bilibilitoy.com/toy/<slug>/<version>/index.html`），正式对外分享入口为 `https://www.bilibili.com/toy/<slug>/index.html`。

为兼顾 **Toy 包体轻量秒开、跨版本缓存命中** 以及 **2.67 GB 九图/皮肤/音乐资产的高并发分发**，线上采用四链路彻底分离：

```text
1. Toy 托管壳 (https://www.bilibilitoy.com/toy/<slug>/<version>/)
   └── 仅上传 client-next/dist/（~1 MB 级：index.html + vendor-three/solid + app chunk + client-config.json）

2. 独立静态资产 CDN (https://downloads.example.com/releases/<id>/)
   └── 托管九图 GLTF/BIN/贴图、physics.f32、216款皮肤、10探员、13套音乐盒（CORS 精确允许 https://www.bilibilitoy.com）

3. Go 控制面 (https://lobby.example.com)
   └── 无状态 REST API（/api/v1/rooms、JoinToken 签发），CA 受信任 HTTPS + CORS 精确允许 https://www.bilibilitoy.com

4. 纯逻辑 Battle Worker 集群 (wss://node-XX.example.com/ws)
   └── 30Hz 权威模拟、无静态文件下载、CA 受信任 WSS + DUST2_ALLOWED_ORIGINS 包含 https://www.bilibilitoy.com
```

---

## 2. Toy 平台硬约束与自动化防坑规范

基于 `toy` skill 的 `references/content-checklist.md` 与 `toy_doctor.py` 检查口径，`client-next/` 工程须始终满足以下硬要求：

1. **相对路径与无根跳转（防白屏 / 404）**
   - `vite.config.ts` 固定 `base: './'`。
   - HTML / CSS / JS 中禁止使用 `/assets/...`、`/perf/...` 等站点根绝对路径；运行时配置以 `./client-config.json` 相对路径加载。
   - 严禁使用 `history.pushState('/route')` 类无对应 HTML 的 history 路由（当前使用 SolidJS 内存状态视图，若后续引入路由必须用 hash 模式）。
2. **入口 `index.html` 体积红线（< 1 MB 解压后）**
   - `client-next/dist/index.html` 仅保留轻壳骨架（实测 `< 1 KB`），绝不内联大图、音频或巨型 JSON。
3. **跨版本缓存复用（Contenthash + Vendor 拆包）**
   - Vite 默认对 JS/CSS 产出 contenthash；同时在 `vite.config.ts` 中通过 Rolldown `codeSplitting.groups` 将 `three` / `three-mesh-bvh`（`vendor-three`）与 `solid-js`（`vendor-solid`）独立拆包。
   - 这样每次只改游戏逻辑或 UI 重新发布 Toy 时，核心 3D 引擎包哈希不变，B站 Toy 平台可直接跨版本复用缓存，访客只需下载几十 KB 业务变更。
4. **仅上传干净构建产物**
   - 发布目录只能是 `client-next/dist`（严禁上传源码 `src/`、`node_modules`、`server/`、`control-plane/`、`.git` 或旧 `toy.yaml`）。
   - 发布前必须运行本机 `toy_doctor.py`：出现任何 `ERROR` 必须修复后再传；出现任何 `WARN` 必须逐条向创作者说明。

---

## 3. 官方 Toy JS SDK 集成规约（`src/platform/toy-sdk.ts`）

- **加载边界**：仅在检测到处于 Toy 宿主环境（`location.hostname.endsWith('bilibilitoy.com')` 或存在 `globalThis.toy` / 显式 Toy 上下文）时，按需加载官方 SDK：`https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js`；本地开发与独立站点完全跳过，不阻塞离线或局域网调试。
- **身份边界**：
  - 通过 `getUserProfile()` 读取官方昵称与稳定 OpenID（`toyOpenId` / `openId`）。
  - **严禁伪造或手填假 SDK UID**；作者预览环境若返回缺少作品上下文错误，如实记录并退回游客/预览提示。
- **云存储与排行榜频率保护（Checklist §7）**：
  - **只存关键节点，不当内存**：战斗中每杀只在内存计数，仅在**回合结束、离开对局、`pagehide` 或玩家手动点击同步**时执行批量落盘。
  - **批量代替循环**：一次 `setCloudStorage` / `getCloudStorage` 合并多个键，绝不在 `for` 循环或 `setInterval` 中轮询云档与排行榜。
  - **限流 `307044` 指数退避**：捕获 `{ type: 'http_error', code: 307044 }` 时进入指数退避冷却并提示用户，**绝不在代码或文档中硬编码所谓官方 QPS 阈值**。

---

## 4. 标准发布操作流（两段式闸门，严禁跳过确认）

每次发布或更新到 B站 Toy 必须严格执行：

1. **构建与本地自检**：
   ```bash
   cd client-next
   npm run build
   python3 ~/.codex/skills/toy/scripts/toy_doctor.py dist --slug <your-slug> --json
   ```
2. **检查 CLI 能力与账号（AI 一律带 `--json`）**：
   ```bash
   toy --help-json
   toy whoami --json
   toy mylist --json
   ```
3. **仅生成预览（严禁带 `--yes`）**：
   - 首发：`toy create client-next/dist --slug <slug> --json ...`
   - 更新：`toy update <toy-id> client-next/dist --json`（保留原 slug，绝不删旧重建）
4. **人工浏览器真机检查 `preview_url`**（验证资源加载、CORS、WSS 直连、移动端触控与 SDK 行为）。
5. **获得创作者明确回复“提交”后**，以完全相同的参数加上 `--yes` 提交审核，并核对返回 `id` 与 `status`。

> 后端部署（Go 控制面、Battle Worker 与 CDN 资产发布）与 Toy 前端审核彼此独立，前端发版不会自动更新后端进程，上线前须先完成后端与 CDN 验收。
