# SAP OData MCP Server

面向 SAP S/4HANA OData 的 stdio MCP 服务，支持销售订单、物料主数据、客户主数据、销售价格条件的查询，以及受控的销售订单创建和更新。

## 安全模型

- 所有写操作默认 `dry_run=true`，只返回将发送的 OData 负载。
- 真实写入必须同时满足：`SAP_WRITE_ENABLED=true`、`dry_run=false`，以及工具要求的确认短语。
- 更新要求传入 `sap_get_sales_order` 返回的 ETag，以避免覆盖并发修改。
- 可更新字段由 `SAP_WRITE_ALLOWED_FIELDS` 白名单控制。
- 必须通过 `SAP_CA_CERT_PATH` 信任企业 CA。生产环境拒绝关闭 TLS 证书校验。
- 密码和证书不允许写入 Git 仓库。

## 安装与构建

```bash
npm install
npm run build
```

将 `.env.example` 的值保存到仓库外的受保护位置。服务通过 MCP 客户端的 `env` 块接收这些环境变量；参考 [mcp.config.example.json](mcp.config.example.json)。

```bash
npm run check-config
npm start
```

## 工具

| 工具 | 能力 |
| --- | --- |
| `sap_get_sales_order` | 查询订单表头并返回 ETag |
| `sap_get_sales_order_items` | 分页上限内查询订单行项目 |
| `sap_create_sales_order` | 生成或创建销售订单；默认演练模式 |
| `sap_update_sales_order` | 更新白名单内的表头字段；默认演练模式 |
| `sap_get_product` | 查询 `API_PRODUCT_SRV` 的物料主数据 |
| `sap_get_customer` | 查询 `API_BUSINESS_PARTNER` 的客户主数据 |
| `sap_list_sales_price_conditions` | 分页查询 `API_SLSPRICINGCONDITIONRECORD_SRV` 的销售价格条件 |

真实创建须使用 `confirm: "CREATE_SALES_ORDER"`，真实更新须使用 `confirm: "UPDATE_SALES_ORDER"`。创建和更新前请先取得业务变更审批。

## CCFB / Codex 接入

由机器人宿主管理员将构建后的 `dist/index.js` 注册为 stdio MCP，使用 [mcp.config.example.json](mcp.config.example.json) 的结构注入密钥。重启机器人并新开对话后，MCP 工具才会可用。

## 本地下单门户

运行 `npm run build` 后，以环境变量方式提供 `.env.example` 中的配置并执行 `npm run start:web`。门户在 `http://localhost:3000` 提供客户号登录、A305/ZR01 价格校验、购物车和“确认同步 SAP”操作。`SAP_WRITE_ENABLED` 默认关闭；开启前必须完成 SAP 变更审批和服务账号授权。
