# 项目演进历史与踩坑档案馆（HISTORY）

本文档按时间顺序记录「随时随地CS」从上游 Fork 到当前 4 节点高可用集群的演进脉络、关键架构决策原因，以及历次线上故障和真实踩坑的永久修复方案。**后续开发者在做重构或改动前，强烈建议先通读文末的「12 个血泪坑」避免踩回老坑。**

---

## 一、演进时间线

### 阶段 1：上游 Fork、B站 Toy 化与九图画质重塑（`f4a2634` → `89d3e6f`）
- **起点**：从 `ETO-ze/dust2-web`（`online-v1.4.0-perf.6.2` / `f4a2634`）派生，目标打造面向 B站 Toy 的零安装 5v5 网页 CS。
- **成长与云存档（`8e6eaa3`、`04b5e80`）**：接入 B站 Toy SDK（`toyOpenId` 身份、关注与一键三连验证、`cs_prog_v1` / `cs_loadout_v1` 云存档与 `307044` 指数退避）；并将枪皮解锁调整为「单武器专精击杀」，平滑成长曲线。
- **九图 PBR 重构与视觉修复（`4bcb773`、`70256e8`、`3f156f5`、`b02f39c`、`76cfe05`、`89d3e6f`）**：
  - 9 张图共享统一 RGBA8 PBR 图集，支持影院/竞技双风格即时切换；
  - 根治九图共面 Z-fighting 闪烁、第三人称武器挂点偏移、22 款近战匕首 HUD 剪影对齐，并重拍全部 9 张大厅背景与缩略图。
- **Toy 128 MB 极限压缩与零出口 CDN（`4d3ca43`、`373b616`、`9a1f849`）**：
  - 解决 Toy 平台拒绝 `.mgp`/`.vidx`/`.f32`/`.u8` 扩展名的问题（改以 `.glb.gz` 白名单后缀打包 + 透明解压）；
  - 人机改用内置原厂枪皮，CDN 武器流量骤降 ~60%；
  - 将 7 张热门地图、29 把原厂武器与全部预览图塞入 `<124 MiB` Toy 包体，实现游戏服零静态出口。

### 阶段 2：高并发压测、CPU/带宽瓶颈优化与协议瘦身（`59facb3` → `bd5367f`）
- **服务端性能突破（`59facb3`、`cfa47ba`、`5813bd2`、`9a1f849`）**：
  - 修复 C4 `objectiveLocked` 引发的 `fireQueue` 崩溃；
  - 优化人机寻路图重建与物理计算，服务端 CPU 占用降低 ~60%；
  - 网关实现热门地图多 Worker 自动分片（`PERF_SHARD_MAPS`）；
  - 推出 `ackDelta` 差分快照 + 精简输入协议，多人房间 WebSocket 带宽下降 ~78%。
- **WebRTC UDP 实验与果断回切直连 WS（`88dd4ed` → `12dec37` → `bd5367f`）**：
  - 曾上线基于 `node-datachannel` 的 WebRTC UDP DataChannel（并迭代了双通道 PR-SCTP、抗膨胀背压、SDP 修复等）；
  - **实战结论**：复杂公网 NAT/代理/校园网环境下 UDP 建连不稳定且带来额外回退耗时，而优化后的 `ackDelta` 直连 WebSocket 延迟低、极稳定且 100% 穿透。因此自 `bd5367f` 起**默认关闭 WebRTC UDP，统一走直连 WS**（保留代码开关 `transport.rtcEnabled` 供未来按需评估）。
- **大厅流畅度修复（`bd5367f`）**：根治背景切换与探员呼吸动画的 1px 抖动与闪白（`img.decode()` 双层无缝淡入 + GPU 合成层锁定）。

