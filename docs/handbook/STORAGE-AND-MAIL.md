# 玩家存档体系、Toy 云存档配额规划与邮箱全貌（STORAGE & MAIL）

本文档完整盘点「随时随地CS」的**全部玩家存档数据、各层存储去向、B站 Toy 单玩家云存档官方硬上限与 128 键分片规划（v2）**，以及**线上邮箱现存邮件与玩家侧邮箱数据持久化方案**。

---

## 一、B站 Toy 单玩家云存档官方硬上限

核对自官方实时 SDK 文档（`https://www.bilibili.com/toy/publish/sdk`）：

| 维度 | 官方硬限制 | 工程约束说明 |
|---|---|---|
| **隔离粒度** | **登录用户 + 本 Toy** | 跟随 B站登录态自动跨设备持久化（PC Web / B站 App / WebView 互通），**不触发额外数据确认弹窗** |
| **最大 Key 数量** | **128 个 / 玩家 / Toy** | 超出由平台服务端直接拒绝；必须严格做槽位预算 |
| **单个 Key 名称** | `/^[a-zA-Z0-9_-]{1,128}$/`，且**不能以 `__` 开头** | `__` 前缀为平台保留键，禁止读写删 |
| **单个 Value 体积** | **≤ 1,024 UTF-8 字节（1 KiB）** | **最核心红线！** 超过 1024 字节直接被服务端拒写（1 个中文字符占 3 字节） |
| **单玩家理论总容量** | **`128 × 1,024 B = 128 KiB`（131,072 字节）** | 合理压缩与分片后，足够覆盖多年成长、邮箱奖励、全量配置与触控布局 |
| **批量与频次机制** | `getCloudStorage()` 1 次拉全量；`setCloudStorage({...})` 1 次写多键；`removeCloudStorage([...])` 1 次删多键 | 同 Toy 全部玩家共享频次配额，超限抛 `code: 307044`；**仅在关键节点做增量脏写 + 指数退避**（不硬编码 QPS） |
| **跨作品共享存档** | `getSharedStorage` / `setSharedStorage`（同为 128 键 × 1024 B） | 按「玩家 + `storageId`」隔离，未来如需多款 Toy 互通账号资产可无缝复用同一套编解码器 |

> [!CAUTION]
> **重大历史隐患修复记录**：旧版 `v1` 把全部 29 把武器皮肤 + 探员 + 武器槽位塞入单个 `cs_loadout_v1` 键，**即使新号也高达 `1,245` 字节（> 1,024 字节硬上限）**；原 `cs_prog_v1` 在领取 3–5 封邮件后也会突破 `1,024` 字节导致写入被拒。现已全面升级为 **`v2` 自动分片架构**（[shared/toy-cloud-codec.js](../../shared/toy-cloud-codec.js)），单键安全线严控 **`≤ 960` UTF-8 字节**（留 64 字节安全裕量），并无损兼容迁移旧 `v1` 数据。

---

## 二、全量玩家存档盘点（5 层存储全景图）

