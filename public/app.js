const $ = (id) => document.getElementById(id);
const cart = [];
let customerSalesAreas = [];
const catalogState = { page: 1, pageSize: 20, query: "", group: "", sort: "material", language: "ZH", salesArea: null };
const orderState = { page: 1, pageSize: 20, from: "", to: "", salesArea: "", overallStatus: "", deliveryStatus: "", query: "", sort: "createdAt:desc" };
let lastPreview = null;
let lastOrderDetail = null;

const authNote = (text) => { $("auth-message").textContent = text; };
const portalNote = (text) => { $("portal-message").textContent = text; };

function setBusy(button, busy, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? text : button.dataset.label;
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showAuth(panel) {
  ["login-panel", "register-request-panel", "register-verify-panel"].forEach((id) => { $(id).hidden = id !== panel; });
  authNote("");
}

function groupClass(group) {
  const palette = ["blue", "green", "gold", "purple", "teal"];
  const value = [...group].reduce((total, char) => total + char.codePointAt(0), 0);
  return palette[value % palette.length];
}

function salesAreaLabel(area) {
  return area ? `${area.salesOrganization} / ${area.distributionChannel} / ${area.division}` : "SAP 未维护";
}

function groupCartBySalesArea(lines = cart) {
  const groups = new Map();
  lines.forEach((line) => {
    const key = line.salesArea?.key || `${line.salesArea?.salesOrganization || ""}/${line.salesArea?.distributionChannel || ""}/${line.salesArea?.division || ""}`;
    const group = groups.get(key) || { salesArea: line.salesArea, items: [] };
    group.items.push(line);
    groups.set(key, group);
  });
  return [...groups.values()];
}

function cartTotal() {
  return cart.reduce((sum, item) => sum + Number(item.unitPrice) * item.quantity, 0);
}

function renderCustomer(profile) {
  const panel = $("customer-summary");
  panel.replaceChildren();
  panel.append(element("div", "customer-avatar", "客户"));
  panel.append(element("p", "eyebrow", "客户信息"));
  panel.append(element("h2", "customer-name", profile.name));
  const fields = [["客户号", profile.customer], ["账户组", profile.accountGroup || "—"], ["业务伙伴", profile.businessPartner]];
  fields.forEach(([label, value]) => {
    const row = element("p", "customer-field");
    row.append(element("span", "", label), element("strong", "", value));
    panel.append(row);
  });
  panel.append(element("hr"));
  panel.append(element("p", "eyebrow", "订购规则"));
  panel.append(element("p", "sidebar-note", "仅展示 A305 / PR00 当前有效价格物料。"));
}

async function loadSalesAreas() {
  const areas = await api("/api/sales-areas");
  customerSalesAreas = areas;
  const select = $("sales-area-select");
  select.replaceChildren();
  if (!areas.length) throw new Error("当前客户未维护可用销售范围。");
  areas.forEach((area) => {
    const option = document.createElement("option");
    option.value = area.key;
    option.textContent = `${area.salesOrganization} / ${area.distributionChannel} / ${area.division}`;
    option.dataset.salesOrganization = area.salesOrganization;
    option.dataset.distributionChannel = area.distributionChannel;
    option.dataset.division = area.division;
    select.append(option);
  });
  const defaultArea = areas.find((area) => area.salesOrganization === "1310" && area.distributionChannel === "10")
    || areas.find((area) => area.salesOrganization === "1310")
    || areas[0];
  select.value = defaultArea.key;
  catalogState.salesArea = defaultArea;
}

function renderGroups(groups) {
  const host = $("material-groups");
  host.replaceChildren();
  const all = element("button", `group-button${catalogState.group ? "" : " active"}`, "全部有效物料");
  all.type = "button";
  all.addEventListener("click", () => loadCatalog({ group: "", page: 1 }));
  host.append(all);
  groups.forEach((group) => {
    const button = element("button", `group-button${catalogState.group === group.code ? " active" : ""}`);
    button.type = "button";
    button.append(element("span", "", group.label), element("small", "", String(group.count)));
    button.addEventListener("click", () => loadCatalog({ group: group.code, page: 1 }));
    host.append(button);
  });
}

function addToCart(item) {
  const salesArea = catalogState.salesArea ? { ...catalogState.salesArea } : null;
  const existing = cart.find((line) => line.product === item.product && line.salesArea?.key === salesArea?.key);
  if (existing) existing.quantity += 1;
  else cart.push({ ...item, salesArea, quantity: 1 });
  renderCart();
  portalNote(`${item.product} 已加入购物车。`);
}

function renderCatalog(items) {
  const host = $("catalog-grid");
  host.replaceChildren();
  if (!items.length) {
    host.append(element("p", "empty-state", "未找到符合条件的有效价格物料。"));
    return;
  }
  items.forEach((item) => {
    const card = element("article", "product-card");
    const hero = element("div", `product-hero ${groupClass(item.productGroup)}`);
    hero.append(element("span", "product-group", item.productGroup === "UNCLASSIFIED" ? "未分类" : item.productGroup), element("strong", "material-number", item.product.replace(/^0+/, "") || item.product));
    const body = element("div", "product-body");
    body.append(element("h3", "product-description", item.description || "SAP 未维护描述"));
    body.append(element("p", "product-unit", `销售单位：${item.baseUnit || item.priceUnit || "—"}`));
    body.append(element("p", "product-price", `${item.currency || ""} ${Number(item.unitPrice).toFixed(2)} / ${item.priceUnit || item.baseUnit || "—"}`.trim()));
    body.append(element("span", "sales-area-tag", salesAreaLabel(catalogState.salesArea)));
    const button = element("button", "add-cart", "加入购物车");
    button.type = "button";
    button.addEventListener("click", () => addToCart(item));
    body.append(button);
    card.append(hero, body);
    host.append(card);
  });
}

function renderPagination(data) {
  const host = $("catalog-pagination");
  host.replaceChildren();
  if (!data.total) return;
  const previous = element("button", "pagination-button", "上一页");
  previous.type = "button";
  previous.disabled = data.page <= 1;
  previous.addEventListener("click", () => loadCatalog({ page: data.page - 1 }));
  const next = element("button", "pagination-button", "下一页");
  next.type = "button";
  next.disabled = data.page >= data.pageCount;
  next.addEventListener("click", () => loadCatalog({ page: data.page + 1 }));
  host.append(previous, element("span", "page-summary", `第 ${data.page} / ${data.pageCount || 1} 页，共 ${data.total} 件`), next);
}

function renderCart() {
  const host = $("cart-items");
  host.replaceChildren();
  const quantity = cart.reduce((sum, item) => sum + item.quantity, 0);
  $("cart-count").textContent = String(quantity);
  if (!cart.length) host.append(element("p", "empty-cart", "购物车为空，选择商品后可在这里调整数量。"));
  cart.forEach((item) => {
    const row = element("article", "cart-line");
    row.append(element("strong", "", item.product.replace(/^0+/, "") || item.product), element("p", "cart-description", item.description || "SAP 未维护描述"), element("span", "sales-area-tag", salesAreaLabel(item.salesArea)), element("p", "cart-price", `${item.currency || ""} ${Number(item.unitPrice).toFixed(2)} / ${item.priceUnit || item.baseUnit || "—"}`.trim()));
    const controls = element("div", "quantity-controls");
    const decrement = element("button", "icon-button", "−");
    decrement.type = "button";
    decrement.setAttribute("aria-label", `减少 ${item.product} 数量`);
    decrement.disabled = item.quantity <= 1;
    decrement.addEventListener("click", () => { item.quantity -= 1; renderCart(); });
    const count = element("span", "", String(item.quantity));
    const increment = element("button", "icon-button", "+");
    increment.type = "button";
    increment.setAttribute("aria-label", `增加 ${item.product} 数量`);
    increment.addEventListener("click", () => { item.quantity += 1; renderCart(); });
    const remove = element("button", "remove-line", "删除");
    remove.type = "button";
    remove.addEventListener("click", () => { cart.splice(cart.indexOf(item), 1); renderCart(); });
    controls.append(decrement, count, increment, remove);
    row.append(controls);
    host.append(row);
  });
  $("cart-total").textContent = groupCartBySalesArea().map((group) => `${salesAreaLabel(group.salesArea)}：${group.items[0]?.currency || "¥"}${group.items.reduce((sum, item) => sum + Number(item.unitPrice) * item.quantity, 0).toFixed(2)}`).join(" · ") || "合计 ¥0.00";
  $("checkout-button").disabled = !cart.length;
}

function showView(name) {
  const views = { catalog: "view-catalog", orderEntry: "view-order-entry", customer360: "view-customer-360", orders: "view-orders" };
  Object.entries(views).forEach(([viewName, id]) => { $(id).hidden = viewName !== name; });
}

function inputCell(value, placeholder, onChange, maxLength) {
  const input = document.createElement("input");
  input.value = value || "";
  input.placeholder = placeholder;
  if (maxLength) input.maxLength = maxLength;
  input.addEventListener("change", () => onChange(input.value.trim()));
  return input;
}

function selectCell(options, selected, onChange, emptyLabel) {
  const select = document.createElement("select");
  if (emptyLabel) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = emptyLabel;
    select.append(empty);
  }
  options.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  });
  select.value = selected || "";
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

