# B2B SAP Project 封版交接说明

> 版本：2026-07-22  
> 仓库：[YXH940724/B2B_SAP_Project](https://github.com/YXH940724/B2B_SAP_Project)
> 基线：`main` 分支  
> 适用对象：业务测试、实施顾问、运维与后续开发人员

## 1. 项目目标

本项目提供一个面向 SAP S/4HANA 测试环境的客户订货门户，以及受保护的 SAP OData 销售订单能力。门户以客户登录身份隔离数据，可浏览可销物料、维护购物车并按销售范围拆分订单，再将确认后的订单写入 SAP。

## 2. 当前已交付能力

| 模块 | 已实现能力 |
| --- | --- |
| 门户注册与登录 | 本地 SQLite 保存门户密码与一次性验证码；门户密码不等同于 SAP 密码。开发环境验证码写入启动终端日志。 |
| 客户与销售范围 | 读取客户资料、客户 360 信息及客户所属销售范围；所有目录、价格与订单读取均以登录客户为边界。 |
| 商品目录 | 根据销售范围查询可销物料；A305 条件表先筛选，价格条件类型使用 `PR00`；展示物料描述并支持登录语言。 |
| 订单录入 | 支持订单抬头、付款条款、国际贸易条款/地点、客户料号、工厂、库位、税务展示和购物车结算。 |
| 订单中心 | 展示 SAP 销售订单、仪表盘、筛选、分析、结构化行项目、订单详情及打印预览。 |
| SAP 创建订单 | 获取 CSRF Token 与会话 Cookie 后深插入 SAP 销售订单；创建受 `SAP_WRITE_ENABLED` 和前端确认控制。 |
| 商城订单唯一标识 | 每次确认生成 `MALL-YYYYMMDD-XXXXXXXX` 母单号；按销售范围生成 `-01`、`-02` 子单号，写入 SAP 抬头字段 `PurchaseOrderByShipToParty`。 |
| 幂等与重试 | SQLite 保存母单/子单状态；对已成功子单直接返回 SAP 订单号；请求中断后先按子单号回查 SAP，再决定是否创建。 |

## 3. 关键业务规则

1. 一个购物车存在多个销售范围时，系统按完整销售范围（销售组织/分销渠道/产品组）拆单。
2. 商城母单号用于门户侧统一追踪，SAP 中保存的是每个销售范围对应的商城子单号。
3. `PurchaseOrderByCustomer` 是客户采购订单号；不得用商城订单号覆盖它。
4. 订单中心可按 SAP 订单号、客户采购订单号或商城子单号检索。
5. SAP 创建失败时，一个销售范围的失败不会阻止其他销售范围处理；结果页分别显示成功/失败和 SAP 销售订单号。
6. 购物车在提交后保留，不自动清空。

## 4. 环境配置与安全要求

### 4.1 配置文件

- `.env.example` 仅是安全模板，全部值均为占位符或安全默认值。
- 真实 SAP 地址、SAP Client、用户名和密码只能保存在受保护的本地 `.env` 或组织级密钥管理系统中，禁止提交 Git。
- `.env` 文件建议权限为 `600`。
- `SAP_WRITE_ENABLED` 默认必须为 `false`；仅在获得批准的测试窗口内临时启用。

### 4.2 开发环境启动

在实际项目根目录执行：

```bash
git pull --ff-only origin main
npm install
set -a
source .env
set +a
export NODE_ENV=development
export VERIFICATION_DELIVERY=log
npm run start:web
```

浏览器访问 `http://localhost:3000`。

若需要测试创建 SAP 订单，额外设置：

```bash
export SAP_WRITE_ENABLED=true
```

重启服务后环境变量需要重新加载。

### 4.3 常见运行问题

| 现象 | 原因 | 处理方式 |
| --- | --- | --- |
| `SAP writes are disabled` | 进程未加载 `SAP_WRITE_ENABLED=true` | 停止服务，重新加载 `.env` 后导出该变量再启动。 |
| `Log verification delivery is not allowed in production` | `NODE_ENV=production` 与 `VERIFICATION_DELIVERY=log` 冲突 | 测试环境使用 `NODE_ENV=development`。 |
| 登录后出现 `SAP OData request failed` | 登录成功后的 `/api/me` 读取 SAP 客户资料失败 | 检查加载的 `.env` 是否仍为 `sap.example.com` 占位配置，确认测试 SAP 地址、Client、网络/VPN 和账号。 |
| 原门户密码失效 | 使用了不同的 `PORTAL_DB_PATH`，读到了新的 SQLite 数据库 | 显式指定原 `portal.db` 的绝对路径后重启服务。 |
| `git fetch` 无输出 | Git 没有需要显示的新对象时正常静默 | 用 `git log -1 --oneline` 和 `git status --branch --short` 核对结果。 |

## 5. 数据与接口边界

### SAP 读取

- 销售订单：`API_SALES_ORDER_SRV`。
- 客户、销售范围与条款：`API_BUSINESS_PARTNER`，客户销售范围实体为 `A_CustomerSalesArea`。
- 物料：`API_PRODUCT_SRV`。
- 价格：`API_SLSPRICINGCONDITIONRECORD_SRV`。

### SAP 写入

- 销售订单深插入：`POST /A_SalesOrder`。
- 写入前必须获取 `X-CSRF-Token`，并携带服务器返回的会话 Cookie。
- 商城子单号写入 `PurchaseOrderByShipToParty`。
- 生产写入应另行完成权限、审批、审计与回滚评估；本项目当前配置面向测试环境联调。

## 6. 验证基线

封版前已完成以下验证：

```bash
npm run build
npm test
```

结果：TypeScript 构建通过，自动化测试 **71/71** 通过。

自动化测试覆盖本地门户认证、客户/目录/价格、付款与贸易条款、SAP CSRF 会话、订单历史、商城订单号生成、SAP 子单号映射、重复提交、响应丢失后的 SAP 回查及界面静态契约。

## 7. 分支与封版状态

- 封版基线为远端 `origin/main`。
- 已检查所有当前可见本地与远端分支；`session/d1f90d2aa648` 已被 `main` 包含。
- 当前未发现未合入 `main` 的可见功能分支。
- 保留会话分支仅用于历史追溯；后续开发应从最新 `main` 新建功能分支。

## 8. 后续建议

1. 在正式发布前，将日志验证码投递替换为企业邮件、短信或统一身份认证。
2. 为 SAP 写入增加业务审批、操作人审计、请求/响应脱敏日志和可观测性告警。
3. 使用部署平台的密钥管理能力替代手工 `source .env`。
4. 在每次 SAP 服务升级后，复测客户销售范围、价格 A305、CSRF 创建和商城订单号回查。

## 9. 待确认事项

- 生产环境的验证码投递渠道与账号生命周期策略。
- 生产 SAP 中 `PurchaseOrderByShipToParty` 字段长度、索引和允许查询的权限。
- 订单创建失败后的业务补偿、人工重试和撤销流程。