| 存储层 | 跨设备同步 | 键名 / 文件路径 | 存储内容 | 写入时机与清理策略 |
|---|---|---|---|---|
| **1. B站 Toy 云存档（v2 分片）** | ✅ 全平台跨设备 | `cs2_core`、`cs2_wk_*`、`cs2_gs_*`、`cs2_ga_*`、`cs2_mr_*`、`cs2_mc_*`、`cs2_ci_*`、`cs2_lo_meta`、`cs2_lo_s*`、`cs2_cfg_*` | **所有核心账号资产与个人配置**：生涯战绩、武器专精、关注/三连解锁、邮箱已读/已领/直赠/专属物品、皮肤/探员/携带武器、灵敏度/准星/画面/音频/音乐盒/键鼠键位/触屏与 2/3/4 指自定义布局 | 回合结束、对局结束、社交解锁、邮件读/领、装备/设置修改（2.2s 防抖）、`pagehide` 增量批量同步 |
| **2. 浏览器 `localStorage`（带 `.backup` 双写）** | ❌ 本机缓存 + 离线兜底 | `cs.progression.v1.<uid>` | 当前账号完整成长、社交、邮件状态与专属物品本地镜像 | 每次变更即时落盘，并与云端单调合并 |
| 〃 | 〃 | `dust2.skins.v1`、`dust2.agents.v1`、`dust2.weapon-loadout.v1` | 已装备皮肤/匕首、CT/T 探员、CT/T 武器配置（云端同步镜像） | 装备保存时落盘并触发 2.2s 云同步 |
| 〃 | 〃 | `dust2.cs-settings.v1`、`dust2.quality.v2`、`dust2.brightness`、`dust2.visual-style.v1`、`dust2.map-style.v1`、`dust2.frame-limit.v1`、`dust2.mouse-dpi` | 灵敏度、准星、画面比例/风格/画质/亮度、雷达、人机难度、帧率、鼠标 DPI（云端同步镜像） | 设置修改时经 [client/persistence.js](../../client/persistence.js) 自动触发云同步 |
| 〃 | 〃 | `dust2.volume`、`dust2.music-kit`、`dust2.music-volume` | 主音量、音乐盒曲目、音乐音量（云端同步镜像） | 音频设置变更时自动触发云同步 |
| 〃 | 〃 | `dust2.controls.v1` | 键鼠 26 项自定义按键（云端同步镜像） | 改键时自动触发云同步 |
| 〃 | 〃 | `dust2.touch.v1`、`dust2.motion.v1`、`dust2.fullscreen.v1`、`dust2.touch-layout.v1` | 移动端触屏参数、陀螺仪/辅助瞄准、自动全屏、**2/3/4 指自定义按键位置与大小**（云端同步镜像） | 保存触屏设置或布局时自动触发云同步 |
| 〃 | 〃 | `cs.settings.updatedAt.v1`、`cs.loadout.updatedAt.v1` | 本地设置与装备修订时间戳（跨设备冲突仲裁：新时间戳胜出） | 仅本机使用 |
| 〃 | 〃 | `cs.mail.cache.v1` | 服务端下发的系统邮件正文离线缓存（断网打开邮箱仍可查阅） | 每次成功拉取 `/perf/mail.json` 更新，**不占云档** |
| 〃 | 〃 | `cs.toy.identity.v1`、`cs.toy.guest-id.v1` | Toy SDK 头像/昵称/OpenID 缓存、非 Toy 游客随机干员编号 | 身份初始化时维护，不占云档 |
| 〃 | 〃 | `dust2.last-session`、`dust2.name`、`dust2.runtime-diagnostics.v1`、`dust2.mode-ui.v1` | 最近一次联机房间记录、大厅默认地图/模式记忆、诊断日志 | 仅本机体验，不占云档 |
| **3. 浏览器 `sessionStorage`** | ❌ 单标签页临时 | `cs.room.password.v1`、`cs.join.ticket.v1`、`cs.resume.v1`、`cs2.activeGameOrigin.v1` | 1v1 加密房一次性密码（5 分钟过期且入房即删）、选房跳转票据、30s 断线重连令牌、当前健康 API 入口 | 关页自动清除，绝不写入 URL 或云档 |
| **4. 浏览器 `Cache API`** | ❌ 本机资产缓存 | SHA-256 寻址静态资源缓存 | 溢流地图（Cache/Train）、高阶皮肤、探员与可选音乐盒二进制文件 | 按需下载复用，可在「本地资源」清理 |
| **5. 生产服务端磁盘（4 节点一致）** | 🌐 全服共享配置 | `/opt/cs2-web/mail-announcements.json`、`/opt/cs2-web/cluster-config.json` | 系统邮件公告与奖励定义、4 节点热配置与分流权重 | 2.5s 热加载，无需重启游戏服 |

---

## 三、Toy 128 键 × 1024 字节槽位预算总表（v2）

