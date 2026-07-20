# SAP HANA MCP 本地部署

本项目将 [`hana-mcp-server`](https://www.npmjs.com/package/hana-mcp-server) 固定为可复现的本地 MCP 运行时。服务以 stdio 方式运行，由 Codex、Claude Desktop、VS Code 等 MCP 客户端启动；它不会监听本机网络端口。

## 前置条件

- Node.js 18 或更高版本
- 能从运行 MCP 的电脑访问 SAP HANA SQL 服务（公司网络或 VPN）
- HANA 数据库地址、SQL 端口、只读数据库账号和密码

> `44350` 是一个 HTTPS 端口，并不必然是 HANA SQL 端口。请先与 HANA 管理员确认可由 SAP HANA Node.js 客户端连接的 SQL 端口；MDC 租户数据库通常使用 `3NN13`。

## 安装

```bash
npm install
```

该命令安装锁定在 `package-lock.json` 中的 `hana-mcp-server`。也可以让 MCP 客户端直接执行 `npx -y hana-mcp-server@0.3.2`，无需全局安装。

## 配置 MCP 客户端

复制 [mcp.config.example.json](mcp.config.example.json) 的 `hana` 条目到 MCP 客户端配置中，填入本机的连接信息。不要将真实密码写入本仓库、提交到 Git，或发到聊天中。

本项目默认限制为只读：`INSERT`、`UPDATE`、`DELETE` 和 `TRUNCATE` 均保持禁用；结果集也默认限制为每页 50 行，以降低误操作与上下文泄露风险。

对于 MCP 客户端使用环境变量的场景，可复制 `.env.example` 到受保护的本机位置并设置权限：

```bash
cp .env.example ~/.config/sap-hana-mcp/.env
chmod 600 ~/.config/sap-hana-mcp/.env
```

`.env` 仅用于保存本机环境变量，具体如何注入到客户端取决于所使用的 MCP 客户端；不要将它放回项目目录。

## 离线校验

在不连接数据库的情况下校验运行环境变量：

```bash
HANA_HOST=hana.example.com \
HANA_PORT=31013 \
HANA_USER=readonly_user \
HANA_PASSWORD=replace-locally \
npm run check-config
```

当校验通过后，在 MCP 客户端中重新连接服务，再运行 `hana_test_connection` 完成实际连通性验证。该工具会屏蔽密码；请仅使用最小权限的数据库账号。

## 常用连接字段

| 字段 | 说明 |
| --- | --- |
| `HANA_HOST` | HANA 数据库主机名或 IP，不含 `https://` |
| `HANA_PORT` | HANA SQL 端口，须由管理员确认 |
| `HANA_USER` / `HANA_PASSWORD` | 最小权限的数据库凭据 |
| `HANA_SCHEMA` | 可选的默认 Schema |
| `HANA_INSTANCE_NUMBER` / `HANA_DATABASE_NAME` | 仅 MDC 系统库或租户库需要 |
| `HANA_SSL` / `HANA_ENCRYPT` | TLS SQL 端口通常保持 `true` |

## 安全边界

- 不要将密码、证书或 `.env` 纳入版本控制。
- 生产环境使用最小权限的只读数据库用户。
- 保持 `HANA_ALLOW_INSERT`、`HANA_ALLOW_UPDATE`、`HANA_ALLOW_DELETE` 为 `false`；若未来需要写操作，应另行完成权限评审。
- 将 `HANA_VALIDATE_CERT=false` 限制在自签名测试环境，生产环境应校验证书。
