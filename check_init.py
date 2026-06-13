import requests, sys
sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://123.207.74.164:8765"

# Get operations.html
r = requests.get(f"{BASE}/operations.html")
html = r.text
print("=== operations.html script includes ===")
for l in html.split('\n'):
    if 'script' in l.lower() and 'src' in l.lower():
        print(f"  {l.strip()[:120]}")

# Get operations.js and check init flow
r = requests.get(f"{BASE}/js/operations.js")
js = r.text
lines = js.split('\n')

print("\n=== operations.js init ===")
for i, line in enumerate(lines):
    if 'async init' in line or 'function init' in line or ('init' in line and '()' in line):
        start = max(0, i)
        end = min(len(lines), i+80)
        for j in range(start, end):
            print(f"  {j+1}: {lines[j][:150]}")
        print("---")
        break

print("\n=== operations.js showLogin ===")
for i, line in enumerate(lines):
    if 'showLogin' in line:
        start = max(0, i)
        end = min(len(lines), i+30)
        for j in range(start, end):
            print(f"  {j+1}: {lines[j][:150]}")
        print("---")
        break

# Check API.init flow
r = requests.get(f"{BASE}/js/api.js")
js = r.text
lines = js.split('\n')
print("\n=== api.js init (health check) ===")
for i, line in enumerate(lines):
    if '_checkServer' in line:
        start = max(0, i)
        end = min(len(lines), i+15)
        for j in range(start, end):
            print(f"  {j+1}: {lines[j][:150]}")
        print("---")
        break
