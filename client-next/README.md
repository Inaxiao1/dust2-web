# DUSKRAIN Next-Gen Web Client (`client-next`)

> 对应总规约 [../SPEC.md](../SPEC.md) Phase 3 与迁移规约 [../docs/WEB-CLIENT-MIGRATION-SPEC.md](../docs/WEB-CLIENT-MIGRATION-SPEC.md)。本目录为完全纯静态的前端工程，**不依赖任何本地游戏后端源码打包**，构建产物可直接部署到 CDN / OSS / Cloudflare Pages。

## 技术栈

- **语言与构建**：TypeScript + Vite 8
- **3D 渲染**：Three.js `WebGPURenderer`（`three/webgpu`，自动优先 WebGPU 并在不支持的浏览器平滑回退 WebGL2）
- **UI / HUD**：SolidJS（细粒度信号驱动大厅与高刷新局内 HUD）
- **物理预测**：`PhysicsKernel` 抽象接口（Phase 3A 使用 `TSPhysicsKernel` + `three-mesh-bvh`，Phase 3D 切换 Rust/WASM `WasmPhysicsKernel`）

## 目录结构

```text
client-next/
├── README.md                  # 本说明文档
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── public/                    # 可选静态 client-config.json 模板
├── src/
│   ├── assets/
│   │   └── cdn-loader.ts      # CORS + SHA-256 校验 + CacheStorage 地图/GLTF 加载器
│   ├── config/runtime.ts      # 控制面 API 与 CDN 资产域名配置解析
│   ├── input/
│   │   └── fps-controller.ts  # Pointer Lock + 拖拽视角回退 + 30Hz 键鼠采样
│   ├── net/
│   │   ├── protocol.ts        # 控制面 REST + Battle Worker WS 强类型协议定义
│   │   ├── control-plane.ts   # ControlPlaneClient（列表、建房、进房、健康检查）
│   │   └── game-socket.ts     # GameSocketClient（直连 Worker WSS + JoinToken 鉴权 + 30Hz 输入）
│   ├── physics/
│   │   ├── kernel.ts          # PhysicsKernel 接口契约
│   │   ├── ts-kernel.ts       # TSPhysicsKernel 过渡实现（BVH 射线与步进预测）
│   │   └── reconciliation.ts  # PredictionReconciler（30Hz 预测 + 15Hz seq 调和）
│   ├── platform/
│   │   └── toy-sdk.ts         # 官方 B站 Toy SDK 宿主探测、身份读取与 307044 指数退避
│   ├── render/
│   │   └── renderer.ts        # WebGPU / WebGL2 自适应视口、GLTF 地图挂载与预测相机
│   ├── state/
│   │   └── match-store.ts     # SolidJS Signals 状态管理
│   ├── ui/
│   │   ├── App.tsx
│   │   ├── Lobby.tsx          # 跨图公开房间大厅、建房、房间码加入
│   │   ├── Hud.tsx            # 血甲、弹药、金钱、倒计时、比分、预测误差与事件提示
│   │   └── styles.css
│   └── main.ts
└── tests/                     # Node 原生 TypeScript 单元测试

## B站 Toy 预检与发布说明

详见 [../docs/TOY-DELIVERY-SPEC.md](../docs/TOY-DELIVERY-SPEC.md)。构建后在上传前先用 Toy skill 的 `toy_doctor.py` 预检 `dist/`：

```bash
npm run build
python3 ~/.codex/skills/toy/scripts/toy_doctor.py dist --slug <your-slug> --json
```
```

## 运行与验证

```bash
# 1. 安装依赖
cd client-next && npm install

# 2. 类型检查与单元测试
npm run typecheck
npm test

# 3. 本地开发（配合 Go 控制面 :8080 与 Node 纯逻辑 Worker）
npm run dev

# 4. 构建纯静态 CDN 产物
npm run build
```

## 运行时配置（无须重构建即可切环境）

可通过构建环境变量或同源静态文件 `public/client-config.json`（部署后置入 CDN 根目录）指定后端入口：

```json
{
  "controlPlaneUrl": "https://lobby.example.com",
  "assetBaseUrl": "https://downloads.example.com/releases/latest/assets/",
  "mapBaseUrl": "https://downloads.example.com/releases/latest/maps/"
}
```
