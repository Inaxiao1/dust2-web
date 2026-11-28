# 开发者手册与构建发版指南（DEVELOPMENT）

本文档说明代码结构、本地调试、测试规范、高频踩坑防线，以及从代码提交到 B站 Toy 提审的完整流水线。

---

## 一、环境要求与常用命令

- **Node.js**：`>= 22.12.0`（线上使用 `v22.x` / `v24.x`；依赖原生 `fetch`、`node:test`、`DecompressionStream`）。
- **包管理**：原生 `npm`（仓库仅 3 个运行依赖：`three`、`three-mesh-bvh`、`ws`，以及开发依赖 `vite`）。

| 命令 | 用途 |
|---|---|
| `npm run play` | 一键启动本地 9 图网关，浏览器访问 `http://127.0.0.1:3240/perf/` |
| `npm run dev` | 启动 Vite 前端开发服务器（端口 `5178`） |
| `npm test` | 运行全量 800+ 项自动化测试（并发 4，耗时约 15 秒） |
| `node --test tests/<file>.mjs` | 运行指定模块回归测试（如 `tests/mail-and-password.mjs`） |
| `npm run build` | 生成资源清单并执行 Vite 生产构建到 `dist/` |
| `node scripts/build-toy-and-cdn.mjs ...` | 产出 B站 Toy 静态包（`artifacts/deploy/toy-package`）与 CDN 增量包（`artifacts/deploy/cdn-bundle`） |
| `npm run logic:check` | 校验纯逻辑服模式（`DUST2_LOGIC_ONLY=1`）无静态文件泄露 |

---

## 二、核心目录导览

```text
cs2-web/
├── scripts/maps/mode-ui/      # 单屏大厅独立前端（index.html / screen.js / screen.css / room-directory.js / origin-failover.js / toy-identity.js）
├── client/                    # 3D 战局运行时 & 大厅懒加载弹窗模块
│   ├── lobby-hub.js           # 大厅弹窗总入口（按需挂载邮箱/成长/探员/装备/皮肤/设置，CSS 必须 ?inline 注入！）
│   ├── main.js                # 战局主循环、WS 连接、预测、错密就地重试弹窗、视口/移动端适配
│   ├── private-main.js        # 战局页引导（解析路由、拉取 private-map.json、支持离线模式）
│   ├── local-bot-server.js    # 纯本地离线人机虚拟服务端
│   ├── mail-menu.js / .css    # 顶栏系统邮箱弹窗
│   ├── progression-menu.js/.css # 成长福利 & Toy 关注/三连实装图弹窗
│   ├── toy-cloud-progress.js  # Toy 云存档（cs_prog_v1 / cs_loadout_v1）与 307044 限流退避
│   ├── touch-controls.js      # 触屏摇杆、左侧独立开火键（fireLeft）与手势处理
│   ├── touch-layout-editor.js # 2/3/4 指自定义按键布局编辑器
│   ├── persistence.js         # localStorage 双写封装（同时写 <key> 与 <key>.backup）
│   └── room-menu.js           # 局内房间席位管理与加密状态展示
├── shared/                    # 前后端同构纯 ESM 逻辑（零 DOM 依赖，Node 与浏览器共用）
│   ├── progression.js         # 解锁条件、红点判断、单调合并 mergeProgress、生涯等级
│   ├── rewards.js             # 可扩展奖励抽象（skin/agent/xp/item/bundle）与邮箱角标计算
│   ├── static-runtime.js      # Toy/静态托管多入口 API 容灾（fetchGameApi）与资源解析
│   ├── physics.js / aim.js / weapons.js / skins.js / agents.js
├── server/                    # 权威服务端与集群网关
│   ├── performance-maps.js    # 9 图分片网关、4 节点联邦心跳、热配置加载、邮箱 API、跨节点 WS 代理
│   ├── index.js               # 单图 Worker（WS/HTTP、房间密码校验、roomCosmetics、防刷限流）
│   ├── game.js                # GameRoom 权威状态机、房间密码属性、resumeToken 断线恢复
│   ├── mail-store.js          # 热更新邮件存储（2.5s mtimeMs 轮询 + 原子持久化）
│   ├── private-map-server.js / private-map-runtime.js # 单图独立子进程加载器
│   └── telemetry-store.js     # Gzipped 紧凑日志与 RTT 统计
├── scripts/
│   └── build-toy-and-cdn.mjs  # Toy 124 MiB ROI 分层打包 & CDN 产物构建脚本
├── ops/                       # 运维配置示例模板（无真实 IP/密码）
│   ├── cluster-config.example.json
│   └── mail-announcements.example.json
└── tests/                     # 800+ 项单元与集成测试
    ├── mail-and-password.mjs  # 邮箱抽象奖励、红点、热更存储、密码房与网关跳过快速加入
    ├── cluster-sharding.mjs   # 单机人数上限、多节点分流、cluster-config.json 热更新与客户端容灾
    ├── mobile-touch-controls.mjs # 移动端比例、左侧开火键与布局自定义
    └── ...
```

---

## 三、开发阶段必须注意的 8 个工程约定