### 阶段 3：单机限流、多节点分流、香港断流抢救与热配置架构（`f84ecdf` → `9ac86f8`）
- **背景**：玩家涌入后单机 CPU 与 20M 带宽触顶，随后香港旧节点（`xiaoji`）又突发月流量耗尽宕机，暴露了单点写死的脆弱性。
- **架构升级**：
  - 实现单机人数软/硬上限（`PERF_MAX_HUMANS` / `PERF_HARD_MAX_HUMANS`）与负载保护（`PERF_MAX_LOAD_PER_CPU`），接入宁波 + 高速二区 + 昆明组成三节点联邦集群（`f84ecdf`）；
  - 将主域名 `cs2-ws.apikeygame.top`（灰云）与 `cs2-cdn.apikeygame.top`（橙云 CF 缓存）从停机的香港节点紧急迁移至高速二区（`server-156`）并配妥自动续期证书；
  - 推出 **2.5 秒热加载 `/opt/cs2-web/cluster-config.json`** 与 **客户端多入口容灾（`fetchGameApi` 失败自动切换并退避 60s）**（`9ac86f8`），彻底解决单机房流量耗尽或宕机导致全服瘫痪的风险；
  - 推出 **0 服务器消耗纯本地「人机练习」模式**（`3208c62`），既保障弱网/断网玩家可玩性，又在高峰期自然分流服务器压力。

### 阶段 4：移动端彻底重构、邮箱与 1v1 密码房、襄阳 32 核主区扩容（`286a3ee` → `c03af19`）
- **移动端体验重做（`286a3ee`）**：根治移动端 4:3 拉伸 162%/289% 的历史 Bug，新增左侧移动摇杆上方独立开火键（`fireLeft`），上线支持双指/三指/四指预设与自由拖拽的触控布局编辑器（大厅与局内双入口）。
- **运营与社交闭环（`1bbb499`、`c03af19`）**：
  - 顶栏新增「邮箱」系统 + 可扩展抽象奖励模型（支持 `skin`/`agent`/`xp`/`bundle`/未来通用 `item`）与热加载后端；
  - 「成长福利」升级为内外红点联动 + 8 款内置刀/枪实装图展示；
  - 「人机练习」去 AI 味并升级为 CS2 战术翠绿高亮分流按钮；
  - 自建房间支持 1v1 密码保护（快速加入自动跳过、错密就地重试、跨节点 `roomCosmetics` 直连与代理修复）；
  - 新增 **襄阳 32 核 / 32G / 50M 高防节点（「华中主区」）**，通过热配置零踢人接入，全服容量扩容至 **295 人**并正式提审新版本。

---

## 二、前人踩过的 14 个血泪坑（避坑对照表）

