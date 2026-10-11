# Guide Studio

> 把操作讲清楚。轻量、优雅的跨设备图文教程制作器。

Guide Studio V1 先服务于「言序 · Yanxu」微信小程序的操作教程，未来可独立服务其他小程序、网站与软件团队。

## 已实现的 V1 功能

- **零门槛本地创作**：无需登录即可制作教程，草稿自动保存到浏览器 IndexedDB（仅当前设备）。
- **截图编辑**：手机相册多选、电脑拖拽/粘贴截图；画圈、方框、箭头、自由笔、文字、步骤序号、不可逆遮挡；支持移动对象、矩形缩放、删除、撤销与重做。
- **步骤化教程**：图片与文字分离、多步骤、移动排序、分类和适用角色。
- **导出**：单步 PNG、完整离线 HTML（图片内嵌，可直接分发）。
- **云端功能**：登录、云端草稿保存、公开教程发布、稳定链接、FAQ 关联、项目与成员基础 API。
- **隐私**：原图只在授权空间可见；公开版本仅使用前端压平生成的导出 PNG；发布快照与后续草稿编辑隔离。
- **存储**：本地文件上传目录；可用配置切换到腾讯云 COS 私有桶。

## 5 分钟本地启动

需要 Python 3.11+。

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env，至少设置唯一的 SESSION_SECRET（>=32 字符）、管理员邮箱及强密码（>=12 字符）。
set -a; source .env; set +a
uvicorn server.main:app --reload --port 8000
```

访问 **http://localhost:8000**。初次使用可直接制作并导出，无须登录；若要使用云端保存和公开发布，点击「连接云端」，输入 `.env` 的初始管理员账户。

注意：示例 `.env.example` 内的凭据只是占位文本，**上线前必须更换**。本项目默认不允许开放注册；管理员通过受保护的 `/api/members` 接口添加志愿者。

## Docker + PostgreSQL 部署

```bash
cp .env.example .env
# 在 .env 填写安全凭据，并额外增加：POSTGRES_PASSWORD=...；PUBLIC_BASE_URL=https://your-domain
# 配置 HTTPS 反向代理、备份、CORS 和 COS 后：
docker compose up -d --build
```

生产建议使用 PostgreSQL、HTTPS、非 root 运行、可信反向代理；需要在代理层设置限速、请求体上限和安全日志。SQLite 只用于单机快速开发。默认后端监听 8000，生产不要直接把 HTTP 端口暴露到公网。

## 腾讯云 COS

将 `.env` 改为 `STORAGE_BACKEND=cos`，填写 `COS_BUCKET`（完整桶名称，包括 AppID 后缀）、`COS_REGION`、`COS_ENDPOINT` 与服务端凭据；使用**私有读写桶**，不要把密钥放入前端代码。当前 V1 使用后端上传和临时签名下载，适合中小规模教程；大规模上传优化为 STS 限权直传。详情参见 [开发部署手册](docs/05-开发与部署手册.md)。

## 工程结构

```text
Guide-Studio/
├── web/                 # 无需构建工具的原生 Web UI（移动端/桌面端）
│   ├── index.html
│   ├── styles.css       # Design tokens + responsive layout
│   ├── app.js           # SPA、IndexedDB、本地/云端教程管理
│   ├── canvas.js        # 非破坏性 Canvas 标注与原尺寸 PNG 导出
│   └── favicon.svg
├── server/              # FastAPI + SQLAlchemy + signed cookie auth
│   ├── main.py          # REST、发布快照、成员权限
│   ├── db.py            # 数据库实体
│   ├── auth.py          # scrypt 密码、签名会话、Origin 校验
│   └── storage.py       # 本地目录 / 腾讯 COS
├── tests/               # 权限、API、发布和隐私回归测试
├── docs/                # 产品/技术/数据/设计/部署/测试文档
├── Dockerfile
├── docker-compose.yml
└── requirements.txt
```

## 测试

```bash
python -m pytest -q tests/
python -m compileall -q server/
node --check web/app.js
node --check web/canvas.js
```

浏览器测试矩阵：iOS Safari、微信内置浏览器、Android Chrome/微信、macOS Chrome/Safari、Windows Chrome/Edge。当前自动测试涵盖后端与隐私边界；**浏览器端真机触控、相册下载与 COS 实桶联调仍需部署后验收**，请勿将其视为已通过。

## 当前限制（真实 V1 边界）

- 当前使用一个基础管理员账户与 API 创建协作者，没有完整的可视化成员管理。
- 同一篇教程为乐观锁协作，不支持实时共同编辑；冲突返回 HTTP 409，避免静默覆盖。
- FAQ 首版支持添加、关联及删除，CSV 批量导入、分析看板、评论审核队列暂未实现。
- 离线模式依赖单浏览器 IndexedDB；浏览器清理数据会删除本地稿件。请导出 HTML 备份或登录云端。
- 公开阅读页为响应式 H5；直接嵌入微信小程序须完成合法域名配置和微信客户端测试。
- 图片导出保留原图像素尺寸，但有标注时需重新编码 PNG，不能声称字节级无损。

## 文档导航

1. [V1 产品需求与用户流程](docs/01-产品需求与MVP.md)
2. [技术架构与方案选型](docs/02-技术架构与选型.md)
3. [数据模型与接口协议](docs/03-数据模型与接口.md)
4. [UI / UX 设计系统](docs/04-UIUX设计规范.md)
5. [开发部署与 COS 对接](docs/05-开发与部署手册.md)
6. [测试验收、风险和迭代路线](docs/06-测试验收与迭代.md)

**状态：V1 开发交付（待真实云环境部署与跨设备验收）。**

## V1.1 · 标注操作记录与本地视频预览（2026-10-11）

从 [`design/annotation-timeline-v1`](https://github.com/kevin-meng/Guide-Studio/tree/design/annotation-timeline-v1) 分支运行可体验：

- 每个标注的稳定 ID、创建序号、画笔路径采样，以及操作事件日志（IndexedDB V2，本机保存，可导出 JSON）。
- 点击编辑器的「动画预览」，自动让最终圆圈、箭头、文字按顺序出场；可手动调整本步骤出场次序。
- 支持 Canvas 本地视频录制：浏览器允许的格式为 MP4 或 WebM；不是所有手机/微信浏览器都能直接下载视频。
- 隐私遮挡在每一帧开始展示前均已生效，视频和公共教程不会公开原图及私有事件记录。
- 最终图层和播放顺序可通过原 Guide JSON 同步云端；**完整编辑事件暂仅存本机**。视频导出需由实际设备测试。

详情：[视频时间线设计](docs/07-标注事件与视频时间线设计.md) · [本地启动及验收](docs/08-事件记录与动画预览本地验收.md) · [测试](tests/timeline.test.mjs)。

V1.1 验证命令：

```bash
python -m pytest -q tests/
node --test tests/timeline.test.mjs
```
