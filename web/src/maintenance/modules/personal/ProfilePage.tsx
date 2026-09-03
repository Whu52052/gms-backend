// 个人资料页（移植 js/ui/personal-center.js renderProfile）：基本信息/修改密码/偏好设置
import { useState } from 'react';
import { Avatar, Button, Card, Col, Descriptions, Form, Input, Row, Select, Switch, Tabs, Tag, message } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useAuthStore } from '@common/stores/auth';
import { useUIStore } from '@common/stores/ui';
import * as api from '@common/api';

const PREF_KEY = 'gms_user_preferences';
function getPrefs(): any {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || 'null') || {
      email: '', phone: '', department: '', language: 'zh-CN',
      notifyEmail: true, notifySms: false, notifyInApp: true, compactMode: false,
    };
  } catch { return {}; }
}
function savePrefs(p: any) { localStorage.setItem(PREF_KEY, JSON.stringify(p)); }

const ROLE_LABEL: Record<string, string> = { superadmin: '超级管理员', admin: '管理员', ops: '运维', user: '普通用户' };

export default function ProfilePage() {
  const user = useAuthStore(s => s.user);
  const setUser = useAuthStore(s => s.setUser);
  const theme = useUIStore(s => s.theme);
  const toggleTheme = useUIStore(s => s.toggleTheme);

  const { data: serverProfile } = useQuery({ queryKey: ['my-profile'], queryFn: () => api.getMyProfile().catch(() => null) });
  const p = serverProfile || user || {};

  const [infoForm] = Form.useForm();
  const [pwdForm] = Form.useForm();
  const [prefs, setPrefs] = useState(getPrefs);

  const roleLabel = ROLE_LABEL[p.role] || p.role || '—';
  const systemLabel = p.system === 'operations' ? '运营系统' : '运维系统';

  const saveInfo = async () => {
    const v = await infoForm.validateFields().catch(() => null);
    if (!v) return;
    const nextPrefs = { ...prefs, email: (v.email || '').trim(), phone: (v.phone || '').trim() };
    savePrefs(nextPrefs);
    setPrefs(nextPrefs);
    if (v.displayName?.trim()) {
      try {
        await api.updateMyProfile({ displayName: v.displayName.trim(), email: nextPrefs.email, phone: nextPrefs.phone });
        if (user) setUser({ ...user, displayName: v.displayName.trim() });
        message.success('个人资料已更新');
      } catch (e: any) {
        message.error(`保存失败：${e?.message || ''}`);
      }
    } else {
      message.success('偏好已保存');
    }
  };

  const changePwd = async () => {
    const v = await pwdForm.validateFields().catch(() => null);
    if (!v) return;
    if (v.newPassword.length < 6) { message.warning('新密码至少6个字符'); return; }
    if (!/[A-Za-z]/.test(v.newPassword) || !/[0-9]/.test(v.newPassword)) { message.warning('新密码需包含字母和数字'); return; }
    if (v.newPassword !== v.confirm) { message.warning('两次输入不一致'); return; }
    try {
      const res: any = await api.changePassword(v.oldPassword, v.newPassword);
      if (res && (res.success === false || res.error)) { message.error(res.error || '修改失败'); return; }
      message.success('密码已修改');
      pwdForm.resetFields();
    } catch (e: any) {
      message.error(e?.message || '修改失败');
    }
  };

  const updatePref = (key: string, value: any) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    savePrefs(next);
  };

  return (
    <PageContainer title="👤 个人资料" subtitle="账号信息、密码与偏好设置">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <Card size="small" style={{ textAlign: 'center' }}>
            <Avatar size={80} style={{ background: '#0a0a0a', fontSize: 32 }}>
              {(p.displayName || p.username || '?')[0]?.toUpperCase()}
            </Avatar>
            <h3 style={{ margin: '12px 0 4px' }}>{p.displayName || p.username}</h3>
            <Tag color={p.role === 'superadmin' ? 'volcano' : p.role === 'admin' ? 'purple' : 'blue'}>{roleLabel}</Tag>
            <Descriptions column={1} size="small" style={{ marginTop: 16, textAlign: 'left' }} items={[
              { key: '1', label: '账号', children: p.username || '—' },
              { key: '2', label: '所属系统', children: systemLabel },
              { key: '3', label: '邮箱', children: prefs.email || '—' },
              { key: '4', label: '电话', children: prefs.phone || '—' },
            ]} />
          </Card>
        </Col>
        <Col xs={24} md={16}>
          <Card size="small">
            <Tabs items={[
              {
                key: 'info', label: '基本信息',
                children: (
                  <Form form={infoForm} layout="vertical" style={{ maxWidth: 420 }}
                    initialValues={{ displayName: p.displayName || '', email: prefs.email || '', phone: prefs.phone || '' }}>
                    <Form.Item name="displayName" label="中文名" rules={[{ required: true, message: '请输入中文名' }]}>
                      <Input placeholder="用于显示的中文姓名" />
                    </Form.Item>
                    <Form.Item name="email" label="邮箱"><Input placeholder="选填" /></Form.Item>
                    <Form.Item name="phone" label="电话"><Input placeholder="选填" /></Form.Item>
                    <Button type="primary" onClick={saveInfo}>保存</Button>
                  </Form>
                ),
              },
              {
                key: 'security', label: '修改密码',
                children: (
                  <Form form={pwdForm} layout="vertical" style={{ maxWidth: 420 }}>
                    <Form.Item name="oldPassword" label="旧密码" rules={[{ required: true, message: '请输入旧密码' }]}>
                      <Input.Password />
                    </Form.Item>
                    <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }]}
                      extra="至少6位，需包含字母和数字">
                      <Input.Password />
                    </Form.Item>
                    <Form.Item name="confirm" label="确认新密码" rules={[{ required: true, message: '请再次输入新密码' }]}>
                      <Input.Password />
                    </Form.Item>
                    <Button type="primary" onClick={changePwd}>修改密码</Button>
                  </Form>
                ),
              },
              {
                key: 'prefs', label: '偏好设置',
                children: (
                  <div style={{ maxWidth: 420 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid rgba(128,128,128,.15)' }}>
                      <span>深色模式</span>
                      <Switch checked={theme === 'dark'} onChange={toggleTheme} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid rgba(128,128,128,.15)' }}>
                      <span>语言</span>
                      <Select style={{ width: 140 }} value={prefs.language || 'zh-CN'}
                        onChange={v => updatePref('language', v)}
                        options={[{ value: 'zh-CN', label: '简体中文' }]} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid rgba(128,128,128,.15)' }}>
                      <span>站内通知</span>
                      <Switch checked={prefs.notifyInApp !== false} onChange={v => updatePref('notifyInApp', v)} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0' }}>
                      <span>紧凑模式</span>
                      <Switch checked={!!prefs.compactMode} onChange={v => updatePref('compactMode', v)} />
                    </div>
                  </div>
                ),
              },
            ]} />
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
}