编解码与硬校验模块：[shared/toy-cloud-codec.js](../../shared/toy-cloud-codec.js)、云同步管理器：[client/toy-cloud-progress.js](../../client/toy-cloud-progress.js)。

| 分组 | Key 命名 | 预留最大键数 | 典型活跃玩家 | 极限满载 | 编码压缩与防爆策略 |
|---|---|---:|---:|---:|---|
| **生涯核心 & 社交** | `cs2_core` | `1` | 1 键 (~240 B) | 1 键 (~280 B) | 短字段键名（`k`/`hs`/`m`/`r`/`w`/`xp`/`s`/`at`），永不超 320 B |
| **武器专精击杀** | `cs2_wk_0..1` | `2` | 1 键 (~150 B) | 1 键 (~460 B) | 仅存击杀数 `> 0` 的武器；29 把全打满也仅 1 键 |
| **直赠皮肤 / 匕首** | `cs2_gs_0..9` | `10` | 0–1 键 (~120 B) | 6 键 (~5.1 KiB) | 按 `≤ 960 B` 自动分片，支持全量 216+ 皮肤直赠 |
| **直赠探员** | `cs2_ga_0..1` | `2` | 0–1 键 (~30 B) | 1 键 (~120 B) | 自动分片，支持全量及未来新增探员 |
| **邮箱已领记录** | `cs2_mc_0..7` | `8` | 0–1 键 (~80 B) | 8 键 (~6.5 KiB) | 存 `claimedMailIds`（最多 300 封） |
| **邮箱仅已读记录** | `cs2_mr_0..7` | `8` | 0–1 键 (~60 B) | 8 键 (~6.5 KiB) | **去重优化**：自动剔除已存在于 `claimedMailIds` 的 ID，省近一半空间 |
| **邮箱已收录专属物品** | `cs2_ci_0..31` | `32` | 0–1 键 (~220 B) | 25–32 键 (~24 KiB) | `customItems`（徽章/称号/货币/道具/收藏品，上限 200 件），紧凑编码并限制单项 `≤ 900 B` |
| **装备元数据** | `cs2_lo_meta` | `1` | 1 键 (~380 B) | 1 键 (~400 B) | 存 CT/T 探员 + CT/T 武器配置 + `updatedAt` |
| **已装备皮肤差分** | `cs2_lo_s0..s2` | `3` | 0–1 键 (~180 B) | 2 键 (~1.4 KiB) | **差分优化**：只存非原厂（`!== STARTER_SKINS[w]`）皮肤，彻底根治原 `cs_loadout_v1` 1245 B 超限 |
| **综合游戏设置** | `cs2_cfg_main` | `1` | 1 键 (~220 B) | 1 键 (~650 B) | 灵敏度、**准星与默认差分**、画面/画质/亮度/风格/人机难度/帧率/DPI |
| **声音与音乐盒** | `cs2_cfg_aud` | `1` | 1 键 (~85 B) | 1 键 (~100 B) | 主音量、音乐盒 ID、音乐音量 |
| **键鼠自定义键位** | `cs2_cfg_k0..k1` | `2` | 0–1 键 (~560 B) | 1–2 键 (~900 B) | `dust2.controls.v1` 26 项键位自动分片 |
| **移动端触屏 & 陀螺仪** | `cs2_cfg_touch` | `1` | 1 键 (~210 B) | 1 键 (~240 B) | `touch` + `motion` + `fullscreen` 打包为 1 键 |
| **2/3/4 指按键布局** | `cs2_cfg_tlay_0..2` | `3` | 0–1 键 (~580 B) | 1–2 键 (~650 B) | 每键坐标压缩为 `[x,y,size,opacity]` 保留 3 位小数，全 21 键 4 指布局仅占 1 键 |
| **战略预留（未分配）** | 预留给未来功能 | **`53`** | `0` | `0` | 预留约 **53 KiB** 给赛季战绩历史、战令任务、涂鸦/快捷语音、好友收藏等 |
| **总计** | — | **`128` 键上限** | **~5–9 键 (~2.5 KiB)** | **~55–65 键 (~48 KiB)** | **写入前强校验：任何键 > 1024 B 或总键 > 128 均提前拦截** |