| # | 踩坑现象 | 根因 | 永久修复与防回退约定 |
|---|---|---|---|
| 1 | 移动端进入九图画面被严重拉扁/拉长（162%–289%） | `client/main.js` 误判 `mobile: mobileDevice() && !privateMap`，导致私有九图套用了桌面 `4:3 stretch` | 改为 `mobile: mobileDevice() || Boolean(touchControls?.enabled)` + 竖屏 FOV 补偿，移动端强制隐藏 `4:3` 选项 |
| 2 | 跨节点加入其他战区的房间时偶发报「房间已关闭」 | 网关 `routeShardedWebSocket` 仅对 `join` 做了 `peerBridgeUrl` 跨节点代理，漏掉了前置 `roomCosmetics` 外观查询；且客户端 `queryRoomAppearance` 没优先连目标节点 | 双端修复：服务端对 `roomCosmetics` 补全跨节点代理+即时 peer 刷新，客户端优先连 `privateMap.wsFallbackUrls[0]` |
| 3 | 新接入香港/节点流量耗尽直接导致全服白屏或失联 | 早期前端与服务端写死单一主入口与单一 CDN 源站 | 改为客户端多入口自动容灾（`--game-origins` 5 入口）+ 服务端 `/opt/cs2-web/cluster-config.json` 2.5s 热更新摘流与切 CDN |
| 4 | `server/performance-maps.js` 启动报 `ReferenceError`（TDZ 崩溃） | 在 `let clusterPollRunning = false` 声明前就同步调用了 `loadClusterConfig(true)` | 务必在所有被回调引用的状态变量初始化完成后再执行首次 `loadClusterConfig(true)` |
| 5 | 新增 nginx 域名配置覆盖了同机 IP 证书站点，影响其他服务探活 | `cs2-domains.conf` 字母序排在 `freeship26-ip` 之前，成为 `:443` 首个 server 块 | `server-156` 上 CS2 域名配置必须命名为 `z-cs2-domains.conf`（排在默认 IP 站点之后） |
| 6 | Nginx 重载报错 `unknown directive "http2"` | Ubuntu 24.04 默认 Nginx 为 `1.24.0`，不支持 1.25+ 的 `http2 on;` 语法 | 统一使用 `listen 443 ssl;` / `listen 3245 ssl;`，不要写 `http2 on;` |
| 7 | B站 Toy 上传包内地图二进制文件被平台拒绝 | 平台静态白名单拦截 `.mgp`/`.vidx`/`.f32`/`.u8` 后缀 | 始终使用 [scripts/build-toy-and-cdn.mjs](../../scripts/build-toy-and-cdn.mjs) 自动重命名为 `.glb.gz` 并在 `runtime-config.js` 配置映射 |
| 8 | 大厅新增弹窗打开后样式错乱或裸奔 | 首页大厅懒加载 `lobby-hub.js`，没有独立 CSS `<link>` 标签 | 所有大厅弹窗 CSS 必须在 [client/lobby-hub.js](../../client/lobby-hub.js) 中 `?inline` 导入并写入 `#lobbyHubInlineStyles` |
| 9 | 邮箱直赠的皮肤在皮肤库里仍显示「未解锁」 | `SkinMenu` / `AgentMenu` 调用 `evaluateRequirement()` 而非仅查 `isSkinUnlocked()` | 在 `skinRequirements`/`agentRequirements` 写入 `kind`/`itemId`，由 `evaluateRequirement()` 统一优先放行 `grantedSkins` 与 `grantedAgents` |
| 10 | 清除 `localStorage` 后页面刷新配置又回来了 | [client/persistence.js](../../client/persistence.js) 为防止意外清空，双写了 `<key>` 与 `<key>.backup` | 自动化测试与排障清缓存时必须同步删除 `<key>` 与 `<key>.backup` |
| 11 | `client/interface.css` 通用按钮样式意外覆盖新按钮的金色主题 | 过宽的通用 `button` 选择器优先级覆盖了模块类 | 通用选择器需显式排除特殊按钮（如 `:not(.touch-layout-open-btn)`），或提高组件样式作用域特异性 |
| 12 | 房间目录新增字段导致旧单测 `global-room-directory` / `performance-room-directory` 失败 | 旧测试严格校验 `.directory-details` 首个子节点为 `<h3>` 且未加密房对象不含多余 false 字段 | 锁标放进 `<h3>` 内部；服务端目录按稀疏方式仅在加密房输出 `locked: true` |
| 13 | B站 Toy 线上云存档大概率静默写失败 | Toy 官方单键上限为 **1,024 UTF-8 字节**（128 键/玩家），而旧 `cs_loadout_v1` 默认即占 `1,245` 字节，旧 `cs_prog_v1` 领几封邮件后也超 `1,024` 字节；且旧测试未校验字节上限 | 升级为 `v2` 自动分片编解码器（[shared/toy-cloud-codec.js](../../shared/toy-cloud-codec.js)），所有分片硬控 `≤ 960 B`、覆盖全量设置/触控布局/邮箱数据、无损迁移旧 `v1`，并在 [tests/toy-cloud-quota.mjs](../../tests/toy-cloud-quota.mjs) 强制执行 128×1024 B 平台红线断言 |
| 14 | 手机保存自定义按键布局后，切枪/切刀/切道具整排按钮全部消失 | `.touch-weapons` 容器使用了 `left: 50%; transform: translateX(-50%)`，CSS 规范中带 `transform` 的祖先会劫持后代 `position: fixed` 的包含块，导致自定义布局给切枪按钮加的 `top: 350px` 被叠加在容器底部之外数百像素处；此外观战态 `.touch-spectator` 下打开布局编辑器会让 `measure()` 测出 `0×0` | 改用 `left: 0; right: 0; display: flex; justify-content: center;`（零 `transform`）居中 `.touch-weapons`，`measure()` 时临时移除 `touch-spectator`，并在 [tests/touch-controls.mjs](../../tests/touch-controls.mjs) 加入 CSS 回归断言防复发 |
