"""Comprehensive GMS system test"""
import requests, json, sys
sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://123.207.74.164:8765"
headers = {"Content-Type": "application/json"}
results = []

def test(name, method, path, body=None, expected_code=200, token=None):
    h = headers.copy()
    if token:
        h["Authorization"] = f"Bearer {token}"
    try:
        url = BASE + path
        if method == "GET":
            r = requests.get(url, headers=h, timeout=15)
        elif method == "POST":
            r = requests.post(url, json=body, headers=h, timeout=15)
        elif method == "DELETE":
            r = requests.delete(url, headers=h, timeout=15)
        else:
            r = requests.request(method, url, json=body, headers=h, timeout=15)
        ok = r.status_code == expected_code
        status = "PASS" if ok else f"FAIL({r.status_code})"
        try:
            data = r.json()
        except:
            data = r.text[:100]
        detail = ""
        if not ok:
            detail = f" -> {json.dumps(data, ensure_ascii=False)[:150]}"
        print(f"  [{status}] {name}{detail}")
        results.append((name, ok, r.status_code, data))
        return r.status_code, data
    except Exception as e:
        print(f"  [ERR] {name}: {e}")
        results.append((name, False, 0, str(e)))
        return 0, str(e)

print("=" * 60)
print("  GMS FULL SYSTEM TEST")
print("=" * 60)

# ===== 1. HEALTH CHECK =====
print("\n--- 1. Health Check ---")
test("Server health", "GET", "/api/health")
test("Main page loads", "GET", "/")
test("Operations page", "GET", "/operations.html")
test("Static CSS", "GET", "/css/style.css")
test("Static JS", "GET", "/js/app.js")

# ===== 2. AUTHENTICATION =====
print("\n--- 2. Authentication ---")

# Test all known accounts
accounts = [
    ("Yunwei", "yunwei1025", "superadmin", "maintenance"),
    ("yunying", "yunying1025", "superadmin", "operations"),
    ("admin", "admin123", "admin", "maintenance"),
]
tokens = {}
for username, password, role, system in accounts:
    code, data = test(f"Login {username} ({system})", "POST", "/api/auth/login",
                      {"username": username, "password": password})
    if code == 200 and "token" in data:
        tokens[f"{username}"] = (data["token"], data.get("user", {}))
        print(f"         Token: {data['token'][:20]}... User: {data.get('user', {}).get('username')}")

# Test invalid login
test("Login invalid user", "POST", "/api/auth/login", {"username": "nobody", "password": "wrong"}, 401)
test("Login empty fields", "POST", "/api/auth/login", {"username": "", "password": ""}, 400)

# ===== 3. API ACCESS CONTROL =====
print("\n--- 3. API Access ---")
yunwei_token = tokens.get("Yunwei", [None])[0]
yunying_token = tokens.get("yunying", [None])[0]
admin_token = tokens.get("admin", [None])[0]

# Test with no token
test("No token - inventory", "GET", "/api/inventory", expected_code=401)

# Test with valid token
if yunwei_token:
    test("Yunwei - inventory", "GET", "/api/inventory", token=yunwei_token)
    test("Yunwei - machines", "GET", "/api/machines", token=yunwei_token)
    test("Yunwei - settings", "GET", "/api/settings", token=yunwei_token)

if yunying_token:
    test("yunying - inventory", "GET", "/api/inventory", token=yunying_token)
    test("yunying - machines", "GET", "/api/machines", token=yunying_token)

if admin_token:
    test("admin - inventory", "GET", "/api/inventory", token=admin_token)
    test("admin - machines", "GET", "/api/machines", token=admin_token)

# ===== 4. INVENTORY OPERATIONS =====
print("\n--- 4. Inventory Operations ---")
if yunwei_token:
    # Get all inventory
    code, data = test("Get all inventory", "GET", "/api/inventory", token=yunwei_token)
    if isinstance(data, list) and len(data) > 0:
        test_type = data[0].get("inv_type", data[0].get("type", "")) if isinstance(data[0], dict) else data[0]
        if test_type:
            test(f"Get inventory: {test_type}", "GET", f"/api/inventory/{test_type}", token=yunwei_token)
            test(f"Adjust {test_type} +10", "POST", f"/api/inventory/{test_type}",
                 {"delta": 10, "updatedBy": "Yunwei", "snCode": "TEST-SN-001"}, token=yunwei_token)