async function loadOrderDefaults(group) {
  const area = group.salesArea;
  const params = new URLSearchParams({ salesOrganization: area.salesOrganization, distributionChannel: area.distributionChannel, division: area.division });
  return api(`/api/order-defaults?${params}`);
}

async function loadFulfillmentOptions(item) {
  if (item.fulfillment) return item.fulfillment;
  item.fulfillment = await api(`/api/products/${encodeURIComponent(item.product)}/fulfillment`);
  if (!item.productionPlant) item.productionPlant = item.fulfillment.defaultPlant || "";
  const locations = item.fulfillment.storageLocationsByPlant?.[item.productionPlant] || [];
  if (!item.storageLocation && locations.length === 1) item.storageLocation = locations[0];
  return item.fulfillment;
}

function renderOrderWorkbenchTotals() {
  const host = $("order-workbench-totals");
  host.replaceChildren();
  groupCartBySalesArea().forEach((group) => {
    const total = group.items.reduce((sum, item) => sum + Number(item.unitPrice) * item.quantity, 0);
    const row = element("p", "summary-total-row");
    row.append(element("span", "", salesAreaLabel(group.salesArea)), element("strong", "", formatMoney(group.items[0]?.currency, total)));
    host.append(row);
  });
}

async function renderOrderEntry() {
  const host = $("order-entry-groups");
  host.replaceChildren();
  if (!cart.length) {
    host.append(element("p", "empty-state", "购物车为空，请先选择商品。"));
    return;
  }
  const groups = groupCartBySalesArea();
  host.append(element("p", "empty-state", "正在读取 SAP 客户条款与物料履约主数据…"));
  $("customer-payment-terms").value = "";
  $("incoterms-classification").value = "";
  $("incoterms-location").value = "";
  try {
    const defaults = await Promise.all(groups.map((group) => loadOrderDefaults(group)));
    const allItems = groups.flatMap((group) => group.items);
    await Promise.all(allItems.map((item) => loadFulfillmentOptions(item)));
    const first = defaults[0] || {};
    $("customer-payment-terms").value = first.paymentTerms || "";
    $("incoterms-classification").value = first.incotermsClassification || "";
    $("incoterms-location").value = first.incotermsLocation || "";
  } catch (error) {
    portalNote(`订单主数据读取失败：${error.message}`);
  }
  host.replaceChildren();
  groups.forEach((group) => {
    const section = element("section", "sales-order-group");
    section.append(element("p", "eyebrow", "销售订单组"), element("h3", "", salesAreaLabel(group.salesArea)));
    const header = element("dl", "order-header-grid");
    [["订单类型", "OR"], ["售达方", "当前登录客户"], ["销售范围", salesAreaLabel(group.salesArea)], ["行项目", `${group.items.length} 行`]].forEach(([label, value]) => header.append(element("dt", "", label), element("dd", "", value)));
    const table = document.createElement("table");
    table.className = "order-lines-table";
    table.innerHTML = "<thead><tr><th>物料号 / 描述</th><th>数量</th><th>客户料号</th><th>工厂</th><th>库位</th><th>单价</th><th>税务预览</th><th>行金额</th></tr></thead>";
    const body = document.createElement("tbody");
    group.items.forEach((item) => {
      const row = document.createElement("tr");
      const material = element("td", "order-material-cell");
      material.append(element("strong", "", item.product.replace(/^0+/, "") || item.product), element("span", "", item.description || "SAP 未维护描述"));
      row.append(material);
      row.append(element("td", "", `${item.quantity} ${item.priceUnit || item.baseUnit || "—"}`));
      const customerMaterial = document.createElement("td");
      customerMaterial.append(inputCell(item.customerMaterial, "选填", (value) => { item.customerMaterial = value; }, 35));
      row.append(customerMaterial);
      const fulfillment = item.fulfillment || { plants: [], storageLocationsByPlant: {} };
      const plant = document.createElement("td");
      plant.append(selectCell(fulfillment.plants || [], item.productionPlant, (value) => { item.productionPlant = value; item.storageLocation = ""; renderOrderEntry(); }, "选择工厂"));
      row.append(plant);
      const locations = fulfillment.storageLocationsByPlant?.[item.productionPlant] || [];
      const storage = document.createElement("td");
      if (locations.length) storage.append(selectCell(locations, item.storageLocation, (value) => { item.storageLocation = value; }, "选择库位"));
      else storage.append(element("span", "muted", "SAP 未维护"));
      row.append(storage);
      row.append(element("td", "", `${item.currency || ""} ${Number(item.unitPrice).toFixed(2)}`.trim()));
      const tax = element("td", "tax-preview-cell");
      tax.append(element("strong", "", "SAP 定价后确认"), element("span", "", "税率 / 税额"));
      row.append(tax);
      row.append(element("td", "", `${item.currency || ""} ${(Number(item.unitPrice) * item.quantity).toFixed(2)}`.trim()));
      body.append(row);
    });
    table.append(body);
    section.append(header, table, element("p", "group-total", `本组金额 ${group.items[0]?.currency || "¥"}${group.items.reduce((sum, item) => sum + Number(item.unitPrice) * item.quantity, 0).toFixed(2)}`));
    host.append(section);
  });
  renderOrderWorkbenchTotals();
}

