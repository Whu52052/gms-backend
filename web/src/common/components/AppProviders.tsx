// 全局 Provider：QueryClient + AntD 主题（深浅色）+ 中文语言环境
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider, theme as antTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { queryClient } from '../query';
import { useUIStore } from '../stores/ui';
import { GlobalOverlays } from './GlobalOverlays';

dayjs.locale('zh-cn');

// 视觉语言对齐 css/status-pages.css（sn-status.html）：
// 黑白中性主色 / Inter 字体 / #e5e5e5 细边框 / #f5f5f7 底 / 圆角 8-12
const FONT_SANS = "'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";
const FONT_MONO = "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const theme = useUIStore(s => s.theme);
  const dark = theme === 'dark';
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: dark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
          token: {
            // 黑白中性主色（浅色黑按钮 / 深色白按钮，同 sn-status 的 .btn-primary）
            colorPrimary: dark ? '#fafafa' : '#0a0a0a',
            colorInfo: dark ? '#fafafa' : '#0a0a0a',
            colorTextBase: dark ? undefined : '#0a0a0a',
            colorBgLayout: dark ? undefined : '#f5f5f7',
            colorBgContainer: dark ? undefined : '#ffffff',
            colorBorder: dark ? undefined : '#e5e5e5',
            colorBorderSecondary: dark ? undefined : '#f1f3f5',
            colorError: '#be123c',
            colorSuccess: '#047857',
            colorWarning: '#92400e',
            borderRadius: 8,
            borderRadiusLG: 12,
            fontFamily: FONT_SANS,
            fontFamilyCode: FONT_MONO,
            controlHeight: 40,
          },
          components: {
            Card: { borderRadiusLG: 12, colorBorderSecondary: dark ? undefined : '#e5e5e5' },
            Button: { fontWeight: 600, defaultBorderColor: dark ? undefined : '#e5e5e5', defaultColor: dark ? undefined : '#525252' },
            Input: { activeBorderColor: dark ? undefined : '#0a0a0a', hoverBorderColor: dark ? undefined : '#d4d4d4' },
            Select: { optionSelectedBg: dark ? undefined : '#f1f3f5' },
            Menu: {
              itemBorderRadius: 8,
              itemSelectedBg: dark ? undefined : '#f1f3f5',
              itemSelectedColor: dark ? undefined : '#0a0a0a',
              itemHoverBg: dark ? undefined : '#f8f9fa',
              itemColor: dark ? undefined : '#525252',
              groupTitleColor: dark ? undefined : '#a1a1a1',
              groupTitleFontSize: 11,
            },
            Table: { headerBg: dark ? undefined : '#f8f9fa', headerColor: dark ? undefined : '#a1a1a1', borderColor: dark ? undefined : '#f1f3f5' },
            Tag: { borderRadiusSM: 6 },
            Layout: { siderBg: dark ? undefined : '#ffffff', headerBg: dark ? undefined : '#ffffff', bodyBg: dark ? undefined : '#f5f5f7' },
          },
        }}
      >
        <AntApp>
          {children}
          <GlobalOverlays />
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