# ===== 5. MACHINES =====
print("\n--- 5. Machines ---")
if yunwei_token:
    code, machines = test("List machines", "GET", "/api/machines", token=yunwei_token)
    if isinstance(machines, list) and len(machines) > 0:
        m = machines[0]
        mid = m.get("id") or m.get("machineNumber")
        if mid:
            test(f"Get machine: {mid}", "GET", f"/api/machines/{mid}", token=yunwei_token)
            test(f"Delete machine: {mid}", "DELETE", f"/api/machines/{mid}", token=yunwei_token)
            # Re-add
            test("Add machine back", "POST", "/api/machines", m, token=yunwei_token)

# ===== 6. TECH SUPPORT (KEY FEATURE) =====
print("\n--- 6. Tech Support ---")
if tokens:
    # Use yunying (operations system) for tech support
    ops_token = yunying_token or yunwei_token
    ops_name = "yunying" if yunying_token else "Yunwei"

    # Create ticket with operations user
    code, ts_data = test("Submit tech support", "POST", "/api/tech-support", {
        "equipmentType": "dexterous",
        "equipmentTypeName": "灵巧手设备",
        "machineId": "test-ts-001",
        "machineNumber": "we-001",
        "faultType": "传感器异常",
        "faultDescription": "全功能测试报修"
    }, token=ops_token)

    if code == 200 and "item" in ts_data:
        tid = ts_data["item"]["id"]
        print(f"         Ticket ID: {tid}")

        # Check machine status
        code, machines = test("Check machine status", "GET", "/api/machines", token=ops_token)
        if isinstance(machines, list):
            for m in machines:
                if m.get("machineNumber") == "we-001":
                    status = m.get("status", "unknown")
                    ok = status == "waiting_repair"
                    print(f"  [{'PASS' if ok else 'FAIL'}] Machine status: {status} (expected: waiting_repair)")
                    break

        # Respond to ticket (maintenance user)
        if yunwei_token:
            test("Respond to ticket", "POST", f"/api/tech-support/{tid}/respond", token=yunwei_token)
            code, machines = test("Check machine - repairing", "GET", "/api/machines", token=yunwei_token)
            if isinstance(machines, list):
                for m in machines:
                    if m.get("machineNumber") == "we-001":
                        print(f"         Machine status after respond: {m.get('status')}")
                        break

            # Complete ticket
            test("Complete ticket", "POST", f"/api/tech-support/{tid}/complete",
                 {"result": "测试完成，功能正常"}, token=yunwei_token)
            code, machines = test("Check machine - online", "GET", "/api/machines", token=yunwei_token)
            if isinstance(machines, list):
                for m in machines:
                    if m.get("machineNumber") == "we-001":
                        print(f"         Machine status after complete: {m.get('status')}")
                        break

        # Get detail and check duration fields
        code, detail = test("Get ticket detail", "GET", f"/api/tech-support/{tid}", token=ops_token)
        if isinstance(detail, dict):
            print(f"         waitSeconds: {detail.get('waitSeconds')}")
            print(f"         repairSeconds: {detail.get('repairSeconds')}")
            print(f"         totalSeconds: {detail.get('totalSeconds')}")

# ===== 7. OPERATIONS PAGES (yunying login test) =====
print("\n--- 7. Operations System Login ---")
# Test specifically what user reported: yunying operations page access
if yunying_token:
    test("yunying - settings", "GET", "/api/settings", token=yunying_token)
    test("yunying - tech-support list", "GET", "/api/tech-support", token=yunying_token)
    test("yunying - users list", "GET", "/api/users", token=yunying_token)
    # yunying is superadmin, should be able to do everything
if admin_token:
    test("admin - settings", "GET", "/api/settings", token=admin_token)
    test("admin - tech-support list", "GET", "/api/tech-support", token=admin_token)

# ===== 8. EXPORT =====
print("\n--- 8. Export ---")
if yunwei_token:
    test("Export tech support XLSX", "GET", "/api/export/tech-support-xlsx", token=yunwei_token)
    test("Export inventory XLSX", "GET", "/api/export/xlsx", token=yunwei_token)

# ===== 9. SUMMARY =====
print("\n" + "=" * 60)
passed = sum(1 for _, ok, _, _ in results if ok)
total = len(results)
print(f"  RESULTS: {passed}/{total} passed")
failed = [(name, code, data) for name, ok, code, data in results if not ok]
if failed:
    print(f"\n  FAILURES ({len(failed)}):")
    for name, code, data in failed:
        print(f"    - {name} (code={code}): {str(data)[:100]}")
else:
    print("  ALL TESTS PASSED!")
print("=" * 60)
