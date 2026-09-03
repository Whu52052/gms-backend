// 系统设置页（移植 js/ui/settings.js）：外观/仪表板卡片配置/数据管理/完整性检查/关于
import { useRef, useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Col, Flex, InputNumber, Modal, Row, Switch, Tag, message,
} from 'antd';
import {
  CloudDownloadOutlined, CloudUploadOutlined, DeleteOutlined, SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { post } from '@common/api/http';
import { PageContainer } from '@common/components/PageContainer';
import { useSettings, useInventory, useMachines, useTransactions, useInventoryConfig } from '@common/hooks/useData';
import { useUIStore } from '@common/stores/ui';
import { useAuthStore, isAdmin } from '@common/stores/auth';
import { typeLabelOf } from '@common/utils/domain';
import * as api from '@common/api';

const DEFAULT_CARDS = ['totalGloves', 'damagedGloves', 'inRepairGloves', 'left_glove', 'right_glove',
  'left_dexterous_hand', 'right_dexterous_hand', 'gripper', 'onlineMachines', 'todayTransactions'];

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

export default function SettingsPage() {
  const { data: settings } = useSettings();
  const { data: inventory = [] } = useInventory();
  const { data: machines = [] } = useMachines();
  const { data: transactions = [] } = useTransactions();
  const { data: inventoryConfig = [] } = useInventoryConfig();
  const user = useAuthStore(s => s.user);
  const theme = useUIStore(s => s.theme);
  const toggleTheme = useUIStore(s => s.toggleTheme);
  const qc = useQueryClient();

  const selectedCards = settings?.dashboardCards || DEFAULT_CARDS;
  const [cards, setCards] = useState<string[] | null>(null);
  const [threshold, setThreshold] = useState<number>(settings?.lowStockThreshold ?? 10);
  const [restoring, setRestoring] = useState(false);
  const [integrityResult, setIntegrityResult] = useState<{ type: string; msg: string }[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const cardOptions: { value: string; label: string }[] = [
    ...inventoryConfig.flatMap((c: any) => c.hasLeftRight
      ? [
        { value: `${c.id}_left`, label: `${c.icon || '📦'} ${c.name}左手` },
        { value: `${c.id}_right`, label: `${c.icon || '📦'} ${c.name}右手` },
      ]
      : [{ value: c.id, label: `${c.icon || '📦'} ${c.name}` }]),
    { value: 'totalGloves', label: '🧤 手套总数' },
    { value: 'totalDexterous', label: '🤖 灵巧手总数' },
    { value: 'damagedGloves', label: '⚠️ 损坏设备' },
    { value: 'inRepairGloves', label: '🔧 售后中设备' },
    { value: 'onlineMachines', label: '💻 在线机器数量' },
    { value: 'todayTransactions', label: '📋 今日操作记录' },
  ];

  const saveDashboardCards = async () => {
    const selected = cards ?? selectedCards;
    if (selected.length === 0) { message.error('至少需要选择一个卡片'); return; }
    try {
      await api.saveSettings({ ...(settings || {}), dashboardCards: selected });
      qc.invalidateQueries({ queryKey: ['settings'] });
      message.success('仪表板卡片配置已保存');
    } catch (e: any) {
      message.error(`保存失败: ${e?.message || ''}`);
    }
  };

  const saveThreshold = async () => {
    try {
      await api.saveSettings({ ...(settings || {}), lowStockThreshold: threshold });
      qc.invalidateQueries({ queryKey: ['settings'] });
      message.success(`低库存阈值已设置为 ${threshold}`);
    } catch (e: any) {
      message.error(`保存失败: ${e?.message || ''}`);
    }
  };

  // ==================== 备份 / 恢复 / 清空 ====================
  const backupData = async () => {
    try {
      const res = await fetch('/api/export/full', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('导出失败');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `手套管理系统备份-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('数据已备份（含图片）');
    } catch (e: any) {
      message.error(`备份失败: ${e?.message || ''}`);
    }
  };

  const restoreData = (file: File) => {
    const isZip = file.name.endsWith('.zip');
    Modal.confirm({
      title: '恢复数据',
      content: '恢复将覆盖当前全部数据，此操作不可恢复！确定继续？',
      okText: '确认恢复', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: async () => {
        setRestoring(true);
        try {
          if (!isZip) throw new Error('仅支持 ZIP 完整备份文件');
          const arrayBuf = await file.arrayBuffer();
          const base64 = arrayBufferToBase64(arrayBuf);
          const data: any = await post('/api/import/full', { zipData: base64 }, 300000);
          if (!data?.success) throw new Error(data?.error || data?.message || '恢复失败');
          qc.invalidateQueries();
          message.success('数据已恢复！');
        } catch (e: any) {
          message.error(`恢复失败: ${e?.message || ''}`);
        } finally {
          setRestoring(false);
        }
      },
    });
  };

  const resetAllData = () => {
    if (!isAdmin(user)) { message.error('仅管理员可执行此操作'); return; }
    Modal.confirm({
      title: '清空所有数据',
      content: '确定要清空所有数据吗？此操作不可恢复！',
      okText: '继续', okButtonProps: { danger: true },
      onOk: () => new Promise<void>(resolve => {
        Modal.confirm({
          title: '二次确认',
          content: '再次确认：清空所有手套库存、灵巧手库存、夹爪库存、机器记录和流水记录？',
          okText: '确认清空', okButtonProps: { danger: true },
          onOk: async () => {
            await api.clearAllData();
            qc.invalidateQueries();
            message.success('所有数据已清空');
            resolve();
          },
          onCancel: () => resolve(),
        });
      }),
    });
  };

  // ==================== 数据完整性检查 ====================
  const checkDataIntegrity = async () => {
    const issues: { type: string; msg: string }[] = [];
    inventory.forEach(inv => {
      if (inv.quantity < 0) issues.push({ type: 'error', msg: `${typeLabelOf(inv.type, inventoryConfig)} 库存为负数 (${inv.quantity})` });
    });
    machines.forEach(m => {
      if (!m.deviceType) issues.push({ type: 'warning', msg: `机器 ${m.machineNumber} (${m.id}) 缺少设备类型` });
    });
    const onlineByMachine: Record<string, number> = {};
    machines.filter(m => m.status === 'online').forEach(m => {
      onlineByMachine[m.machineNumber] = (onlineByMachine[m.machineNumber] || 0) + 1;
    });
    Object.entries(onlineByMachine).forEach(([num, count]) => {
      if (count > 1) issues.push({ type: 'warning', msg: `机器 ${num} 存在 ${count} 条在线记录（应只有1条）` });
    });
    const machineNumbers = new Set(machines.map(m => m.machineNumber));
    transactions.forEach(t => {
      if (t.machineNumber && !machineNumbers.has(t.machineNumber)) {
        issues.push({ type: 'warning', msg: `流水 ${t.id} 引用不存在机器 ${t.machineNumber}` });
      }
    });
    // 服务器端检查
    try {
      const data = await api.getDataIntegrity();
      (data?.issues || []).forEach((i: string) => issues.push({ type: 'warning', msg: `服务器：${i}` }));
    } catch { /* ignore */ }
    setIntegrityResult(issues);
  };

  return (
    <PageContainer title="⚙️ 系统设置" subtitle="外观、卡片配置与数据管理">
      <Row gutter={[16, 16]}>
        {/* 外观设置 */}
        <Col xs={24} lg={12}>
          <Card size="small" title="外观设置">
            <Flex justify="space-between" align="center">
              <span>深色模式</span>
              <Flex align="center" gap={8}>
                <Switch checked={theme === 'dark'} onChange={toggleTheme} />
                <span style={{ opacity: 0.6, fontSize: 12 }}>{theme === 'dark' ? '已开启' : '浅色模式'}</span>
              </Flex>
            </Flex>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.55 }}>首次加载跟随系统主题，手动切换后将固定主题</div>
            <Flex justify="space-between" align="center" style={{ marginTop: 16 }}>
              <span>低库存阈值</span>
              <Flex gap={8} align="center">
                <InputNumber min={1} value={threshold} onChange={v => setThreshold(v ?? 10)} />
                <Button size="small" onClick={saveThreshold}>保存</Button>
              </Flex>
            </Flex>
          </Card>
        </Col>

        {/* 数据管理 */}
        <Col xs={24} lg={12}>
          <Card size="small" title="数据管理">
            <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 12 }}>备份包含全部数据（含附件图片），恢复将覆盖当前数据</div>
            <Flex vertical gap={8}>
              <Button icon={<CloudDownloadOutlined />} onClick={backupData}>备份数据 (含图片)</Button>
              <input ref={fileRef} type="file" accept=".zip" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) restoreData(f); e.target.value = ''; }} />
              <Button icon={<CloudUploadOutlined />} loading={restoring} onClick={() => fileRef.current?.click()}>恢复数据</Button>
              {isAdmin(user) && (
                <Button danger icon={<DeleteOutlined />} onClick={resetAllData}>清空所有数据</Button>
              )}
            </Flex>
          </Card>
        </Col>

        {/* 仪表板卡片配置 */}
        <Col xs={24} lg={12}>
          <Card size="small" title="仪表板卡片配置"
            extra={<Button size="small" type="primary" onClick={saveDashboardCards}>保存卡片配置</Button>}>
            <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 8 }}>选择要在系统总览中显示的库存卡片</div>
            <Checkbox.Group
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 6, maxHeight: 220, overflowY: 'auto' }}
              value={cards ?? selectedCards}
              onChange={v => setCards(v as string[])}
              options={cardOptions}
            />
          </Card>
        </Col>

        {/* 数据完整性 */}
        <Col xs={24} lg={12}>
          <Card size="small" title="数据完整性"
            extra={<Button size="small" icon={<SafetyCertificateOutlined />} onClick={checkDataIntegrity}>执行检查</Button>}>
            <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 8 }}>检查库存、机器、交易记录的一致性</div>
            {integrityResult === null && <Tag>尚未检查</Tag>}
            {integrityResult !== null && integrityResult.length === 0 && (
              <Alert type="success" showIcon message="数据完整性检查通过，未发现问题" />
            )}
            {integrityResult !== null && integrityResult.length > 0 && (
              <Alert type="warning" showIcon message={`发现 ${integrityResult.length} 个问题`}
                description={
                  <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                    {integrityResult.map((i, idx) => (
                      <div key={idx} style={{ fontSize: 12, padding: '2px 0' }}>
                        {i.type === 'error' ? '❌' : '⚠️'} {i.msg}
                      </div>
                    ))}
                  </div>
                } />
            )}
          </Card>
        </Col>

        {/* 关于 */}
        <Col xs={24}>
          <Card size="small" title="关于">
            <div style={{ fontWeight: 600 }}>手套管理系统 v3.9</div>
            <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7, lineHeight: 1.8 }}>
              <strong>v3.9 (2026-06-04)：</strong>桌面端全面升级为 React + Ant Design 架构，
              数据实时同步（SSE）、精细权限控制、售后全流程管理。<br />
              <strong>v3.7：</strong>修复库存计算公式、SN码照片上传、批量发货、仪表盘卡片配置、审计日志中文化。
            </div>
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
}
