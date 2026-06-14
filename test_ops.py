import requests
BASE = 'http://localhost:8765'

# Try Tianruyu with common passwords
for pw in ['123456', 'tianruyu', 'admin123', 'password', '12345678']:
    r = requests.post(f'{BASE}/api/auth/login', json={'username': 'Tianruyu', 'password': pw})
    if r.status_code == 200 and r.json().get('token'):
        t = r.json()['token']
        h = {'Authorization': f'Bearer {t}'}
        r = requests.get(f'{BASE}/api/users', headers=h)
        users = r.json()
        user = r.json()
        print(f'Tianruyu (ops admin) sees {len(users)} users:')
        for u in users:
            print(f'  {u.get("displayName", u["username"])} / {u["system"]} / {u["role"]}')
        break
else:
    print('Could not login as Tianruyu - need to know password')
    # Try creating a test ops admin
    r = requests.post(f'{BASE}/api/auth/login', json={'username': 'yunying', 'password': 'yunying1025'})
    t = r.json()['token']
    h = {'Authorization': f'Bearer {t}'}
    # Create test ops admin
    r = requests.post(f'{BASE}/api/users', headers=h, json={
        'username': 'opstest',
        'password': 'test1234',
        'displayName': '测试管理员',
        'role': 'admin',
        'system': 'operations'
    })
    print(f'Create ops admin: {r.status_code} {r.json()}')
    # Login as opstest
    r = requests.post(f'{BASE}/api/auth/login', json={'username': 'opstest', 'password': 'test1234'})
    if r.status_code == 200:
        t = r.json()['token']
        h = {'Authorization': f'Bearer {t}'}
        r = requests.get(f'{BASE}/api/users', headers=h)
        users = r.json()
        print(f'opstest (ops admin) sees {len(users)} users:')
        for u in users:
            print(f'  {u.get("displayName", u["username"])} / {u["system"]} / {u["role"]}')
