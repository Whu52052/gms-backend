import requests, json

BASE = 'http://localhost:8765'

# Test yunying (operations superadmin)
r = requests.post(f'{BASE}/api/auth/login', json={'username': 'yunying', 'password': 'yunying1025'})
t = r.json()['token']
h = {'Authorization': f'Bearer {t}'}
r = requests.get(f'{BASE}/api/users', headers=h)
users = r.json()
print(f'yunying (ops superadmin) sees {len(users)} users:')
for u in users:
    print(f'  {u.get("displayName", u["username"])} / {u["system"]} / {u["role"]}')

print()

# Test admin (maintenance admin)
r = requests.post(f'{BASE}/api/auth/login', json={'username': 'admin', 'password': 'admin123'})
t = r.json()['token']
h = {'Authorization': f'Bearer {t}'}
r = requests.get(f'{BASE}/api/users', headers=h)
users = r.json()
print(f'admin (mnt admin) sees {len(users)} users:')
for u in users:
    print(f'  {u.get("displayName", u["username"])} / {u["system"]} / {u["role"]}')
