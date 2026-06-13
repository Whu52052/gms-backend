"""Debug operations login issue"""
import requests, json, sys
sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://123.207.74.164:8765"
headers = {"Content-Type": "application/json"}

# Test yunying login
print("=== yunying login ===")
r = requests.post(f"{BASE}/api/auth/login", json={"username": "yunying", "password": "yunying1025"}, headers=headers)
print(f"Status: {r.status_code}")
data = r.json()
print(f"Response: {json.dumps(data, ensure_ascii=False, indent=2)}")

# Check user data
if "user" in data:
    user = data["user"]
    print(f"\nUser details:")
    print(f"  Role: {user.get('role')}")
    print(f"  System: {user.get('system')}")
    print(f"  Username: {user.get('username')}")

# Test Yunwei login
print("\n=== Yunwei login ===")
r = requests.post(f"{BASE}/api/auth/login", json={"username": "Yunwei", "password": "yunwei1025"}, headers=headers)
print(f"Status: {r.status_code}")
data = r.json()
if "user" in data:
    print(f"  Role: {data['user'].get('role')}")
    print(f"  System: {data['user'].get('system')}")

# Check frontend pages
print("\n=== Frontend check ===")
for page in ["/", "/operations.html"]:
    r = requests.get(f"{BASE}{page}")
    print(f"{page}: {r.status_code}, {len(r.text)} bytes")

# Check JS for login logic
r = requests.get(f"{BASE}/js/api.js")
apijs = r.text
print(f"\napi.js: {len(apijs)} bytes")
# Find login function
for line in apijs.split('\n'):
    if 'login' in line.lower() and 'async' in line.lower():
        print(f"  Login func: {line.strip()[:100]}")
        break

# Check if there's system-based redirect
for line in apijs.split('\n'):
    if 'system' in line.lower() and ('operation' in line.lower() or 'maintenance' in line.lower()):
        print(f"  System check: {line.strip()[:120]}")

# Check operations.js for login
r = requests.get(f"{BASE}/js/operations.js")
opsjs = r.text
print(f"\noperations.js: {len(opsjs)} bytes")
for line in opsjs.split('\n'):
    if 'login' in line.lower() and ('function' in line.lower() or 'async' in line.lower()):
        print(f"  Ops login: {line.strip()[:120]}")

# Check app.js for login handling
r = requests.get(f"{BASE}/js/app.js")
appjs = r.text
print(f"\napp.js: {len(appjs)} bytes")
# Find system-based routing
for line in appjs.split('\n'):
    if 'system' in line.lower() and ('operations' in line.lower() or 'maintenance' in line.lower()):
        print(f"  System route: {line.strip()[:150]}")
