# 门户订单持久化设计

## 目标

将已成功同步至 SAP 的门户订单保存到现有 `PORTAL_DB_PATH` 指定的 SQLite 数据库。服务重启后，订单中心仍可按当前登录客户读取门户同步订单，并与 SAP 历史订单共同形成近 12 个月统计。

## 范围

- 复用默认数据库 `data/portal.db`，不引入第二个数据库文件或外部服务。
- 仅在 SAP 创建销售订单成功后写入本地记录；SAP 写入失败时不产生本地订单记录。
- 保存客户、SAP 销售订单号、销售范围、金额、币种、同步状态和创建时间。
- 订单中心继续分别展示 SAP 历史订单和门户同步订单；统计基于两类记录合并计算。
- 不保存 SAP 服务账号、门户明文密码、CSRF Token 或完整下单报文。

## 数据模型

在现有 SQLite 初始化脚本中增加表：

```sql
CREATE TABLE IF NOT EXISTS portal_order_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL,
  sales_order TEXT NOT NULL,
  sales_organization TEXT NOT NULL,
  total_amount REAL NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(customer, sales_order)
);
CREATE INDEX IF NOT EXISTS idx_portal_order_submissions_customer_created
  ON portal_order_submissions(customer, created_at DESC);
```

`customer` 固定保存十位补零后的 SAP 客户号；`created_at` 使用 UTC 的 `YYYY-MM-DD`；订单号缺失时使用服务端返回的占位文本，但正常 SAP 成功响应应提供销售订单号。

## 组件边界

- `src/auth-store.ts`：扩展 `AuthStore`，提供参数化的新增与按客户查询方法；仅负责 SQLite 读写。
- `src/order-history.ts`：接收持久化存储接口，写入门户订单并在 `list()` 时读取近 12 个月的门户订单；保留 SAP OData 的只读查询职责。
- `src/web-server.ts`：将创建的 `AuthStore` 同时注入认证服务与订单历史服务，保证两者使用同一个数据库连接。
- `src/portal-app.ts`：维持现有“SAP 创建成功后记录门户订单”的调用点，不新增 SAP 写操作。

## 数据流与失败处理

1. 用户确认订单，服务完成既有可售性验证并调用 SAP 创建销售订单。
2. SAP 返回成功后，服务将订单摘要插入 `portal_order_submissions`。
3. 本地持久化失败时，请求返回错误并记录服务端日志；不重复向 SAP 发起创建请求，避免重复订单。
4. 订单中心先读取 SAP 历史订单和本地门户订单，再计算最近 12 个月的仪表盘。

## 验收与测试

- 内存 SQLite 测试验证记录在服务实例重建后仍可读取（共享临时数据库文件）。
- 验证不同客户之间的数据隔离，且仅返回最近 12 个月记录。
- 验证同一客户与 SAP 订单号重复写入不会产生重复记录。
- 运行完整 `npm test` 与 `npm run build`。
