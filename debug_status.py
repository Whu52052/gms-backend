"""Debug machine status update issue"""
import requests, json

BASE = "http://localhost:8765"
headers = {"Content-Type": "application/json"}

# Login
r = requests.post(f"{BASE}/api/auth/login", json={"username": "Yunwei", "password": "yunwei1025"}, headers=headers)
token = r.json()["token"]
headers["Authorization"] = f"Bearer {token}"

# Get all machines
r = requests.get(f"{BASE}/api/machines", headers=headers)
machines = r.json()

# Find we-001
for m in machines:
    if m.get("machineNumber") == "we-001":
        print("we-001 fields:")
        for k, v in m.items():
            print(f"  {k}: {v}")
        print(f"\n  updatedAt type: {type(m.get('updatedAt'))}")
        print(f"  updatedAt value: {m.get('updatedAt')}")
        break
