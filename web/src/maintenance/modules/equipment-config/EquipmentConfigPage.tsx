// 设备类型配置页（移植 js/ui/equipment-config.js renderEquipmentConfig）
import { useState } from 'react';
import { Button, Card, Flex, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, message } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { PageContainer } from '@common/components/PageContainer';
import { useEquipmentConfig, useInventoryConfig } from '@common/hooks/useData';
import { useAuthStore, isAdmin } from '@common/stores/auth';
import { typeLabelOf } from '@common/utils/domain';
import { formatTime } from '@common/utils/format';
import * as api from '@common/api';

export default function EquipmentConfigPage() {
  const user = useAuthStore(s => s.user);
  const { data: configs = [], isLoading } = useEquipmentConfig();
  const { data: inventoryConfig = [] } = useInventoryConfig();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<any | null | 'new'>(null);
  const [form] = Form.useForm();

  // 页面级权限拦截：设备类型配置仅管理员可用
  if (!isAdmin(user)) {
    return (
      <PageContainer title="⚙️ 设备类型配置">
        <Card><div style={{ opacity: 0.6 }}>无权限访问</div></Card>
      </PageContainer>
    );
  }

  const invOptions = inventoryConfig.map((c: any) => ({ value: c.id, label: `${c.icon || ''} ${c.name}` }));

  const refresh = () => qc.invalidateQueries({ queryKey: ['equipment-config'] });

  const openAdd = () => {
    setEditing('new');
    form.setFieldsValue({ name: '', icon: '', consumes: [] });
  };
  const openEdit = (c: any) => {
    setEditing(c);
    form.setFieldsValue({ name: c.name, icon: c.icon || '', consumes: (c.consumes || []).map((x: any) => ({ ...x })) });
  };

  const doSave = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const consumes = (v.consumes || [])
      .filter((r: any) => r && r.inventoryType)
      .map((r: any) => ({ inventoryType: r.inventoryType, handType: r.handType || null, quantity: Number(r.quantity) || 1 }));
    const isEdit = editing !== 'new' && editing;
    const cfg = {
      id: isEdit ? editing.id : `eq-${Date.now().toString(36)}`,
      name: v.name.trim(),
      icon: (v.icon || '').trim(),
      consumes,
      createdAt: isEdit ? editing.createdAt : new Date().toISOString(),
    };
    const all = isEdit ? configs.map(c => (c.id === cfg.id ? cfg : c)) : [...configs, cfg];
    try {
      await api.saveEquipmentConfig(all);
      message.success(isEdit ? '设备类型已更新' : '设备类型已添加');
      setEditing(null);
      refresh();
    } catch (e: any) {
      message.error(`保存失败: ${e?.message || ''}`);
    }
  };

  const doDelete = async (c: any) => {
    try {
      await api.deleteEquipmentConfig(c.id);
      message.success(`设备类型 "${c.name}" 已删除`);
      refresh();
    } catch {
      // 兜底：整体保存过滤后的列表
      try {
        await api.saveEquipmentConfig(configs.filter(x => x.id !== c.id));
        message.success(`设备类型 "${c.name}" 已删除`);
        refresh();
      } catch (e: any) {
        message.error(`删除失败: ${e?.message || ''}`);
      }
    }
  };

  const columns: any[] = [
    { title: '图标', dataIndex: 'icon', width: 70, render: (v: string) => <span style={{ fontSize: 24 }}>{v || ''}</span> },
    { title: '名称', dataIndex: 'name', render: (v: string) => <strong>{v}</strong> },
    {
      title: '消耗库存', dataIndex: 'consumes',
      render: (consumes: any[]) => (consumes || []).map(i =>
        `${typeLabelOf(i.inventoryType, inventoryConfig) || i.inventoryType}${i.handType === 'left' ? '(左手)' : i.handType === 'right' ? '(右手)' : ''} x${i.quantity}`).join('、') || '-',
    },
    { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (t: string) => formatTime(t) },
    {
      title: '操作', key: 'actions', width: 140,
      render: (_: any, c: any) => (
        <Space size={4}>
          <Button size="small" onClick={() => openEdit(c)}>编辑</Button>
          <Popconfirm title="删除设备类型" description={`确定要删除 "${c.name}" 吗？已存在的机器记录不受影响。`}
            onConfirm={() => doDelete(c)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
            <Button size="small" danger>清除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      title="🔧 设备类型配置"
      subtitle="设备类型定义了机器上/下线时自动消耗和归还哪些库存物品。修改后仅对新记录生效。"
      extra={<Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>添加设备类型</Button>}
    >
      <Table rowKey="id" size="middle" loading={isLoading} columns={columns} dataSource={configs} pagination={false} />

      <Modal title={editing === 'new' ? '添加设备类型' : '编辑设备类型'} open={!!editing}
        onCancel={() => setEditing(null)} onOk={doSave} okText="保存" width={620} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="设备名称" rules={[{ required: true, message: '请输入设备名称' }]}>
            <Input placeholder="例如：纯手套设备" />
          </Form.Item>
          <Form.Item name="icon" label="图标 (表情符号)" extra="可直接输入任意表情符号">
            <Input placeholder="例如 🤖" />
          </Form.Item>
          <Form.Item label="消耗库存物品" extra="上/下线时自动消耗/归还的库存物品及数量">
            <Form.List name="consumes">
              {(fields, { add, remove }) => (
                <div>
                  {fields.map(({ key, name }) => (
                    <Flex key={key} gap={8} align="start" style={{ marginBottom: 8 }}>
                      <Form.Item name={[name, 'inventoryType']} noStyle rules={[{ required: true, message: '请选择' }]}>
                        <Select style={{ flex: 2, minWidth: 140 }} placeholder="库存类型" options={invOptions} />
                      </Form.Item>
                      <Form.Item name={[name, 'handType']} noStyle>
                        <Select style={{ width: 90 }} options={[
                          { value: '', label: '不区分' },
                          { value: 'left', label: '左手' },
                          { value: 'right', label: '右手' },
                        ]} />
                      </Form.Item>
                      <Form.Item name={[name, 'quantity']} noStyle initialValue={1}>
                        <InputNumber min={1} style={{ width: 80 }} placeholder="数量" />
                      </Form.Item>
                      <Button type="text" danger icon={<MinusCircleOutlined />} onClick={() => remove(name)} />
                    </Flex>
                  ))}
                  <Button size="small" icon={<PlusOutlined />} onClick={() => add({ inventoryType: '', handType: '', quantity: 1 })}>
                    添加库存消耗
                  </Button>
                </div>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
