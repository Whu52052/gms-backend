import requests, json

BASE = 'http://localhost:8765'

# Login as Tianruyu
r = requests.post(f'{BASE}/api/auth/login', json={'username': 'Tianruyu', 'password': 'admin123'})
t = r.json()['token']
h = {'Authorization': f'Bearer {t}', 'Content-Type': 'application/json'}

# Check current group
print('=== Before transfer ===')
r = requests.get(f'{BASE}/api/group/members', headers=h)
groups = r.json()
for g in groups if isinstance(groups, list) else groups.values():
    admin = g.get('adminName', '?')
    for m in g.get('members', []):
        print(f'  Admin={admin}: {m.get("username")} (parentId={m.get("parentId", "?")})')

# Get Tianruyu's users
r = requests.get(f'{BASE}/api/users', headers=h)
users = r.json()
print(f'\nTianruyu users:')
for u in users:
    print(f'  {u.get("username")} / parentId={u.get("parentId")} / id={u["id"]}')

# Find a test user (caiji or similar) and another admin to transfer to
target_user = None
target_admin = None
for u in users:
    if u.get('username') == 'caiji' and u.get('parentId'):
        target_user = u
    if u.get('role') == 'admin' and u.get('id') != users[0].get('id'):
        target_admin = u

if not target_user:
    # Use any user
    for u in users:
        if u.get('role') == 'user':
            target_user = u
            break

print(f'\nTarget user: {target_user}')
print(f'Target admin: {target_admin}')

if target_user and target_admin:
    # Create transfer
    body = {
        'toAdminId': target_admin['id'],
        'userId': target_user['id'],
        'username': target_user['username'],
        'direction': 'out',
        'reason': 'test transfer'
    }
    r = requests.post(f'{BASE}/api/group/transfer', headers=h, json=body)
    print(f'\nCreate transfer: {r.status_code} {r.json()}')
    transfer_id = r.json().get('item', {}).get('id')

    if transfer_id:
        # Approve transfer (as Tianruyu - the sender)
        r = requests.post(f'{BASE}/api/group/transfer/{transfer_id}/approve', headers=h)
        print(f'Approve transfer: {r.status_code} {r.json()}')

        # Check parentId after
        r = requests.get(f'{BASE}/api/users', headers=h)
        for u in r.json():
            if u['id'] == target_user['id']:
                print(f'\nAfter transfer: {u.get("username")} parentId={u.get("parentId")} (was {target_user.get("parentId")})')

        # Check group after
        print('\n=== After transfer ===')
        r = requests.get(f'{BASE}/api/group/members', headers=h)
        groups = r.json()
        for g in groups if isinstance(groups, list) else groups.values():
            admin = g.get('adminName', '?')
            for m in g.get('members', []):
                print(f'  Admin={admin}: {m.get("username")} (parentId={m.get("parentId", "?")})')
