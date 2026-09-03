// 库存类型配置页（移植 js/ui/equipment-config.js renderInventoryConfig 及导入导出）
import { useRef, useState } from 'react';
import { Button, Card, Form, Input, Modal, Popconfirm, Radio, Space, Switch, Table, Tag, message } from 'antd';
import { DownloadOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useInventoryConfig } from '@common/hooks/useData';
import { useAuthStore, isAdmin } from '@common/stores/auth';
import { formatTime } from '@common/utils/format';
import * as api from '@common/api';

export default function InventoryConfigPage() {
  const user = useAuthStore(s => s.user);
  const { data: configs = [], isLoading } = useInventoryConfig();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<any | null | 'new'>(null);
  const [form] = Form.useForm();
  const importRef = useRef<HTMLInputElement>(null);

  // 页面级权限拦截：库存类型配置仅管理员可用
  if (!isAdmin(user)) {
    return (
      <PageContainer title="🗄 库存类型配置">
        <Card><div style={{ opacity: 0.6 }}>无权限访问</div></Card>
      </PageContainer>
    );
  }

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['inventory-config'] });
    qc.invalidateQueries({ queryKey: ['inventory'] });
  };

  const openAdd = () => {
    setEditing('new');
    form.setFieldsValue({ name: '', sku: '', icon: '', hasLeftRight: false, trackingMode: 'quantity' });
  };
  const openEdit = (c: any) => {
    setEditing(c);
    form.setFieldsValue({
      name: c.name, sku: c.sku || c.id, icon: c.icon || '',
      hasLeftRight: !!c.hasLeftRight, trackingMode: c.trackingMode === 'quantity' ? 'quantity' : 'sn',
    });
  };

  const doSave = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const name = v.name.trim();
    const sku = (v.sku || '').trim();
    const icon = (v.icon || '').trim();
    const isEdit = editing !== 'new' && editing;
    if (!isEdit) {
      if (!sku) { message.error('请输入SKU编码'); return; }
      if (!/^\S+$/.test(sku)) { message.error('SKU编码不能包含空白字符'); return; }
      const dup = configs.find((c: any) => (c.sku || c.id).toLowerCase() === sku.toLowerCase());
      if (dup) { message.error(`SKU "${sku}" 已存在（${dup.name}）`); return; }
    }
    try {
      // 语义约束：纯数量跟踪不分左右手（后端同样强制）
      const mode = v.trackingMode === 'quantity' ? 'quantity' : 'sn';
      const hasLR = mode === 'quantity' ? false : !!v.hasLeftRight;
      if (isEdit) {
        await api.updateInventoryConfigItem(editing.id, {
          name, sku: editing.sku || editing.id, icon, hasLeftRight: hasLR,
          trackingMode: mode,
        });
        message.success('库存类型已更新');
      } else {
        const res: any = await api.addInventoryConfigItem({
          name, sku, icon, hasLeftRight: hasLR,
          trackingMode: mode,
        });
        if (res && res.success === false) {
          message.warning(`服务端添加失败${res.error ? `: ${res.error}` : ''}`);
        } else {
          message.success(`库存类型 "${name}" 已添加（SKU: ${sku}）`);
        }
      }
      setEditing(null);
      refresh();
    } catch (e: any) {
      message.error(`保存失败: ${e?.message || ''}`);
    }
  };

  const doDelete = async (c: any) => {
    try {
      await api.deleteInventoryConfig(c.id);
      message.success(`库存类型 "${c.name}" 已删除`);
      refresh();
    } catch (e: any) {
      message.error(`删除失败: ${e?.message || ''}`);
    }
  };

  // 导出配置为 JSON 文件
  const exportConfig = () => {
    const blob = new Blob([JSON.stringify(configs.map((c: any) => ({
      name: c.name, sku: c.sku || c.id, icon: c.icon || '', hasLeftRight: !!c.hasLeftRight,
      trackingMode: c.trackingMode === 'quantity' ? 'quantity' : 'sn',
    })), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('库存配置已导出');
  };

  // 从 JSON 文件导入（服务端批量入库 + 自动初始化库存 + 审计）
  const importConfig = async (file: File) => {
    try {
      const text = await file.text();
      const items = JSON.parse(text);
      const list = Array.isArray(items) ? items : (items.items || []);
      if (list.length === 0) { message.error('配置文件中没有库存类型数据'); return; }
      Modal.confirm({
        title: '导入库存类型配置',
        content: `将导入 ${list.length} 个库存类型（服务端自动创建库存记录），继续吗？`,
        okText: '导入',
        onOk: async () => {
          const res: any = await api.importInventoryConfig(list).catch((err: any) => ({ error: err.message }));
          if (res && res.success) {
            message.success(`导入成功：新增 ${res.added} 项，更新 ${res.updated} 项，跳过 ${res.skipped} 项`);
            refresh();
          } else {
            message.error(`导入失败${res && res.error ? `: ${res.error}` : ''}`);
          }
        },
      });
    } catch (e: any) {
      message.error(`配置文件解析失败: ${e?.message || ''}`);
    }
  };

  const columns: any[] = [
    { title: '图标', dataIndex: 'icon', width: 70, render: (v: string) => <span style={{ fontSize: 24 }}>{v || ''}</span> },
    { title: '名称', dataIndex: 'name', render: (v: string) => <strong>{v}</strong> },
    { title: 'SKU编码', key: 'sku', width: 160, render: (_: any, c: any) => <Tag>{c.sku || c.id}</Tag> },
    {
      title: '跟踪模式', dataIndex: 'trackingMode', width: 130,
      render: (v: string) => v === 'quantity'
        ? <Tag color="geekblue">纯数量</Tag>
        : <Tag color="cyan">SN 精细</Tag>,
    },
    { title: '左右手', dataIndex: 'hasLeftRight', width: 90, render: (v: boolean) => (v ? '区分左右' : '—') },
    { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (t: string) => formatTime(t) },
    {
      title: '操作', key: 'actions', width: 140,
      render: (_: any, c: any) => (
        <Space size={4}>
          <Button size="small" onClick={() => openEdit(c)}>编辑</Button>
          <Popconfirm title="删除库存类型" description={`确定要删除 "${c.name}" 吗？已存在的库存和交易记录不受影响。`}
            onConfirm={() => doDelete(c)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
            <Button size="small" danger>清除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      title="📦 库存类型配置"
      subtitle="库存类型定义了可以追踪库存量的物品类别。添加后会在侧边栏出现对应的管理页面，无需修改代码或重启服务。"
      extra={
        <Space>
          <input ref={importRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) importConfig(f); e.target.value = ''; }} />
          <Button icon={<UploadOutlined />} onClick={() => importRef.current?.click()}>导入配置</Button>
          <Button icon={<DownloadOutlined />} onClick={exportConfig}>导出配置</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>添加库存类型</Button>
        </Space>
      }
    >
      <Table rowKey="id" size="middle" loading={isLoading} columns={columns} dataSource={configs} pagination={false} />

      <Modal title={editing === 'new' ? '添加库存类型' : '编辑库存类型'} open={!!editing}
        onCancel={() => setEditing(null)} onOk={doSave} okText="保存" destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="库存名称" rules={[{ required: true, message: '请输入库存名称' }]}>
            <Input placeholder="例如：传感器" />
          </Form.Item>
          <Form.Item name="sku" label="SKU编码"
            extra="SKU 为物品唯一编码，添加后不可修改。将自动作为库存类型 ID 使用。"
            rules={[{ required: editing === 'new', message: '请输入SKU编码' }]}>
            <Input placeholder="例如：SENSOR-01" disabled={editing !== 'new'} />
          </Form.Item>
          <Form.Item name="icon" label="图标 (表情符号)" extra="可直接输入任意表情符号">
            <Input placeholder="例如 📡" />
          </Form.Item>
          <Form.Item name="trackingMode" label="跟踪模式"
            extra="SN 精细：逐件登记SN码，支持单件状态追溯（任何物品都可选用）；纯数量：只记数量，适合无需逐件追溯的耗材。品类有库存数据后不可切换。">
            <Radio.Group>
              <Radio.Button value="sn">SN 精细跟踪</Radio.Button>
              <Radio.Button value="quantity">纯数量跟踪</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.trackingMode !== cur.trackingMode}>
            {({ getFieldValue }) => getFieldValue('trackingMode') !== 'quantity' && (
              <Form.Item name="hasLeftRight" label="区分左右手" valuePropName="checked"
                extra="仅 SN 精细跟踪可用：启用后自动创建左手和右手两个独立库存项（如手套、灵巧手）">
                <Switch />
              </Form.Item>
            )}
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
