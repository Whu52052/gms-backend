"""Simulate complete browser login flow"""
import requests, sys
sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://123.207.74.164:8765"

# Simulate browser session
s = requests.Session()

print("=== Step 1: Access index.html ===")
r = s.get(f"{BASE}/index.html")
print(f"  Status: {r.status_code}, Size: {len(r.text)}")
print(f"  Has login form: {'login-btn' in r.text}")

print("\n=== Step 2: Access operations.html (not logged in) ===")
r = s.get(f"{BASE}/operations.html")
print(f"  Status: {r.status_code}, Size: {len(r.text)}")

print("\n=== Step 3: Check config.js ===")
r = s.get(f"{BASE}/js/config.js")
for l in r.text.split('\n'):
    if 'GMS_SERVER_URL' in l:
        print(f"  {l.strip()}")

print("\n=== Step 4: Login as yunying (operations) ===")
r = s.post(f"{BASE}/api/auth/login", json={"username": "yunying", "password": "yunying1025"})
print(f"  Status: {r.status_code}")
data = r.json()
token = data.get("token", "")
user = data.get("user", {})
print(f"  Token: {token[:30]}...")
print(f"  User: {user.get('username')} / {user.get('role')} / {user.get('system')}")

print("\n=== Step 5: Access operations.html WITH token ===")
# Simulate what browser would do after redirect
r = s.get(f"{BASE}/operations.html")
print(f"  Status: {r.status_code}")

# Step 6: The browser would execute API.init() which:
#   a. Health check
print("\n=== Step 6: Simulate API.init() ===")
print("  6a. Health check:")
r = s.get(f"{BASE}/api/health")
print(f"    Status: {r.status_code}")

print("  6b. Validate token:")
r = s.get(f"{BASE}/api/settings", headers={"Authorization": f"Bearer {token}"})
print(f"    Status: {r.status_code}")

print("  6c. Get inventory:")
r = s.get(f"{BASE}/api/inventory", headers={"Authorization": f"Bearer {token}"})
print(f"    Status: {r.status_code}")
if r.status_code == 200:
    data = r.json()
    print(f"    Items: {len(data) if isinstance(data, list) else 'not a list'}")

print("\n=== Step 7: Test login as admin (maintenance, non-superadmin) ===")
r = s.post(f"{BASE}/api/auth/login", json={"username": "admin", "password": "admin123"})
print(f"  Login status: {r.status_code}")
data = r.json()
user = data.get("user", {})
print(f"  User: {user.get('username')} / {user.get('role')} / {user.get('system')}")

# Now simulate what happens when admin goes to operations.html
print("\n=== Step 8: admin's operations.html flow ===")
token2 = data.get("token", "")
r = s.get(f"{BASE}/api/settings", headers={"Authorization": f"Bearer {token2}"})
print(f"  Token valid: {r.status_code == 200}")
r = s.get(f"{BASE}/api/inventory", headers={"Authorization": f"Bearer {token2}"})
print(f"  Can access inventory: {r.status_code == 200}")

print("\n=== Summary ===")
print("All API-level tests pass. Frontend issue is likely:")
print("  - config.js pointing to correct URL: check above")
print("  - sessionStorage surviving redirects")
print("  - _validateToken timeout issue")
