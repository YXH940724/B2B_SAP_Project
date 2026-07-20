# 客户自助注册与登录设计

## 目标与范围

门户使用 SAP 客户号识别客户，但不把密码写入 SAP。客户首次访问时可自行注册：系统确认客户号存在、取得 SAP 客户主数据关联的已维护邮箱，并发送一次性验证码。验证码验证通过后，客户设置独立的门户密码；此后以客户号和门户密码登录，再进入下单页面。

本期覆盖注册、登录、验证码、会话和登录页反馈。SAP OData 只用于读取客户和邮箱；销售订单创建策略不变，且 `SAP_WRITE_ENABLED` 默认继续为 `false`。管理员账号、密码找回、生产邮件服务和多节点会话不在本期实现范围内。

## 用户流程

1. 客户在登录页选择“开户注册”，填写 1–10 位 SAP 客户号。
2. 服务端把纯数字客户号规范化为 10 位，读取 SAP 客户和关联业务伙伴邮箱。
3. 若客户可注册且存在邮箱，服务端生成六位验证码，存储其哈希和到期时间，并返回不包含邮箱或验证码的通用成功消息。
4. 开发环境把验证码写到服务端日志；生产环境拒绝使用日志发送方式，必须配置邮件发送器。
5. 客户提交客户号、验证码和至少 12 位的密码。验证通过后创建门户账号。
6. 客户使用客户号和门户密码登录。登录成功创建 HttpOnly 会话 Cookie，前端切换到下单界面；失败信息显示在登录/注册表单内。

验证码十分钟过期、最多验证五次；同一客户号每十分钟最多请求三次。接口返回通用错误，避免通过响应枚举有效客户或邮箱。

## 架构与接口

服务端增加独立的认证模块，不改变 SAP OData 客户端的职责：

- `customer-contact.ts`：把 SAP 客户映射到关联业务伙伴并读取邮箱；没有邮箱时返回“不可注册”。
- `auth-store.ts`：SQLite 数据访问与事务。
- `auth-service.ts`：密码哈希、验证码、限频和登录验证。
- `web-server.ts`：HTTP 会话、认证路由和错误映射。

接口如下：

| 路径 | 用途 |
| --- | --- |
| `POST /api/register/request-code` | 请求验证码，输入 `customer` |
| `POST /api/register/verify` | 输入 `customer`、`code`、`password`，完成注册 |
| `POST /api/login` | 输入 `customer`、`password`，创建会话 |
| `POST /api/logout` | 清除当前会话 |

前端将登录、请求验证码和设置密码分为三个表单状态。网络请求期间按钮禁用并显示“处理中”；任何错误都显示在当前可见表单内，而不是隐藏的下单区域。

## 数据与安全

默认 SQLite 路径为 `data/portal.db`，目录和数据库文件均被 Git 忽略。表包含：

- `portal_users(customer PRIMARY KEY, password_hash, created_at, last_login_at)`
- `verification_codes(customer PRIMARY KEY, code_hash, expires_at, attempts, request_count, request_window_started_at)`

密码和验证码使用 Node.js `crypto.scrypt` 加随机盐生成不可逆哈希；不保存、不返回、不写日志明文密码。开发日志只输出刚生成且尚未过期的验证码，且仅在 `NODE_ENV=development` 与显式 `VERIFICATION_DELIVERY=log` 同时满足时允许。

会话保存为服务器内存中的随机令牌，八小时过期。Cookie 使用 `HttpOnly`、`SameSite=Lax`；当 `NODE_ENV=production` 时加 `Secure`。本期用于单机开发；部署为多实例前必须迁移会话到共享存储。

新增环境变量：

- `PORTAL_DB_PATH`：SQLite 数据库路径，默认 `data/portal.db`。
- `VERIFICATION_DELIVERY`：开发环境为 `log`；生产环境后续配置邮件发送器。

移除门户对全局 `PORTAL_PASSWORD` 的依赖；旧变量不再作为客户登录凭证。

## 错误处理与测试

接口使用可安全展示的中文错误提示；SAP 通信错误继续由服务端清洗，不返回凭证或 OData 原始错误详情。日志不得出现 SAP 密码、门户密码或密码哈希。

自动化测试覆盖：客户号规范化、验证码生成和过期、错误次数与请求限频、重复注册、错误密码、成功注册/登录、会话 Cookie，以及登录失败信息在可见界面中展示。SAP 集成测试保持只读，并通过客户端替身测试无邮箱、无客户和上游失败场景；不执行任何 SAP 写操作。

## 验收标准

1. 客户可在开发环境用 SAP 客户号请求验证码，并只从服务端日志取得验证码。
2. 客户使用正确验证码设置密码后可登录并进入下单界面。
3. 错误验证码、过期验证码、重复注册和错误密码均有可见提示且不创建会话。
4. 密码、验证码、SAP 凭证和数据库文件不进入 Git。
5. 现有 MCP 查询、下单预览和默认禁写保护继续通过测试。