function appendCustomerGroup(host, title, values, formatter) {
  const section = element("section", "customer-data-group");
  section.append(element("h3", "", title));
  if (!values.length) section.append(element("p", "", "SAP 未维护"));
  values.forEach((value) => section.append(element("p", "", formatter(value))));
  host.append(section);
}

function renderCustomer360(profile) {
  const host = $("customer-360-content");
  host.replaceChildren();
  host.append(element("p", "customer-360-heading", `${profile.name} · 客户号 ${profile.customer} · BP ${profile.businessPartner}`));
  appendCustomerGroup(host, "地址", profile.addresses, (item) => [item.street, item.city, item.postalCode, item.country].filter(Boolean).join("，"));
  appendCustomerGroup(host, "联系方式", [...profile.phones, ...profile.emails], (item) => item);
  appendCustomerGroup(host, "银行收款信息", profile.banks, (item) => [item.bankName, item.bankCountry, item.iban || item.account].filter(Boolean).join(" · "));
  appendCustomerGroup(host, "销售范围", profile.salesAreas, (item) => `${item.salesOrganization} / ${item.distributionChannel} / ${item.division}`);
}

async function loadCustomer360() {
  portalNote("正在加载客户 360 档案…");
  try {
    renderCustomer360(await api("/api/customer-360"));
    portalNote("");
  } catch (error) { portalNote(error.message); }
}

