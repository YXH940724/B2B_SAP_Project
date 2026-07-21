const $ = (id) => document.getElementById(id);
const cart = [];
const catalogState = { page: 1, pageSize: 20, query: "", group: "", sort: "material", salesArea: null };
let lastPreview = null;

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
  const existing = cart.find((line) => line.product === item.product);
  if (existing) existing.quantity += 1;
  else cart.push({ ...item, quantity: 1 });
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
    body.append(element("h3", "product-description", item.description));
    body.append(element("p", "product-unit", `销售单位：${item.baseUnit || item.priceUnit || "—"}`));
    body.append(element("p", "product-price", `${item.currency || ""} ${Number(item.unitPrice).toFixed(2)} / ${item.priceUnit || item.baseUnit || "—"}`.trim()));
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
    row.append(element("strong", "", item.product.replace(/^0+/, "") || item.product), element("p", "cart-description", item.description), element("p", "cart-price", `${item.currency || ""} ${Number(item.unitPrice).toFixed(2)} / ${item.priceUnit || item.baseUnit || "—"}`.trim()));
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
  $("cart-total").textContent = `合计 ${cart[0]?.currency || "¥"}${cartTotal().toFixed(2)}`;
  $("checkout-button").disabled = !cart.length;
}

function showView(name) {
  const views = { catalog: "view-catalog", orderEntry: "view-order-entry", customer360: "view-customer-360" };
  Object.entries(views).forEach(([viewName, id]) => { $(id).hidden = viewName !== name; });
}

function renderOrderEntry() {
  const host = $("order-line-items");
  host.replaceChildren();
  host.append(element("h3", "", "行项目"));
  if (!cart.length) {
    host.append(element("p", "empty-state", "购物车为空，请先选择商品。"));
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>物料</th><th>描述</th><th>数量</th><th>净价</th><th>小计</th></tr></thead>";
  const body = document.createElement("tbody");
  cart.forEach((item) => {
    const row = document.createElement("tr");
    const cells = [item.product.replace(/^0+/, "") || item.product, item.description, String(item.quantity), `${item.currency || ""} ${Number(item.unitPrice).toFixed(2)}`, `${item.currency || ""} ${(Number(item.unitPrice) * item.quantity).toFixed(2)}`];
    cells.forEach((value) => row.append(element("td", "", value.trim())));
    body.append(row);
  });
  table.append(body);
  host.append(table, element("p", "order-total", `订单合计 ${cart[0]?.currency || "¥"}${cartTotal().toFixed(2)}`));
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

async function loadCatalog(next = {}) {
  Object.assign(catalogState, next);
  const params = new URLSearchParams({ page: String(catalogState.page), pageSize: String(catalogState.pageSize), sort: catalogState.sort });
  if (!catalogState.salesArea) throw new Error("请选择销售范围后再加载商品目录。");
  params.set("salesOrganization", catalogState.salesArea.salesOrganization);
  params.set("distributionChannel", catalogState.salesArea.distributionChannel);
  params.set("division", catalogState.salesArea.division);
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
  renderOrderEntry();
  showView("orderEntry");
  $("view-order-entry").scrollIntoView({ behavior: "smooth", block: "start" });
}

function checkoutPayload() {
  return {
    items: cart.map((item) => ({ product: item.product, quantity: item.quantity })),
    requestedDeliveryDate: $("requested-delivery-date").value,
    purchaseOrderByCustomer: $("purchase-order-by-customer").value,
    note: $("portal-note").value,
    salesOrganization: catalogState.salesArea?.salesOrganization,
    distributionChannel: catalogState.salesArea?.distributionChannel,
    division: catalogState.salesArea?.division,
  };
}

function renderPreview(preview) {
  const host = $("order-confirmation-summary");
  host.replaceChildren();
  preview.items.forEach((item) => host.append(element("p", "", `${item.productId} × ${item.quantity}　${item.currency || ""} ${Number(item.lineTotal).toFixed(2)}`)));
  host.append(element("p", "order-total", `订单合计 ${preview.items[0]?.currency || "¥"}${Number(preview.total).toFixed(2)}`));
  if (preview.checkout.requested_delivery_date) host.append(element("p", "", `期望交货日期：${preview.checkout.requested_delivery_date}`));
  if (preview.checkout.purchase_order_by_customer) host.append(element("p", "", `客户采购订单号：${preview.checkout.purchase_order_by_customer}`));
  if (preview.checkout.portal_note) host.append(element("p", "", "订单备注已记录。"));
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
$("sales-area-select").addEventListener("change", () => {
  const option = $("sales-area-select").selectedOptions[0];
  catalogState.salesArea = option ? { salesOrganization: option.dataset.salesOrganization, distributionChannel: option.dataset.distributionChannel, division: option.dataset.division, key: option.value } : null;
  loadCatalog({ page: 1, group: "" });
});
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
    const data = await api("/api/orders/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...checkoutPayload(), confirm: true }) });
    $("order-confirmation-dialog").close();
    portalNote(`SAP 订单创建成功：${data.salesOrder?.SalesOrder || "请查看 SAP 返回信息"}`);
    cart.length = 0;
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
$("nav-orders").addEventListener("click", (event) => {
  event.preventDefault();
  portalNote("订单中心与订单分析将在下一阶段启用。");
});

renderCart();
