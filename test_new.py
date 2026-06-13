"""Test new features: tech support + machine status integration"""
import requests, json

BASE = "http://localhost:8765"
headers = {"Content-Type": "application/json"}

def api(method, path, body=None):
    url = BASE + path
    if method == "GET":
        r = requests.get(url, headers=headers, timeout=10)
    else:
        r = requests.request(method, url, json=body, headers=headers, timeout=10)
    return r.status_code, r.json() if r.text else {}

print("=" * 50)
print("  TESTING NEW FEATURES")
print("=" * 50)

# 1. Login
print("\n1. Login...")
code, data = api("POST", "/api/auth/login", {"username": "admin", "password": "admin123"})
token = data.get("token", "")
print(f"   Status: {code}, Token: {token[:20]}..." if token else f"   Failed: {data}")
headers["Authorization"] = f"Bearer {token}"

# 2. Check machines
print("\n2. Get machines...")
code, machines = api("GET", "/api/machines")
print(f"   Machines count: {len(machines) if isinstance(machines, list) else 'error'}")
if isinstance(machines, list) and len(machines) > 0:
    m = machines[0]
    print(f"   Sample: {json.dumps(m, ensure_ascii=False)[:200]}")

# 3. Check existing tech support
print("\n3. Get tech support list...")
code, ts_list = api("GET", "/api/tech-support")
print(f"   Count: {len(ts_list) if isinstance(ts_list, list) else 'error'}")
if isinstance(ts_list, list) and len(ts_list) > 0:
    ts = ts_list[0]
    # Check if new fields exist
    has_seconds = "totalSeconds" in ts or "waitSeconds" in ts
    print(f"   New seconds fields: {has_seconds}")
    if "totalMinutes" in ts:
        print(f"   Old minutes still present: {ts.get('totalMinutes')}")

# 4. Create a new tech support ticket
print("\n4. Create tech support ticket...")
code, new_ts = api("POST", "/api/tech-support", {
    "machineNumber": "TEST01",
    "equipmentType": "glove",
    "faultType": "Test fault",
    "description": "Testing new status integration"
})
print(f"   Status: {code}")
print(f"   Machine status should be: waiting_repair")

# 5. Check machine status
print("\n5. Check machine TEST01 status...")
code, machines = api("GET", "/api/machines")
if isinstance(machines, list):
    test_machines = [m for m in machines if m.get("machineNumber") == "TEST01"]
    if test_machines:
        print(f"   TEST01 status: {test_machines[0].get('status')}")
    else:
        print("   No machine TEST01 found (need to add first)")

# 6. Test duration formatter via API
print("\n6. Check duration formatting...")
if isinstance(ts_list, list) and len(ts_list) > 0:
    ts = ts_list[0]
    ts_id = ts.get("id")
    if ts_id:
        code, detail = api("GET", f"/api/tech-support/{ts_id}")
        if isinstance(detail, dict):
            print(f"   waitSeconds: {detail.get('waitSeconds')}")
            print(f"   repairSeconds: {detail.get('repairSeconds')}")
            print(f"   totalSeconds: {detail.get('totalSeconds')}")

# 7. Test XLSX export
print("\n7. Test XLSX export...")
code, xlsx_data = api("GET", "/api/tech-support/export/xlsx")
print(f"   Export status: {code}")

print("\n" + "=" * 50)
print("  TESTS COMPLETE!")
print("=" * 50)
