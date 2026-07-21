#!/usr/bin/env python3
"""Browser coverage for the mocked, read-only order workbench."""

import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Route, expect, sync_playwright


BASE_URL = os.environ.get("ORDER_WORKBENCH_URL", "http://127.0.0.1:4180")
SCREENSHOT_PATH = Path("/tmp/order-workbench-ui.png")


def status(code: str, label: str, tone: str = "neutral") -> dict:
    return {"code": code, "label": label, "tone": tone}


ORDER_1372 = {
    "salesOrder": "0000001372",
    "createdAt": "2026-07-01",
    "salesOrganization": "1310",
    "overallStatus": status("A", "已完成", "success"),
    "deliveryStatus": status("A", "已完成", "success"),
    "currency": "CNY",
    "total": 1200,
}
ORDER_1373 = {
    "salesOrder": "0000001373",
    "createdAt": "2026-07-02",
    "salesOrganization": "1310",
    "overallStatus": status("B", "处理中", "warning"),
    "deliveryStatus": status("B", "处理中", "warning"),
    "currency": "CNY",
    "total": 800,
}


def history_payload(items: list[dict], page: int, total: int, page_count: int) -> dict:
    return {
        "items": items,
        "page": page,
        "pageSize": 20,
        "total": total,
        "pageCount": page_count,
        "dashboard": {
            "orderCount": total,
            "totalsByCurrency": [{"currency": "CNY", "orderCount": total, "totalAmount": 2000, "averageAmount": 1000}],
            "inFulfillmentCount": 1,
            "months": [{"month": "2026-07", "orderCount": total, "totalsByCurrency": [{"currency": "CNY", "orderCount": total, "totalAmount": 2000, "averageAmount": 1000}]}],
            "statuses": [status("A", "已完成", "success"), status("B", "处理中", "warning")],
        },
        "insights": {
            "topSalesOrganizations": [{"salesOrganization": "1310", "orderCount": total, "totalsByCurrency": [{"currency": "CNY", "orderCount": total, "totalAmount": 2000, "averageAmount": 1000}]}],
            "largestOrder": ORDER_1372,
            "latestOrderDate": "2026-07-02",
            "attentionCount": 1,
        },
    }


DETAIL_1372 = {
    "header": {
        **ORDER_1372,
        "distributionChannel": "10",
        "division": "00",
        "purchaseOrderByCustomer": "MOCK-PO-1372",
        "requestedDeliveryDate": "2026-07-31",
        "customerPurchaseOrderDate": "2026-07-01",
        "createdByUser": "mock-user",
        "billingStatus": status("A", "已完成", "success"),
    },
    "items": [
        {"item": "000010", "material": "MOCK-MAT-01", "description": "模拟物料一", "quantity": 2, "unit": "EA", "netPrice": 300, "netAmount": 600, "currency": "CNY", "deliveryStatus": status("A", "已完成", "success")},
        {"item": "000020", "material": "MOCK-MAT-02", "description": "模拟物料二", "quantity": 1, "unit": "EA", "netPrice": 600, "netAmount": 600, "currency": "CNY", "deliveryStatus": status("B", "处理中", "warning")},
    ],
}


def fulfill_json(route: Route, payload: object, status_code: int = 200) -> None:
    route.fulfill(status=status_code, content_type="application/json", body=json.dumps(payload, ensure_ascii=False))


def run() -> None:
    observed_history_urls: list[str] = []

    def route_api(route: Route) -> None:
        parsed = urlparse(route.request.url)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/api/login":
            fulfill_json(route, {"ok": True})
        elif path == "/api/me":
            fulfill_json(route, {"customer": "MOCK-100001", "name": "模拟客户", "accountGroup": "MOCK", "businessPartner": "MOCK-BP"})
        elif path == "/api/sales-areas":
            fulfill_json(route, [{"key": "1310/10/00", "salesOrganization": "1310", "distributionChannel": "10", "division": "00"}])
        elif path == "/api/catalog":
            fulfill_json(route, {"items": [], "groups": [], "page": 1, "pageSize": 20, "total": 0, "pageCount": 0})
        elif path == "/api/orders/history":
            observed_history_urls.append(route.request.url)
            if query.get("query") == ["没有匹配"]:
                fulfill_json(route, history_payload([], 1, 0, 0))
            elif query.get("page") == ["2"]:
                fulfill_json(route, history_payload([ORDER_1373], 2, 3, 2))
            else:
                fulfill_json(route, history_payload([ORDER_1372, ORDER_1373], 1, 3, 2))
        elif path == "/api/orders/0000001372":
            fulfill_json(route, DETAIL_1372)
        elif path == "/api/orders/0000001373":
            fulfill_json(route, {"error": "订单详情暂不可读取。"}, 500)
        else:
            route.continue_()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.route("**/api/**", route_api)
        try:
            page.goto(BASE_URL, wait_until="networkidle")
            page.locator("#customer").fill("MOCK-100001")
            page.locator("#password").fill("mock-password")
            page.get_by_role("button", name="登录").click()
            page.get_by_role("link", name="订单中心").wait_for(state="visible")

            page.get_by_role("link", name="订单中心").click()
            page.locator("#order-list tbody tr").first.wait_for(state="visible")
            assert page.locator("#order-list tbody tr").count() == 2
            assert "/api/orders/history?page=1" in observed_history_urls[0]

            page.get_by_role("button", name="下一页").click()
            expect(page.locator("#order-list tbody tr")).to_have_count(1)
            assert any("/api/orders/history?page=2" in url for url in observed_history_urls)

            page.get_by_role("button", name="上一页").click()
            expect(page.locator("#order-list tbody tr")).to_have_count(2)
            page.get_by_role("button", name="查看明细").first.click()
            page.locator("#order-detail-dialog").wait_for(state="visible")
            expect(page.locator("#order-detail-lines tbody tr")).to_have_count(2)
            assert "模拟物料一" in page.locator("#order-detail-dialog").inner_text()
            page.screenshot(path=str(SCREENSHOT_PATH), full_page=True)

            page.get_by_role("button", name="关闭订单明细").click()
            page.get_by_role("button", name="查看明细").nth(1).click()
            page.locator("#order-detail-dialog").wait_for(state="visible")
            expect(page.locator("#order-detail-header")).to_contain_text("订单详情暂不可读取。")
            assert page.locator("#order-list tbody tr").count() == 2
            page.get_by_role("button", name="关闭订单明细").click()

            page.locator("#order-query").fill("没有匹配")
            page.locator("#order-filter-form").get_by_role("button", name="查询").click()
            page.get_by_text("未找到符合当前条件的 SAP 销售订单。").wait_for(state="visible")
            assert any("/api/orders/history?page=1" in url and "query=%E6%B2%A1%E6%9C%89%E5%8C%B9%E9%85%8D" in url for url in observed_history_urls)
        finally:
            browser.close()


if __name__ == "__main__":
    run()