1. **大厅弹窗样式必须 `?inline` 注入 `lobby-hub.js`**
   - 首页 [scripts/maps/mode-ui/index.html](../../scripts/maps/mode-ui/index.html) 不单独 `<link>` 弹窗 CSS，而是懒加载 `assets/lobby-hub.js`。
   - 凡是在大厅弹出的新模块，必须在 [client/lobby-hub.js](../../client/lobby-hub.js) 中以 `import xxxCss from './xxx.css?inline'` 引入并拼接到 `#lobbyHubInlineStyles`，否则线上样式会丢失。
2. **`preferences` 双写备份键（`.backup`）**
   - [client/persistence.js](../../client/persistence.js) 读写 `localStorage` 时会同步维护 `<key>.backup`。自动化测试或手动清本地状态时，必须同时清理 `<key>` 与 `<key>.backup`，否则读回旧缓存。
3. **新增解锁途径必须走 `evaluateRequirement`**
   - 皮肤库、探员库与成长路线都依赖 [shared/progression.js](../../shared/progression.js) 的 `evaluateRequirement(req, progress)`。通过新渠道（如邮箱、活动）直赠皮肤/探员时，统一写入 `progress.grantedSkins` / `progress.grantedAgents`，所有菜单会自动识别并允许装备。
4. **房间目录 DOM 结构与精简 JSON 契约**
   - [tests/global-room-directory.mjs](../../tests/global-room-directory.mjs) 校验 `.directory-details` 第一个子节点为 `<h3>`；[tests/performance-room-directory.mjs](../../tests/performance-room-directory.mjs) 对公开未加密房间对象做严格结构比对。
   - 因此房间目录可选字段（如 `locked`）必须采用**稀疏输出**（仅加密时输出 `locked: true`），避免破坏兼容测试并减小载荷。
5. **跨节点直连预检约定**
   - 客户端加入其他战区节点的房间时，`queryRoomAppearance` 必须优先连 `privateMap.wsFallbackUrls[0]`（目标节点），失败再回退主网关；同时网关 `routeShardedWebSocket` 对 `roomCosmetics` 和 `join` 均做 `peerBridgeUrl` 跨节点代理，保证新老版本客户端都能跨战区秒进房。
6. **房间密码传输安全**
   - 密码仅存入 `sessionStorage` 键 `cs.room.password.v1`（有效期 5 分钟，拿到 `welcome` 后立刻清除），**绝不拼接到 URL Query**，避免被浏览器历史记录、邀请链接或日志采集泄露。
7. **新增模块同步清单**
   - 若修改了 `server/` 或 `shared/` 文件，部署到 4 台线上节点时务必确认全部依赖模块同步到位（注意 `server/private-map-runtime.js` 依赖 `scripts/maps/load-private-physics.mjs` 与 `client/compact-map-codec.js`）。
8. **Toy 包体后缀白名单限制**
   - B站 Toy 托管平台拦截 `.mgp`、`.vidx`、`.f32`、`.u8` 等非标准二进制扩展名，打包脚本自动将其重命名为 `.glb.gz` 并在 `runtime-config.js` 记录 `bundledMapsBinExt: '.glb'`，切勿绕过该脚本手动拷贝地图文件进 Toy 包。

---

## 四、完整构建、预览自测与提审发版 SOP

### 第 1 步：全量回归测试与前端编译
```bash
cd cs2-web
npm test
npm run build
```

### 第 2 步：构建 B站 Toy 预览包（含多入口容灾）
将所有公网健康入口按优先级填入 `--game-origins`（用实际域名/高端口地址替换占位符）：
```bash
node scripts/build-toy-and-cdn.mjs \
  --game-origin=https://cs2-ws.apikeygame.top \
  --game-origins=https://cs2-ws.apikeygame.top,https://<XIANGYANG_ORIGIN>,https://<NODE2_IP_ORIGIN>,https://<NINGBO_PROXY_ORIGIN>,https://<KUNMING_ORIGIN> \
  --cdn-base=https://cs2-cdn.apikeygame.top \
  --toy-limit-mb=124
```
确认输出 JSON 中 `toyPackage.sizeMiB <= 124`。若本次改动涉及新增静态地图/皮肤/探员资源，需将 `artifacts/deploy/cdn-bundle/` 同步至 CDN 源站（详见 [OPERATIONS.md](OPERATIONS.md)）。

### 第 3 步：上传预览版（先测再提审）
```bash
# 交互模式：上传生成预览链接，在提示“确认提交审核”时输入 n，即可保留预览链接不提审
toy update 60036873452544 artifacts/deploy/toy-package
```
必测验收项（桌面 + 移动端竖横屏）：
- 顶栏邮箱角标拉取与领取（验证皮肤解锁、经验累加、自定义物品收录、刷新后不重复领）；
- 成长福利 8 张内置刀/枪预览图加载完整，关注与三连领完后内外红点同时消失；
- 「人机练习」高亮按钮点击 3 秒内本地开局，无报错；
- 跨页签 1v1 密码房全流程（建房 → 列表带锁标 → 快速加入跳过 → 错密就地弹窗重试 → 输对同房）；
- 移动端画面零拉伸、左侧独立开火键与 2/3/4 指布局保存生效。

### 第 4 步：正式提审与源码归档
```bash
# 确认预览无误后正式提交审核
toy update 60036873452544 artifacts/deploy/toy-package --yes --json

# 核查无敏感信息后提交并推送主分支
git status
git push origin main
```