### 增量同步与旧 `v1` 无损迁移机制
1. **首次拉取**：`loadFromCloud()` 调用无参 `sdk.getCloudStorage()` 一次取回全部键值，同时解析并单调合并旧 `cs_prog_v1`/`cs_loadout_v1` 与新 `cs2_*`，老玩家数据零丢失。
2. **增量脏写（Delta Flush）**：`flushCloud()` 通过 `diffToyCloudEntries(lastCloudSnapshot, nextEntries)` 仅把内容实际变化的键传入单次 `sdk.setCloudStorage(toWrite)`；无变化时不发请求。
3. **安全清理**：仅在 `setCloudStorage` 成功后，才调用 `sdk.removeCloudStorage(toDelete)` 清理多余分片（如重置触控布局后释放 `cs2_cfg_tlay_0`）和已迁移完毕的旧 `cs_prog_v1`/`cs_loadout_v1`。

---

## 四、系统邮箱现状与持久化全貌

### 4.1 服务端现网已配置邮件（`/opt/cs2-web/mail-announcements.json`）

当前 4 台生产节点（`xiangyang`、`server-156`、`ningbo`、`kunming`）均同步运行以下邮件配置（热更新周期 2.5 秒，完整格式模板见 [ops/mail-announcements.example.json](../../ops/mail-announcements.example.json)）：

| 邮件 ID | 分类 | 置顶 | 受众范围 | 标题 | 附件奖励明细 |
|---|---|---|---|---|---|
| `welcome-2026-launch` | `reward`（奖励） | ✅ 是 | `all`（全服） | 新版本更新说明 & 干员见面补给 | 1. 武器皮肤 `deagle-conspiracy`（沙漠之鹰｜阴谋）<br/>2. 生涯经验 `+500 XP`<br/>3. 专属徽章 `badge-pioneer-s1`（S1 先锋干员纪念章 ×1） |
| `notice-1v1-password` | `announcement`（公告） | 否 | `all`（全服） | 自建 1v1 密码房使用指引 | 无附件（阅读即消红点） |
| `example-targeted-gift` | `compensation`（补偿） | 否 | `uids`（仅占位示例账号，**正式玩家不可见**） | 定向皮肤补发示例（仅指定账号可见） | 演示模板：`karambit-sapphire` + `ct-ava`（实际定向补发时替换 `id` 与目标 `toyOpenId`） |

### 4.2 邮箱数据的双端职责划分

1. **服务端存「邮件本体」**：公告文案、发件人、置顶标记、起止时间（`startsAt` / `expiresAt`）、受众规则（`all` 或 `targetUids`，对外返回时自动剥离 `targetUids`）、以及奖励清单 `rewards`。
2. **玩家云端存「阅读/领取凭证 + 归属资产」**：
   - `cs2_mr_*` / `cs2_mc_*`：记录哪些邮件已读、哪些邮件附件已领（防重复领取 + 跨设备同步红点状态）；
   - `cs2_gs_*` / `cs2_ga_*` / `cs2_core.xp` / `cs2_ci_*`：领取附件后，皮肤、匕首、探员、经验与专属物品直接写入玩家永久云存档。**即使原邮件日后过期或从服务器下架，玩家已领取的所有物品与皮肤也永久保留，永不消失。**
3. **运营发邮件的容量最佳实践**：
   - 邮件 `id` 尽量简短清晰（建议 12–24 字符，如 `s1-comp-01`），可让 300 封历史记录轻松控制在 8 键以内；
   - 新增通用道具（`type: "item"`）的 `description` 控制在 40 字以内、`itemId` 控制在 24 字符以内，200 件道具也能舒适落在 32 键预算内；
   - 长期过期不再需要的老公告可定期从服务端 `mail-announcements.json` 归档清理，减轻 `/perf/mail.json` 下发体积，同时不影响老玩家云档里已拿到的奖励。
