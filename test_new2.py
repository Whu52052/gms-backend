"""Test new features with superadmin account"""
import requests, json

BASE = "http://localhost:8765"
headers = {"Content-Type": "application/json"}

def api(method, path, body=None):
    url = BASE + path
    if method == "GET":
        r = requests.get(url, headers=headers, timeout=10)
    else:
        r = requests.request(method, url, json=body, headers=headers, timeout=10)
    try:
        return r.status_code, r.json()
    except:
        return r.status_code, r.text[:200]

print("=" * 50)
print("  TESTING WITH SUPERADMIN")
print("=" * 50)

# Login as yunwei (superadmin)
code, data = api("POST", "/api/auth/login", {"username": "Yunwei", "password": "yunwei1025"})
token = data.get("token", "")
print(f"Login: {code}, user={data.get('user',{}).get('role')}")
headers["Authorization"] = f"Bearer {token}"

# Get machines - check statuses
print("\n=== Machine Status Distribution ===")
code, machines = api("GET", "/api/machines")
if isinstance(machines, list):
    from collections import Counter
    statuses = Counter(m.get("status","?") for m in machines)
    for s, c in statuses.most_common():
        print(f"  {s}: {c}")

# Get tech support - check new duration fields
print("\n=== Tech Support List ===")
code, ts_list = api("GET", "/api/tech-support")
if isinstance(ts_list, list):
    print(f"Count: {len(ts_list)}")
    # Show one with new fields
    for ts in ts_list:
        if ts.get("totalSeconds") is not None:
            print(f"  Found new format! {ts.get('id')}: wait={ts.get('waitSeconds')}s repair={ts.get('repairSeconds')}s total={ts.get('totalSeconds')}s")
            break
    else:
        print("  All old format (no totalSeconds) - expected for old data")

# Submit new tech support
print("\n=== Submit New Ticket ===")
code, new_ts = api("POST", "/api/tech-support", {
    "equipmentType": "glove",
    "equipmentTypeName": "纯手套设备",
    "machineId": "test-new-feature",
    "machineNumber": "we-001",
    "faultType": "传感器故障",
    "faultDescription": "测试新状态同步功能"
})
print(f"Status: {code}")
if code == 200:
    print(f"  ID: {new_ts.get('item',{}).get('id')}")
    tid = new_ts.get('item',{}).get('id')
    # Check machine status
    code, machines = api("GET", "/api/machines")
    if isinstance(machines, list):
        for m in machines:
            if m.get("machineNumber") == "we-001":
                print(f"  Machine we-001 status: {m.get('status')}")
                break

    # Respond to ticket
    print("\n=== Respond to Ticket ===")
    code, resp = api("POST", f"/api/tech-support/{tid}/respond")
    print(f"  Respond: {code}")
    code, detail = api("GET", f"/api/tech-support/{tid}")
    if isinstance(detail, dict):
        print(f"  waitSeconds: {detail.get('waitSeconds')}")

    # Complete ticket
    print("\n=== Complete Ticket ===")
    code, comp = api("POST", f"/api/tech-support/{tid}/complete", {"result": "Fixed!"})
    print(f"  Complete: {code}")
    code, detail = api("GET", f"/api/tech-support/{tid}")
    if isinstance(detail, dict):
        print(f"  totalSeconds: {detail.get('totalSeconds')}")
    # Check machine status again
    code, machines = api("GET", "/api/machines")
    if isinstance(machines, list):
        for m in machines:
            if m.get("machineNumber") == "we-001":
                print(f"  Machine we-001 final status: {m.get('status')}")
                break
else:
    print(f"  Error: {new_ts}")

# Test XLSX export
print("\n=== XLSX Export ===")
code, result = api("GET", "/api/export/tech-support-xlsx")
print(f"  Export status: {code}")

print("\n" + "=" * 50)
print("  TESTS COMPLETE!")
print("=" * 50)
