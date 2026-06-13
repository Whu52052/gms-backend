import requests, sys, re
sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://123.207.74.164:8765"

# Get app.js and check the login routing
r = requests.get(f"{BASE}/js/app.js")
js = r.text

# Find all references to system/operations routing
print("=== System routing in app.js ===")
lines = js.split('\n')
for i, line in enumerate(lines):
    if 'operations' in line.lower() and ('redirect' in line.lower() or 'window.location' in line.lower() or 'href' in line.lower() or 'switch' in line.lower()):
        # Show context
        start = max(0, i-3)
        end = min(len(lines), i+5)
        for j in range(start, end):
            marker = ">>>" if j == i else "   "
            print(f"{marker} {j+1}: {lines[j][:150]}")
        print("---")

# Also check the doLogin in operations.js
print("\n=== operations.js doLogin ===")
r = requests.get(f"{BASE}/js/operations.js")
js = r.text
lines = js.split('\n')
for i, line in enumerate(lines):
    if 'doLogin' in line:
        start = max(0, i)
        end = min(len(lines), i+50)
        for j in range(start, end):
            print(f"  {j+1}: {lines[j][:150]}")
        break

# Check app.js doLogin
print("\n=== app.js doLogin ===")
r = requests.get(f"{BASE}/js/app.js")
js = r.text
lines = js.split('\n')
for i, line in enumerate(lines):
    if 'async doLogin' in line or 'function doLogin' in line:
        start = max(0, i)
        end = min(len(lines), i+60)
        for j in range(start, end):
            print(f"  {j+1}: {lines[j][:150]}")
        print("---")
