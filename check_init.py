"""Check gms-backend init flow — reads files locally, no server needed."""
import sys, os
sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.abspath(__file__))

def show(lines, label, start_hint, context=80):
    print(f"\n=== {label} ===")
    for i, line in enumerate(lines):
        if start_hint in line:
            start = max(0, i)
            end = min(len(lines), i + context)
            for j in range(start, end):
                print(f"  {j+1}: {lines[j][:150]}")
            print("---")
            return
    print("  (not found)")

# --- operations.html ---
with open(os.path.join(ROOT, 'operations.html'), encoding='utf-8') as f:
    html = f.read()
print("=== operations.html script includes ===")
for l in html.split('\n'):
    if 'script' in l.lower() and 'src' in l.lower():
        print(f"  {l.strip()[:120]}")

# --- operations.js ---
with open(os.path.join(ROOT, 'js', 'operations.js'), encoding='utf-8') as f:
    js = f.read()
lines = js.split('\n')
show(lines, "operations.js init", 'async init()')
show(lines, "operations.js showLogin", 'showLogin')

# --- api.js ---
with open(os.path.join(ROOT, 'js', 'api.js'), encoding='utf-8') as f:
    js = f.read()
lines = js.split('\n')
show(lines, "api.js init (_checkServer)", '_checkServer')
