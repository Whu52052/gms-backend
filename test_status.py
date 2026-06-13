"""Test machine status auto-update specifically"""
import requests

BASE = "http://localhost:8765"
headers = {"Content-Type": "application/json"}

# Login superadmin
r = requests.post(f"{BASE}/api/auth/login", json={"username": "Yunwei", "password": "yunwei1025"}, headers=headers)
token = r.json()["token"]
headers["Authorization"] = f"Bearer {token}"

# Check machine we-001 structure
print("=== Machine we-001 current state ===")
r = requests.get(f"{BASE}/api/machines", headers=headers)
for m in r.json():
    if m.get("machineNumber") == "we-001" or m.get("id") == "we-001":
        print(f"  status: {m.get('status')}")
        print(f"  full: { {k:v for k,v in m.items() if k not in ['data']} }")
        break

# Submit new ticket for we-001
print("\n=== Submit ticket ===")
r = requests.post(f"{BASE}/api/tech-support", json={
    "equipmentType": "glove",
    "equipmentTypeName": "纯手套设备",
    "machineId": "we-001",
    "machineNumber": "we-001",
    "faultType": "Test status sync",
    "faultDescription": "Testing waiting_repair status"
}, headers=headers)
print(f"Status: {r.status_code}")
if r.status_code == 200:
    tid = r.json()["item"]["id"]
    print(f"Ticket: {tid}")

    # Check machine status after submit
    r = requests.get(f"{BASE}/api/machines", headers=headers)
    for m in r.json():
        if m.get("machineNumber") == "we-001":
            print(f"After submit - machine status: {m.get('status')}")
            break

    # Respond
    r = requests.post(f"{BASE}/api/tech-support/{tid}/respond", headers=headers)
    print(f"Respond: {r.status_code}")
    r = requests.get(f"{BASE}/api/machines", headers=headers)
    for m in r.json():
        if m.get("machineNumber") == "we-001":
            print(f"After respond - machine status: {m.get('status')}")
            break

    # Complete
    r = requests.post(f"{BASE}/api/tech-support/{tid}/complete", json={"result": "Fixed"}, headers=headers)
    print(f"Complete: {r.status_code}")
    r = requests.get(f"{BASE}/api/machines", headers=headers)
    for m in r.json():
        if m.get("machineNumber") == "we-001":
            print(f"After complete - machine status: {m.get('status')}")
            break

print("\nDone!")