function unmaintained(value) {
  return value === undefined || value === null || value === "" ? "SAP 未维护" : String(value);
}

function statusBadge(status) {
  return element("span", `status-badge status-${status?.tone || "neutral"}`, status?.label || "SAP 未维护");
}

function formatCurrencyTotals(totalsByCurrency) {
  return Array.isArray(totalsByCurrency) && totalsByCurrency.length
    ? totalsByCurrency.map(({ currency, totalAmount }) => `${currency || "SAP 未维护"} ${Number(totalAmount).toFixed(2)}`).join(" · ")
    : "SAP 未维护";
}

function formatCurrencyAverages(totalsByCurrency) {
  return Array.isArray(totalsByCurrency) && totalsByCurrency.length
    ? totalsByCurrency.map(({ currency, averageAmount }) => `${currency || "SAP 未维护"} ${Number(averageAmount).toFixed(2)}`).join(" · ")
    : "SAP 未维护";
}

function formatMoney(currency, amount) {
  return amount === undefined || amount === null || amount === "" ? "SAP 未维护" : `${currency || "SAP 未维护"} ${Number(amount).toFixed(2)}`;
}

function renderOrderRows(host, orders, emptyText, showDetail = false) {
  host.replaceChildren();
  if (!orders.length) {
    host.append(element("p", "empty-state", emptyText));
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>商城订单号</th><th>订单号</th><th>日期</th><th>订单类型</th><th>客户采购订单号</th><th>销售范围</th><th>整体状态</th><th>交货状态</th><th>开票状态</th><th>金额</th>${showDetail ? "<th>操作</th>" : ""}</tr></thead>`;
  const body = document.createElement("tbody");
  orders.forEach((order) => {
    const row = document.createElement("tr");
    row.append(
      element("td", "mall-order-id", unmaintained(order.mallOrderChildId)),
      element("td", "", unmaintained(order.salesOrder).replace(/^0+/, "") || unmaintained(order.salesOrder)),
      element("td", "", unmaintained(order.createdAt)),
      element("td", "", unmaintained(order.salesOrderType)),
      element("td", "", unmaintained(order.purchaseOrderByCustomer)),
      element("td", "", [order.salesOrganization, order.distributionChannel, order.division].every((value) => value !== undefined && value !== null && value !== "")
        ? `${order.salesOrganization} / ${order.distributionChannel} / ${order.division}`
        : "SAP 未维护"),
    );
    [order.overallStatus, order.deliveryStatus, order.billingStatus].forEach((status) => {
      const statusCell = element("td");
      statusCell.append(statusBadge(status));
      row.append(statusCell);
    });
    row.append(element("td", "", formatMoney(order.currency, order.total)));
    if (showDetail) {
      const actionCell = element("td");
      const detail = element("button", "text-button", "查看明细");
      detail.type = "button";
      detail.addEventListener("click", () => openOrderDetail(order.salesOrder));
      actionCell.append(detail);
      row.append(actionCell);
    }
    body.append(row);
  });
  table.append(body);
  host.append(table);
}

function renderOrderDashboard(dashboard) {
  const summary = $("order-dashboard-summary");
  summary.replaceChildren();
  const cards = [
    ["订单总数", String(dashboard?.orderCount ?? 0)],
    ["订单金额", formatCurrencyTotals(dashboard?.totalsByCurrency)],
    ["履约处理中", String(dashboard?.inFulfillmentCount ?? 0)],
    ["平均订单额", formatCurrencyAverages(dashboard?.totalsByCurrency)],
  ];
  cards.forEach(([label, value]) => {
    const card = element("article", "dashboard-card");
    card.append(element("span", "", label), element("strong", "", value));
    summary.append(card);
  });
}

function renderOrderAnalytics(dashboard) {
  const trend = $("order-trend");
  trend.replaceChildren();
  trend.append(element("h3", "", "订单趋势"), element("p", "", "按创建月份查看订单数量与金额走势。"));
  const months = element("div", "dashboard-months");
  (dashboard?.months || []).forEach((month) => {
    months.append(element("span", "", `${unmaintained(month.month)}：${month.orderCount ?? 0} 单 · ${formatCurrencyTotals(month.totalsByCurrency)}`));
  });
  if (!months.childElementCount) months.append(element("p", "empty-state", "SAP 未维护近 12 个月订单趋势。"));
  trend.append(months);

  const distribution = $("order-status-distribution");
  distribution.replaceChildren();
  distribution.append(element("h3", "", "状态分布"));
  const statuses = dashboard?.statuses || [];
  if (!statuses.length) distribution.append(element("p", "empty-state", "SAP 未维护订单状态分布。"));
  statuses.forEach(({ status, count }) => {
    const row = element("p", "status-distribution-row");
    row.append(statusBadge(status), element("span", "", `：${count ?? 0} 单`));
    distribution.append(row);
  });
}

function renderOrderInsights(insights) {
  const host = $("order-insights");
  host.replaceChildren();
  const salesOrganizations = element("article", "insight-card");
  salesOrganizations.append(element("h3", "", "销售组织"));
  const organizations = insights?.topSalesOrganizations || [];
  if (!organizations.length) salesOrganizations.append(element("p", "", "SAP 未维护"));
  organizations.forEach((organization) => salesOrganizations.append(element("p", "", `${unmaintained(organization.salesOrganization)}：${organization.orderCount ?? 0} 单 · ${formatCurrencyTotals(organization.totalsByCurrency)}`)));

  const largest = insights?.largestOrder;
  const largestOrder = element("article", "insight-card");
  largestOrder.append(element("h3", "", "最大订单"));
  largestOrder.append(element("p", "", largest ? `${unmaintained(largest.salesOrder).replace(/^0+/, "") || unmaintained(largest.salesOrder)} · ${formatMoney(largest.currency, largest.total)}` : "SAP 未维护"));

  const attention = element("article", "insight-card");
  attention.append(element("h3", "", "待关注订单"));
  attention.append(element("p", "", `需关注 ${insights?.attentionCount ?? 0} 单`), element("p", "", `最近订单：${unmaintained(insights?.latestOrderDate)}`));
  host.append(salesOrganizations, largestOrder, attention);
}

function renderOrderPagination(data) {
  const host = $("order-pagination");
  host.replaceChildren();
  if (!data.total) return;
  const previous = element("button", "pagination-button", "上一页");
  previous.type = "button";
  previous.disabled = data.page <= 1;
  previous.addEventListener("click", () => loadOrderCenter({ page: data.page - 1 }));
  const next = element("button", "pagination-button", "下一页");
  next.type = "button";
  next.disabled = data.page >= data.pageCount;
  next.addEventListener("click", () => loadOrderCenter({ page: data.page + 1 }));
  host.append(previous, element("span", "page-summary", `第 ${data.page} / ${data.pageCount || 1} 页，共 ${data.total} 单`), next);
}

function appendOrderSelectOptions(id, options, selected) {
  const select = $(id);
  const known = new Set([...select.options].map((option) => option.value));
  options.forEach(({ value, label }) => {
    if (value && !known.has(value)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
      known.add(value);
    }
  });
  select.value = selected || "";
}

function renderOrderFilterOptions(data) {
  appendOrderSelectOptions("order-sales-area", customerSalesAreas.map((area) => ({ value: area.key, label: salesAreaLabel(area) })), orderState.salesArea);
  appendOrderSelectOptions("order-overall-status", (data.dashboard?.statuses || []).map((item) => ({ value: item.status?.code, label: item.status?.label || "SAP 未维护" })), orderState.overallStatus);
  appendOrderSelectOptions("order-delivery-status", (data.items || []).map((item) => ({ value: item.deliveryStatus?.code, label: item.deliveryStatus?.label || "SAP 未维护" })), orderState.deliveryStatus);
}

function renderOrderDetail(data) {
  const header = data.header || {};
  const detailHeader = $("order-detail-header");
  detailHeader.replaceChildren();
  const summary = element("section", "order-detail-summary");
  summary.append(element("p", "eyebrow", "SAP 销售订单"), element("h3", "", `订单 ${unmaintained(header.salesOrder).replace(/^0+/, "") || unmaintained(header.salesOrder)}`));
  const fields = [
    ["创建日期", header.createdAt], ["销售组织", header.salesOrganization], ["分销渠道", header.distributionChannel], ["产品组", header.division],
    ["商城订单号", header.mallOrderChildId], ["客户采购订单号", header.purchaseOrderByCustomer], ["期望交货日期", header.requestedDeliveryDate], ["付款条款", header.paymentTerms], ["贸易术语", header.incotermsClassification],
    ["贸易地点", header.incotermsLocation], ["客户采购订单日期", header.customerPurchaseOrderDate], ["创建人", header.createdByUser],
  ];
  const details = element("dl", "order-detail-fields");
  fields.forEach(([label, value]) => details.append(element("dt", "", label), element("dd", "", unmaintained(value))));
  const total = element("p", "order-total", `订单金额：${formatMoney(header.currency, header.total)}`);
  const statuses = element("p", "order-statuses");
  statuses.append(statusBadge(header.overallStatus), statusBadge(header.deliveryStatus), statusBadge(header.billingStatus));
  summary.append(total, statuses);
  const headerSection = element("section", "order-detail-header-section");
  headerSection.append(element("h4", "", "订单表头"), details);
  detailHeader.append(summary, headerSection);

  const lines = $("order-detail-lines");
  lines.replaceChildren();
  lines.append(element("h4", "", "行项目"));
  const items = data.items || [];
  if (!items.length) {
    lines.append(element("p", "empty-state", "SAP 未维护订单行项目。"));
    return;
  }
  const cards = element("div", "order-line-card-list");
  items.forEach((item) => {
    const card = element("article", "order-line-card");
    const heading = element("header", "order-line-card-heading");
    const material = element("div", "order-line-card-material");
    material.append(element("span", "order-line-number", `项目 ${unmaintained(item.item)}`), element("strong", "", unmaintained(item.material)), element("p", "", unmaintained(item.description)));
    const total = element("p", "order-line-card-total", formatMoney(item.currency, item.netAmount));
    heading.append(material, total);
    const groups = element("div", "order-line-card-groups");
    const commercial = element("section", "order-line-card-group");
    commercial.append(element("h5", "", "数量与金额"), element("p", "", `${unmaintained(item.quantity)} ${item.unit || "SAP 未维护"}`), element("p", "", `净价 ${formatMoney(item.currency, item.netPrice)}`));
    const tax = element("section", "order-line-card-group");
    tax.append(element("h5", "", "税务"), element("p", "", item.taxRate === null || item.taxRate === undefined ? "SAP 定价后确认" : `税率 ${item.taxRate}%`), element("p", "", item.taxAmount === null || item.taxAmount === undefined ? "税额待确认" : `税额 ${formatMoney(item.currency, item.taxAmount)}`));
    const fulfillment = element("section", "order-line-card-group");
    fulfillment.append(element("h5", "", "履约"), element("p", "", [item.productionPlant, item.storageLocation].filter(Boolean).join(" / ") || "工厂 / 库位未维护"), statusBadge(item.deliveryStatus));
    const customerReference = element("section", "order-line-card-group");
    customerReference.append(element("h5", "", "客户料号"), element("p", "", unmaintained(item.customerMaterial)));
    groups.append(commercial, tax, fulfillment, customerReference);
    card.append(heading, groups);
    cards.append(card);
  });
  lines.append(cards);
}

function renderPrintPreview(data) {
  const host = $("print-preview-content");
  host.replaceChildren();
  const header = data?.header || {};
  const brand = element("div", "print-brand", "HAND");
  brand.append(element("span", "", "汉得"));
  const documentHeader = element("header", "print-document-header");
  documentHeader.append(element("p", "eyebrow", "销售订单 / SALES ORDER"), element("h1", "", `销售订单 ${unmaintained(header.salesOrder).replace(/^0+/, "") || unmaintained(header.salesOrder)}`), element("p", "", `订单日期：${unmaintained(header.createdAt)}`));
  const metadata = element("dl", "print-metadata");
  [["商城订单号", header.mallOrderChildId], ["客户采购订单号", header.purchaseOrderByCustomer], ["销售范围", salesAreaLabel(header)], ["付款条款", header.paymentTerms], ["贸易术语", [header.incotermsClassification, header.incotermsLocation].filter(Boolean).join(" / ")], ["期望交货", header.requestedDeliveryDate]].forEach(([label, value]) => metadata.append(element("dt", "", label), element("dd", "", unmaintained(value))));
  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>项目</th><th>物料 / 描述</th><th>数量</th><th>工厂 / 库位</th><th>税务</th><th>净额</th></tr></thead>";
  const body = document.createElement("tbody");
  (data?.items || []).forEach((item) => {
    const row = document.createElement("tr");
    const material = element("td", "print-material");
    material.append(element("strong", "", unmaintained(item.material)), element("span", "", unmaintained(item.description)));
    [unmaintained(item.item), material, `${unmaintained(item.quantity)} ${item.unit || "—"}`, [item.productionPlant, item.storageLocation].filter(Boolean).join(" / ") || "—", item.taxRate === null || item.taxRate === undefined ? "待确认" : `${item.taxRate}% / ${formatMoney(item.currency, item.taxAmount)}`, formatMoney(item.currency, item.netAmount)].forEach((value) => row.append(value instanceof HTMLElement ? value : element("td", "", value)));
    body.append(row);
  });
  table.append(body);
  const totals = element("section", "print-totals");
  totals.append(element("span", "", "订单净额"), element("strong", "", formatMoney(header.currency, header.total)));
  host.append(brand, documentHeader, metadata, table, totals, element("footer", "print-document-footer", "感谢您选择汉得客户服务门户 · HAND Enterprise Solutions"));
}

function renderOrderWorkbench(data) {
  renderOrderFilterOptions(data);
  renderOrderDashboard(data.dashboard);
  renderOrderAnalytics(data.dashboard);
  renderOrderInsights(data.insights);
  renderOrderRows($("sap-orders-list"), data.items, "未找到符合当前条件的 SAP 销售订单。", true);
  renderOrderPagination(data);
}

async function openOrderDetail(salesOrder) {
  const dialog = $("order-detail-dialog");
  $("order-detail-header").textContent = "正在加载订单详情…";
  $("order-detail-lines").replaceChildren();
  if (!dialog.open) dialog.showModal();
  try {
    salesOrder = encodeURIComponent(salesOrder);
    lastOrderDetail = await api(`/api/orders/${salesOrder}`);
    renderOrderDetail(lastOrderDetail);
  } catch (error) { $("order-detail-header").textContent = error.message; }
}

async function loadOrderCenter(next = {}) {
  Object.assign(orderState, next);
  const params = new URLSearchParams(Object.entries(orderState).filter(([key, value]) => key !== "salesArea" && value !== "").map(([key, value]) => [key, String(value)]));
  if (orderState.salesArea) {
    const [salesOrganization, distributionChannel, division] = orderState.salesArea.split("/");
    params.set("salesOrganization", salesOrganization);
    params.set("distributionChannel", distributionChannel);
    params.set("division", division);
  }
  portalNote("正在加载订单中心…");
  try {
    const data = await api(`/api/orders/history?${params}`);
    Object.assign(orderState, { page: data.page, pageSize: data.pageSize });
    renderOrderWorkbench(data);
    portalNote("");
  } catch (error) {
    $("sap-orders-list").replaceChildren(element("p", "empty-state", error.message));
    $("order-pagination").replaceChildren();
    portalNote(error.message);
  }
}

async function loadCatalog(next = {}) {
  Object.assign(catalogState, next);
  const params = new URLSearchParams({ page: String(catalogState.page), pageSize: String(catalogState.pageSize), sort: catalogState.sort });
  if (!catalogState.salesArea) throw new Error("请选择销售范围后再加载商品目录。");
  params.set("salesOrganization", catalogState.salesArea.salesOrganization);
  params.set("distributionChannel", catalogState.salesArea.distributionChannel);
  params.set("division", catalogState.salesArea.division);
  params.set("language", catalogState.language || "ZH");
  if (catalogState.query) params.set("query", catalogState.query);
  if (catalogState.group) params.set("group", catalogState.group);
  portalNote("正在加载商品目录…");
  try {
    const data = await api(`/api/catalog?${params}`);
    Object.assign(catalogState, { page: data.page, pageSize: data.pageSize });
    renderGroups(data.groups);
    renderCatalog(data.items);
    renderPagination(data);
    $("catalog-count").textContent = `共 ${data.total} 件当前有效价格物料`;
    portalNote("");
  } catch (error) { portalNote(error.message); }
}

async function openCheckout() {
  if (!cart.length) return;
  await renderOrderEntry();
  showView("orderEntry");
  $("view-order-entry").scrollIntoView({ behavior: "smooth", block: "start" });
}

function checkoutPayload() {
  return {
    items: cart.map((item) => ({ product: item.product, quantity: item.quantity, customerMaterial: item.customerMaterial, productionPlant: item.productionPlant, storageLocation: item.storageLocation, salesOrganization: item.salesArea?.salesOrganization, distributionChannel: item.salesArea?.distributionChannel, division: item.salesArea?.division })),
    requestedDeliveryDate: $("requested-delivery-date").value,
    purchaseOrderByCustomer: $("purchase-order-by-customer").value,
    note: $("portal-note").value,
    customerPaymentTerms: $("customer-payment-terms").value,
    incotermsClassification: $("incoterms-classification").value,
    incotermsLocation: $("incoterms-location").value,
  };
}

function renderPreview(preview) {
  const host = $("order-confirmation-summary");
  host.replaceChildren();
  host.append(element("p", "mall-order-id", `商城订单号：${unmaintained(preview.mallOrderId)}`));
  (preview.groups || []).forEach((group) => {
    const section = element("section", "confirmation-group");
    section.append(element("h3", "", salesAreaLabel(group.salesArea)));
    section.append(element("p", "mall-order-id", `子单号：${unmaintained(group.childOrderId)}`));
    group.items.forEach((item) => section.append(element("p", "", `${item.productId} × ${item.quantity}　${item.currency || ""} ${Number(item.lineTotal).toFixed(2)}`)));
    section.append(element("p", "group-total", (group.totalsByCurrency || []).map((total) => `${total.currency} ${Number(total.total).toFixed(2)}`).join(" · ")));
    host.append(section);
  });
  if (preview.checkout.requested_delivery_date) host.append(element("p", "", `期望交货日期：${preview.checkout.requested_delivery_date}`));
  if (preview.checkout.purchase_order_by_customer) host.append(element("p", "", `客户采购订单号：${preview.checkout.purchase_order_by_customer}`));
  if (preview.checkout.portal_note) host.append(element("p", "", "订单备注已记录。"));
}

function renderOrderResult(data) {
  const host = $("order-result-summary");
  host.replaceChildren();
  host.append(element("p", "mall-order-id", `商城订单号：${unmaintained(data.mallOrderId)}`));
  const list = element("div", "order-result-list");
  (data.groups || []).forEach((group) => {
    const card = element("section", "order-result-card");
    card.append(element("strong", "", salesAreaLabel(group.salesArea)), element("p", "mall-order-id", `子单号：${unmaintained(group.childOrderId)}`));
    card.append(group.success ? element("p", "", `SAP 销售订单：${unmaintained(group.salesOrder).replace(/^0+/, "") || unmaintained(group.salesOrder)}`) : element("p", "", unmaintained(group.error) || "创建失败。"));
    list.append(card);
  });
  host.append(list);
}

$("show-register").addEventListener("click", () => showAuth("register-request-panel"));
document.querySelectorAll(".back-to-login").forEach((button) => button.addEventListener("click", () => showAuth("login-panel")));

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("login-button");
  setBusy(button, true, "登录中…");
  try {
    await api("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer: $("customer").value, password: $("password").value }) });
    const profile = await api("/api/me");
    $("auth").hidden = true;
    $("portal").hidden = false;
    renderCustomer(profile);
    showView("catalog");
    await loadSalesAreas();
    await loadCatalog();
  } catch (error) { authNote(error.message); } finally { setBusy(button, false, "登录中…"); }
});

$("register-request-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("request-code-button");
  const customer = $("register-customer").value;
  setBusy(button, true, "发送中…");
  try {
    const data = await api("/api/register/request-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer }) });
    $("verify-customer").value = customer;
    showAuth("register-verify-panel");
    authNote(data.message);
  } catch (error) { authNote(error.message); } finally { setBusy(button, false, "发送中…"); }
});

$("register-verify-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("verify-button");
  setBusy(button, true, "注册中…");
  try {
    const data = await api("/api/register/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer: $("verify-customer").value, code: $("verification-code").value, password: $("register-password").value }) });
    $("customer").value = $("verify-customer").value;
    $("password").value = "";
    showAuth("login-panel");
    authNote(data.message);
  } catch (error) { authNote(error.message); } finally { setBusy(button, false, "注册中…"); }
});

$("catalog-search-form").addEventListener("submit", (event) => { event.preventDefault(); loadCatalog({ query: $("catalog-search").value.trim(), page: 1 }); });
$("catalog-sort").addEventListener("change", () => loadCatalog({ sort: $("catalog-sort").value, page: 1 }));
$("catalog-language").addEventListener("change", () => loadCatalog({ language: $("catalog-language").value, page: 1 }));
$("sales-area-select").addEventListener("change", () => {
  const option = $("sales-area-select").selectedOptions[0];
  catalogState.salesArea = option ? { salesOrganization: option.dataset.salesOrganization, distributionChannel: option.dataset.distributionChannel, division: option.dataset.division, key: option.value } : null;
  loadCatalog({ page: 1, group: "" });
});
$("order-filter-form").addEventListener("submit", (event) => {
  event.preventDefault();
  loadOrderCenter({
    page: 1,
    query: $("order-query").value.trim(),
    from: $("order-from").value,
    to: $("order-to").value,
    salesArea: $("order-sales-area").value,
    overallStatus: $("order-overall-status").value,
    deliveryStatus: $("order-delivery-status").value,
    sort: $("order-sort").value,
  });
});
$("close-order-detail").addEventListener("click", () => $("order-detail-dialog").close());
$("print-order-detail").addEventListener("click", () => {
  if (!lastOrderDetail) return;
  renderPrintPreview(lastOrderDetail);
  if (!$("print-preview").open) $("print-preview").showModal();
});
$("close-print-preview").addEventListener("click", () => $("print-preview").close());
$("close-order-result").addEventListener("click", () => $("order-result-dialog").close());
$("open-orders-from-result").addEventListener("click", async () => { $("order-result-dialog").close(); showView("orders"); await loadOrderCenter(); });
$("print-preview-button").addEventListener("click", () => window.print());
$("checkout-button").addEventListener("click", openCheckout);
$("back-to-cart-button").addEventListener("click", () => { showView("catalog"); $("cart-panel").scrollIntoView({ behavior: "smooth", block: "start" }); });

$("order-header-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    lastPreview = await api("/api/orders/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(checkoutPayload()) });
    renderPreview(lastPreview);
    $("order-confirmation-dialog").showModal();
  } catch (error) { portalNote(error.message); }
});

$("cancel-order-button").addEventListener("click", () => $("order-confirmation-dialog").close());
$("confirm-order-button").addEventListener("click", async () => {
  if (!lastPreview) return;
  const button = $("confirm-order-button");
  setBusy(button, true, "同步中…");
  try {
    const data = await api("/api/orders/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...checkoutPayload(), mallOrderId: lastPreview.mallOrderId, confirm: true }) });
    $("order-confirmation-dialog").close();
    const successful = (data.groups || []).filter((group) => group.success);
    const failed = (data.groups || []).filter((group) => !group.success);
    renderOrderResult(data);
    $("order-result-dialog").showModal();
    portalNote(`商城订单 ${data.mallOrderId}：SAP 已创建 ${successful.length} 张订单${failed.length ? `；${failed.length} 个销售范围未创建。` : "。"}`);
    lastPreview = null;
    showView("catalog");
    renderCart();
  } catch (error) { portalNote(error.message); } finally { setBusy(button, false, "同步中…"); }
});

$("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  cart.length = 0;
  lastPreview = null;
  renderCart();
  showView("catalog");
  $("portal").hidden = true;
  $("auth").hidden = false;
  showAuth("login-panel");
});

$("nav-catalog").addEventListener("click", (event) => { event.preventDefault(); showView("catalog"); });
$("nav-customer").addEventListener("click", async (event) => {
  event.preventDefault();
  showView("customer360");
  await loadCustomer360();
});
$("nav-orders").addEventListener("click", async (event) => {
  event.preventDefault();
  showView("orders");
  await loadOrderCenter();
});

renderCart();
